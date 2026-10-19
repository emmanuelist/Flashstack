# Canonical sBTC vs the simnet mock

Tracked in `Flashstack-ajv.5.2`, and the threat model's UNVERIFIED row 15 points here. The sBTC core and pools check solvency by comparing balances before and after each loan. They trust the token's `get-balance` and `transfer`, but most sBTC tests run against the local mock `contracts/sbtc-token.clar`. This page compares the two.

- **Canonical:** `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token` (158 lines). The source was fetched from Hiro on 2026-10-16, together with `sbtc-registry` and `sbtc-withdrawal`, the contracts that hold its protocol roles.
- **Mock:** `contracts/sbtc-token.clar` at `aa9b9fc`.

**Verdict:** no finding that lets anyone take funds from a FlashStack contract. The mock has three differences from the real token. None of them hides a solvency bug, but one of them, the locked balance, is an untested assumption worth pinning.

## Semantics

| Question | Canonical | Mock | Matters? |
|---|---|---|---|
| What `get-balance` returns | **Available + locked**: `ft-get-balance sbtc-token` + `ft-get-balance sbtc-token-locked` (`:140-142`). `get-balance-available` (`:144-146`) and `get-balance-locked` (`:148-150`) return each part separately | One token, available only (`:41-43`). No locked balance exists | See [Locked balance](#locked-balance) |
| Who can call `transfer` | `tx-sender == sender` **or** `contract-caller == sender` (`:121`) | `tx-sender == sender` only (`:21`) | Canonical is looser. See [Transfer auth](#transfer-auth) |
| Zero-amount `transfer` | `ft-transfer?` returns `(err u3)` (`:122`) | Asserts first and returns `(err u402)` (`:22`) | Only the error code differs. No FlashStack contract makes a zero transfer, since loans and deposits reject 0 before calling the token |
| Transfer as a contract inside `as-contract` | Works. `tx-sender` becomes the contract, so the `tx-sender` branch passes | Works, same reason | No |
| Fee on transfer | None. The plain `ft-transfer?` moves exactly `amount` (`:122`) | None (`:23`) | No |
| Pause or freeze switch | None. The token has no pause and `transfer` can't be blocked | None | No (but see protocol authority below) |
| Mint, burn, lock authority | `protocol-mint` / `-burn` / `-lock` / `-unlock` / `-burn-locked` / `-mint-many` (`:14-81`), gated by `sbtc-registry.is-protocol-caller` (`registry:361-366`). The registry's governance role (`sbtc-bootstrap-signers`, the signer set) can reassign those roles (`update-protocol-contract`, `registry:327-337`) | `mint` / `burn` gated by `contract-caller == flash-minter`, which the deployer sets (`:55-82`) | A trust assumption. See below |
| Upgradability | The token contract itself is immutable. Behaviour around it can change, because governance can swap the protocol contracts | Immutable | A trust assumption |
| Decimals | `u8` (`:10`) | `u8` (`:37-39`) | No |

## Consequences for the FlashStack contracts

These contracts are covered:
- `flashstack-sbtc-core` (live)
- `flashstack-sbtc-pool-v2` (live, paused)
- `flashstack-sbtc-pool-v3` and `flashstack-sbtc-core-v2` (undeployed)
- `flashstack-pool-v3` (undeployed, generic SIP-010)

### Locked balance

Canonical `get-balance` counts locked sBTC. Locked sBTC is part of a pending BTC withdrawal and can't be transferred. A contract whose balance check ran on `get-balance` could therefore count sBTC it can't actually spend. That would let a loan "repay" with locked tokens, or let a pool pay LPs out of a balance it can't fully transfer.

**Can anyone give a FlashStack contract a locked balance?** Not without the protocol roles:
- The only public way in is `sbtc-withdrawal.initiate-withdrawal-request`. It locks **`tx-sender`'s own** sBTC (`withdrawal:130-135`, `protocol-lock … tx-sender`).
- During a loan callback, `tx-sender` is the borrower's wallet, not the core or pool. Every sBTC lender calls the receiver **outside** `as-contract`; `(as-contract tx-sender)` appears only as the principal argument:
  - `flashstack-sbtc-core.clar:77`
  - `flashstack-sbtc-core-v2.clar:85`
  - `flashstack-sbtc-pool-v2.clar:151`
  - `flashstack-sbtc-pool-v3.clar:190`
  - `flashstack-pool-v3.clar:382`
- So a receiver can't make a lender the `tx-sender` of a withdrawal request, and it can't lock the lender's sBTC.
- A receiver also can't repay with a locked balance. `protocol-lock` with `owner = core` requires the withdrawal role, and it locks tokens the core already holds rather than adding new ones.
- The lenders never call `sbtc-withdrawal` themselves.

Live reads (2026-10-16):

| Contract | `get-balance-locked` | `get-balance-available` |
|---|---|---|
| `flashstack-sbtc-core` | `u0` | `u15011` |
| `flashstack-sbtc-pool-v2` | `u0` | `u44990` |

**Consequence:** today, `get-balance` equals the available balance for every FlashStack contract, so the before/after balance checks are sound. This rests on one invariant: **no FlashStack lender may call the receiver, or anything else, inside `as-contract` / `as-contract?`.** Any future change that does so should switch the solvency reads to `get-balance-available`.

### Transfer auth

Canonical `transfer` also accepts `contract-caller == sender` (`:121`), which the mock doesn't (`:21`).
- **Effect on the lenders:** none. A lender's sBTC moves only when the lender itself is `contract-caller`, meaning its own code calls the token directly. No outside contract can be `contract-caller` on the lender's behalf. Every outbound transfer in the lenders is the lender's own `as-contract` call.
- **Effect on receivers:** a receiver that repays with a plain `contract-call?`, without `as-contract`, works on mainnet but fails in simnet against the mock. That's a false failure in tests, not a hidden bug.
- **Effect on findings:** the F-9 sBTC proof says the repayment path "asserts `tx-sender == sender`". On mainnet the check is the looser OR. The attack still works either way (it uses `as-contract`), so F-9's conclusion is unchanged.

### Protocol authority (trust assumption, Info)

The sBTC signer set controls `sbtc-registry`'s governance role. With it, they can point the protocol roles at new contracts, and those contracts could mint, burn, lock or unlock **any** holder's sBTC. That includes every FlashStack lender. This is inherent to sBTC and not specific to FlashStack.

What it would mean for FlashStack:
- A governance-level lock on a pool would leave `get-balance` unchanged but shrink what can be transferred. The last LPs to withdraw would hit a failed `transfer`.
- A burn would shrink the pool for every LP proportionally.

Neither is reachable by anyone outside the signer set. The audit packet should list it as an external dependency.

## Mock gaps (proposed, not written)

1. **Pin the locked-balance invariant.** Simnet already loads the real token through the requirement chain; `tests/hk-sbtc-real-receiver-v2.test.ts` mints real sBTC through `sbtc-deposit` as the registry signer. Add a test where a receiver's callback calls `sbtc-withdrawal.initiate-withdrawal-request` against the real `flashstack-sbtc-core` (by its mainnet principal). Assert that it locks the **borrower's** sBTC, and that `get-balance-locked` for the core stays `u0`.
2. **Add an "outside `as-contract`" guard.** Add a test that fails if any sBTC lender's receiver call (`execute-sbtc-flash` / `execute-flash`) sits inside an `as-contract` form. A simple source check is enough, in the style of `canonical-copy-drift.test.ts`. This pins the invariant above.
3. **Optionally bring the mock closer to the real token:** add the `contract-caller == sender` branch and a `get-balance-available` read. Do this only if a test needs it. Changing the mock's `transfer` auth would shift what the existing sBTC tests prove, so it needs its own review.
