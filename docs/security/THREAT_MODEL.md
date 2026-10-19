# FlashStack Threat Model

**Owner:** Security & Contract Lead · **Evidence date:** 2026-10-15 · **Repo:** `83d08de` · **Bead:** `Flashstack-ajv.1.5`

This document lists the realistic ways FlashStack can lose funds or control, and what stops each one.
Every row names: the attacker, the entry point, the state change, the funds moved, the invariant
at stake, the defense, and the test. It builds on the documents below and does not re-derive them:

- [FLASH_LOAN_INVARIANT.md](FLASH_LOAN_INVARIANT.md): the solvency invariant (`B_after >= B_before + fee`)
- [ADMIN_CUSTODY_MODEL.md](ADMIN_CUSTODY_MODEL.md): who holds which key, and BC1
- [FINDINGS_REGISTER.md](FINDINGS_REGISTER.md): F-1 to F-12, BC1, pv3-F1 to pv3-F3
- [POOL_V3_AUDIT_COUNTER_REVIEW.md](POOL_V3_AUDIT_COUNTER_REVIEW.md): CR-1 to CR-7
- [RECEIVER_VETTING.md](RECEIVER_VETTING.md): the checklist a receiver must pass before approval

## Labels

| Label | Meaning |
|---|---|
| **CONFIRMED** | The threat is real in the code that exists today, and is shown by a test or an on-chain read. |
| **POSSIBLE-REQUIRES-REVIEW** | Plausible from reading the code, but not yet proven or ruled out. Each one has a follow-up bead. |
| **MITIGATED** | A defense stops the threat. The defending code and the test that fails without it are both cited. |
| **FIXED** | Was CONFIRMED, and is now fixed in the repository. Code and test cited. |
| **UNVERIFIED** | Depends on something this review has not checked. Stated so it isn't mistaken for safe. |

No finding here is new. Rows that would be new are POSSIBLE or UNVERIFIED.

## Scope

**Live on mainnet:**
- `flashstack-stx-core` and `flashstack-sbtc-core` (published by `SP20XD46…`)
- `flashstack-stx-pool-v2`, `flashstack-sbtc-pool-v2` and `flashstack-pool-oracle-v2` (`SPR9PQAN…`)
- The v1 pools (`flashstack-stx-pool`, `flashstack-sbtc-pool`), which are paused, appear only where they matter (first-depositor inflation and pause).

**Undeployed successors:** `flashstack-pool-v3`, `flashstack-stx-pool-v3`, `flashstack-sbtc-pool-v3`,
`flashstack-stx-core-v2`, `flashstack-sbtc-core-v2`.

**Out of scope:**
- The gen-1 `flashstack-core`, which is a flash-mint design with a different invariant (see CR-4).
- Individual receivers, except where a receiver's weakness puts the protocol at risk (F-10).

**Admin of record:** on 2026-10-15, `get-admin` returned `SPR9PQANV6XHSDNRAX2GNKCA5Z1KH61961KE0BYG` on both cores.

Line numbers refer to `83d08de`.

## Summary

| # | Category | Contracts | Threat | Label |
|---|---|---|---|---|
| 1 | Malicious receiver | all cores and pools | Borrow and keep the funds, or repay short | **MITIGATED** |
| 2 | Callback manipulation | receivers approved on the live cores | Call a receiver's callback directly and redirect its repayment (F-10) | **MITIGATED** |
| 3 | Reentrancy | live v2 pools | Repay a loan with the pool's own `deposit` and mint cheap shares (F-9) | **CONFIRMED** |
| 4 | Reentrancy | stx/sbtc-pool-v3, pool-v3 | Same vector on the successors | **FIXED** |
| 5 | Reentrancy | live cores | Re-enter `deposit-reserve` from the callback | **MITIGATED** |
| 6 | Accounting manipulation | pool-v3 | A donation or over-repayment moves the cached share price and inflates `total-fees` (CR-3, CR-6) | **CONFIRMED** |
| 7 | First-depositor inflation | v1 pools | A tiny first deposit plus a donation steals the next deposit (F-1, F-6) | **CONFIRMED** |
| 8 | First-depositor inflation | v2 pools and all successors | Same attack | **FIXED** |
| 9 | Decimal mismatch | pool-v3 | Share math overflows above 8 decimals and locks LPs in (CR-1) | **CONFIRMED** (fix pending merge, #121) |
| 10 | Decimal mismatch | pool-v3 | One flat share scale for every asset (pv3-F2) | **FIXED** |
| 11 | Oracle manipulation | oracle-v2 | Push or set a false price | **MITIGATED** |
| 12 | Oracle resolution and staleness | oracle-v2, sbtc-pool-v2 | The share price has no usable resolution and reads 0 mid-loan (F-11, F-12) | **CONFIRMED** |
| 13 | Malicious asset | pool-v3 | Deposit or borrow an asset that was never listed | **MITIGATED** |
| 14 | Unexpected token behavior | pool-v3 | A listed fee-on-transfer, rebasing or mutable-decimals token | **POSSIBLE-REQUIRES-REVIEW** |
| 15 | Unexpected token behavior | sbtc-core, sbtc-pool-v2 | Canonical sBTC behaves as a plain SIP-010 | **UNVERIFIED** |
| 16 | Multi-asset accounting | pool-v3 | One asset's activity moves another asset's shares or reserve | **MITIGATED** |
| 17 | Multi-asset accounting | pool-v3 | The receiver allowlist has no asset dimension (CR-2) | **CONFIRMED** |
| 18 | Unauthorized admin | all cores and pools | A non-admin calls an admin function | **MITIGATED** |
| 19 | Pause abuse | all pools | The admin pauses to trap LPs | **MITIGATED** |
| 20 | Pause gap | live v1 and v2 pools | Pause doesn't stop deposits (F-6, F-8) | **CONFIRMED** |
| 21 | Pause gap | stx/sbtc-pool-v3, pool-v3 | Same gap on the successors | **FIXED** |
| 22 | Admin-transfer failure | live cores and v2 pools | A one-step transfer to a wrong principal bricks governance (BC1) | **CONFIRMED** |
| 23 | Admin-transfer failure | all successors | Same mistake | **FIXED** |
| 24 | External contract failure | all cores and pools | A DEX or token call inside the callback fails | **MITIGATED** |
| 25 | Deployment mistake | repo / mainnet plan | `apply --mainnet` would publish `contracts/test/` copies (ajv.6.6) | **CONFIRMED** |
| 26 | Deployment mistake | repo | A repo copy drifts from the deployed source, so tests prove the wrong contract (F-7) | **FIXED** |
| 27 | Custody | live cores and pools | One admin key, no multisig or timelock | **CONFIRMED** |
| 28 | Custody | gen-2 deployer `SP20XD46…` | What the deployer key still controls | **CONFIRMED** (Low) |

**Counts (28 rows):** 11 CONFIRMED · 1 POSSIBLE-REQUIRES-REVIEW · 9 MITIGATED · 6 FIXED · 1 UNVERIFIED.

---

## 1. Malicious receiver: MITIGATED

- **Attacker:** whoever controls an approved receiver.
- **Entry:** `flash-loan`.
- **State change and funds:** the pool sends `amount` to the receiver, and the receiver tries to keep it or repay less than `amount + fee`.
- **Invariant:** solvency.
- **Defense:** the pool measures its own balance after the callback and reverts unless it grew by at least the fee:
  - `flashstack-stx-core.clar:146`, `flashstack-sbtc-core.clar:83`
  - `flashstack-stx-pool-v2.clar:164`, `flashstack-sbtc-pool-v2.clar:158`
  - `flashstack-stx-core-v2.clar:173`, `flashstack-sbtc-core-v2.clar:91`
  - `flashstack-stx-pool-v3.clar:202`, `flashstack-sbtc-pool-v3.clar:197`, `flashstack-pool-v3.clar:387`

  A second layer is the approved-receiver gate, for example `flashstack-stx-core.clar:133`.
- **Tests:**
  - `flashstack-stx-core-reserve.test.ts`: "repay-or-revert: a receiver that keeps the funds reverts, and the reserve is untouched"
  - `flashstack-sbtc-core-reserve.test.ts`: "repay-or-revert: a receiver that keeps the sBTC reverts, and the reserve is untouched"
  - `flashstack-pool-v3.test.ts`: "a receiver that never repays reverts the whole transaction"
  - `stx-core-v2-underpay.test.ts`: "repaying 1 uSTX short reverts with ERR-REPAY-FAILED and leaves the reserve untouched"

  FLASH_LOAN_INVARIANT §5 records the mutation check. Its line numbers predate later edits; the ones above are current.

## 2. Callback manipulation: MITIGATED

- **Attacker:** anyone.
- **Entry:** a receiver's own `execute-*-flash`, called directly rather than through the core.
- **State change and funds:**
  - A receiver with no caller gate repays to whatever `core` argument the caller passes, so a direct call drains the receiver's own balance (F-10).
  - A related case is a stranger starting a loan that makes the receiver pay a fee from its buffer (the #98 checks).
- **Invariant:** a receiver's funds move only on a loan its owner set up.
- **Defense:**
  - All 13 receivers ever approved on either core were de-approved, and FlashStack-held balances were rescued (F-10).
  - New receivers must pass RECEIVER_VETTING §B and §C. The reference implementation checks `contract-caller` against a hardcoded core first (`hk-sbtc-real-receiver-v2.clar:78-79`), and repays to that same constant (`:116`).
- **Tests:** in `hk-sbtc-real-receiver-v2.test.ts`:
  - "rejects a direct call to execute-sbtc-flash, even with the real core as argument"
  - "a stranger's loan with nothing armed is rejected"
  - "a loan for a different amount than armed is rejected"
- **Residual:** the cores can't enforce any of this. Safety depends on the vetting step before every `add-approved-receiver`.

## 3. Reentrancy, live v2 pools: CONFIRMED

- **Attacker:** an approved receiver.
- **Entry:** `flash-loan`, then a call to the pool's own `deposit` inside the callback.
- **State change:** the repayment lands through `deposit`, so the solvency check passes, but the receiver is also minted shares, priced while the pool's balance is depressed by the outstanding loan.
- **Funds:** existing LPs are diluted. The proof shows a 99% loss for one LP, from fee-sized attacker capital (F-9).
- **Invariant:** LP fairness. Solvency holds throughout (FLASH_LOAN_INVARIANT §6, item 3).
- **Defense:** none in the contract. It is dormant because no receiver has ever been approved on either v2 pool, and both pools were paused on 2026-10-01, which blocks `flash-loan`.
- **Tests:**
  - `stx-pool-v2-deposit-reentrancy.test.ts`: "the receiver contract ends up owning a share of the pool, funded by the loan itself -- not the attacker's wallet"
  - The sBTC equivalent in `sbtc-pool-v2-deposit-reentrancy.test.ts`
- **Follow-up:** `Flashstack-ajv.4.8` (LP migration) and `Flashstack-ajv.4.4` (disposition). Never call `add-approved-receiver` on either v2 pool.

## 4. Reentrancy, successors: FIXED

- **Defense:**
  - `flashstack-stx-pool-v3` and `flashstack-sbtc-pool-v3` share one `reentrancy-locked` flag across `deposit`, `withdraw` and `flash-loan`: stx `:117`, `:152`, `:186`; sbtc `:109`, `:140`, `:175`.
  - `flashstack-pool-v3` locks per asset: `:277`, `:331`, `:365`.
- **Tests:**
  - `v3-pools-reentrancy-lock.test.ts`: "flash-loan -> callback -> deposit (the F-9 vector) is rejected with ERR-REENTRANT"
  - `v3-pools-reentrancy-lock.test.ts`: "lock is released after an under-repay revert (fails after the callback returns ok)"
  - `pool-v3-hillary-review.test.ts`: "a reentrant deposit for the SAME asset is blocked (ERR-REENTRANT), not silently mis-accounted"
- A nested `flash-loan` on the same pool is aborted by the Clarity VM (`CircularReference`), not by the lock. This is pinned in the same file.

## 5. Reentrancy, live cores: MITIGATED

- **Entry:** `deposit-reserve` called from inside the callback.
- **Defense:** `deposit-reserve` is admin-gated (`flashstack-stx-core.clar:55`, `flashstack-sbtc-core.clar:99`). Inside a callback, `tx-sender` is the borrower, never the admin.
- **Test:** `flashstack-stx-core-reserve.test.ts`: "deposit-reserve credits the reserve; non-admin is rejected" (the sBTC file has the same test).

## 6. Accounting manipulation: CONFIRMED (Informational)

- **Attacker:** anyone willing to donate.
- **Entry:** a direct transfer to `flashstack-pool-v3`, followed by any call that refreshes the cached reserve, or an over-repaid loan.
- **State change:** the cached `reserve` and the share price jump (CR-3), and `total-fees` counts the surplus as fees (CR-6, `:392`).
- **Funds:** the donor loses the donation, spread across all LPs. It isn't profitable on its own.
- **Invariant:** the share price as a manipulation-resistant collateral value.
- **Defense:** none needed for LPs. Integrators must not treat `get-share-price` as manipulation-resistant.
- **Test:** none. This was found by reading the code.
- **Follow-up:** `Flashstack-vwh.5` (Zest LP-as-collateral) must account for it. F-5 makes the same point about the stats counters on the live contracts.

## 7. First-depositor inflation, v1 pools: CONFIRMED

- **Attacker:** the first depositor.
- **Entry:** a tiny `deposit`, then a direct donation.
- **State change and funds:** the next depositor's shares round down, and the attacker recovers the donation along with the victim's deposit.
- **Defense:** none. The v1 pools are immutable, and their pause doesn't stop deposits (row 20).
- **Tests:**
  - `flashstack-stx-pool-v2-hardening.test.ts`: "contrast: the deployed v1 pool lets the attacker recover the donation (the vulnerability being fixed)"
  - `pause-does-not-gate-deposit.test.ts`: "v1: a first deposit while paused gets the naive pre-F-1 share math"
- **Follow-up:** `Flashstack-ajv.4.4`.

## 8. First-depositor inflation, v2 and successors: FIXED

- **Defense:** virtual shares and assets:
  - `flashstack-stx-pool-v2.clar:70-71,93`, `flashstack-sbtc-pool-v2.clar:68-69,85`
  - the v3 pools carry the same constants
  - `flashstack-pool-v3.clar:274` uses a per-asset `share-scale`
- **Tests:**
  - `flashstack-stx-pool-v2-hardening.test.ts`: "v2 defuses the inflation attack: victim protected, attacker cannot recover the donation"
  - `flashstack-pool-v3.test.ts`: "a tiny first deposit + a direct donation does not let the attacker steal from the victim"

## 9. Decimal mismatch, overflow: CONFIRMED (fix pending merge)

- **Attacker:** none needed. It's triggered by an admin listing a token with more than 8 decimals.
- **Entry:** `add-asset`, then `deposit`.
- **State change:** `share-scale = 10^decimals` makes `withdraw`, `deposit` and `get-lp-value` overflow uint128 at small balances. LPs can only exit in tiny pieces (CR-1).
- **Defense today:** `MAX-DECIMALS u24` (`flashstack-pool-v3.clar:95`) is too high.
- **Fix:** PR #121 lowers it to `u8` and turns the CR-1 tests into rejection tests at 9, 12, 18 and 24 decimals. Matt approved the change on 2026-10-15. Relabel this row FIXED once #121 merges.
- **Test:** `pool-v3-counter-review.test.ts`, CR-1 block.
- **Follow-up:** `Flashstack-ajv.3.3`.

## 10. Decimal mismatch, flat scale: FIXED

- **Defense:** `add-asset` reads `get-decimals()` live and stores `share-scale` (`flashstack-pool-v3.clar:192,202`).
- **Test:** `pool-v3-hillary-review.test.ts`: "sBTC (8 decimals) gets share-scale 1e8; USDCx (6 decimals) gets 1e6"

## 11. Oracle manipulation: MITIGATED

- **Attacker:** anyone.
- **Entry:** any oracle setter or push feed.
- **Defense:** `flashstack-pool-oracle-v2` has no public functions. It is a read-only view over a pool address hardcoded in its source (`flashstack-pool-oracle-v2.clar:48-56`). There is nothing to set.
- **Test:** `flashstack-pool-oracle-v2.test.ts`: "oracle lp-value equals the pool's own get-stx-value (no drift)"
- **Residual:** the oracle is only as honest as the pool's share accounting (rows 3, 6 and 12).

## 12. Oracle resolution and staleness: CONFIRMED (Low, latent)

- **Attacker:** none. This is a consumer-side hazard.
- **Entry:** `get-share-price` and `get-collateral-snapshot` on oracle-v2, and the same functions built into `flashstack-sbtc-pool-v2`.
- **State change:** none. The read returns `1` across any gain short of +100%, and `0` when called from inside a flash-loan callback (F-11, F-12). The value is never stale, because it is computed from the live pool balance on every read.
- **Funds:** none today, because nothing reads these functions. A lending integration that did could misprice collateral.
- **Defense:** documentation. Integrators must use `get-lp-value` and must never read inside a loan.
- **Tests:**
  - `flashstack-pool-oracle-v2.test.ts`: "F-11: share-price stays 1 through a +99% value gain and only steps at 2x"
  - `flashstack-pool-oracle-v2.test.ts`: "F-11/F-12: read inside a flash-loan callback, share-price is 0 and lp-value drops by the loan"
  - The sbtc-pool-v2 test is in PR #123.
- **Follow-up:** `Flashstack-ajv.3.4`. The undeployed `flashstack-sbtc-pool-v3` has the same expression.

## 13. Malicious asset: MITIGATED

- **Attacker:** a token author.
- **Entry:** `deposit` or `flash-loan` on `flashstack-pool-v3` with an arbitrary SIP-010 token.
- **Defense:** only listed assets are accepted. `add-asset` is admin-only (`flashstack-pool-v3.clar:195`), and `deposit` and `flash-loan` reject an unlisted asset (`ERR-NOT-LISTED`).
  - Outflows use `as-contract?` with a `with-ft` allowance scoped to the one token (`:339`, `:377`). A hostile token can't spend the pool's other assets.
  - The single-asset contracts hardcode their asset.
- **Test:** `flashstack-pool-v3.test.ts`: "deposit/flash-loan on an UNLISTED token is rejected -- even a malicious one"
- **Residual:** a listed token is trusted, including its `get-balance` (FLASH_LOAN_INVARIANT §6, item 1). See row 14.

## 14. Unexpected token behavior, pool-v3: POSSIBLE-REQUIRES-REVIEW

- **Attacker:** a listed token whose transfer delivers less than `amount`, whose balance changes by itself (rebasing), or whose `get-decimals()` can change.
- **Entry:** `deposit` on `flashstack-pool-v3`.
- **State change:**
  - `deposit` mints shares on `amount` (`:274`) and caches the reserve as `pool-balance + amount` (`:306`), before the transfer at `:307`.
  - If the token charges a fee on transfer, the pool receives less than `amount`. The depositor then holds more shares than they paid for, which dilutes the other LPs. The cached reserve also overstates the real balance until the next refresh.
  - Re-listing a token whose decimals have changed re-prices existing shares (CR-5).
- **Funds:** a small dilution of other LPs on each deposit.
- **Invariant:** LP fairness. Solvency is unaffected because it is measured.
- **Defense:** only the admin allowlist. No listing policy is written down, and nothing tests this.
- **Follow-up (new bead):** write the pool-v3 listing policy (no fee-on-transfer, rebasing or mutable-decimals tokens; at most 8 decimals). Add a fee-on-transfer test token to pin the behaviour.

## 15. Unexpected token behavior, canonical sBTC: UNVERIFIED

- `flashstack-sbtc-core` and `flashstack-sbtc-pool-v2` call the canonical `SM3VDXK3…sbtc-token` for `transfer` and `get-balance`. The solvency measurement trusts that `get-balance`.
- The test suite runs against a local mock (`contracts/sbtc-token.clar`), not the canonical token.
- This review has not read the canonical token's source to confirm it has no transfer hooks or protocol-controlled balance changes that could move a balance mid-loan.
- **Next step:** read the deployed source once before the audit. It's a single read, not a finding.

## 16. Multi-asset isolation: MITIGATED

- **Defense:** `flashstack-pool-v3` keys `lp-shares` and `total-shares` per asset, measures each asset's own live balance in its own invariant (`:359`, `:386-387`), and locks per asset (`:365`).
- **Test:** `flashstack-pool-v3.test.ts`: "deposits in two different assets never affect each other's shares/reserve"

## 17. Multi-asset allowlist: CONFIRMED (Low)

- **Attacker:** anyone.
- **Entry:** `flash-loan` on `flashstack-pool-v3`, naming an approved receiver with an asset that receiver was never set up for.
- **State change and funds:** if the receiver pays the fee from a buffer, each such loan moves one fee from the receiver to the LPs (CR-2). The pool stays solvent.
- **Defense:** none in the contract (`approved-receivers` is `principal -> bool`, `:151`). The receiver has to protect itself with an armed, amount-bound loan (RECEIVER_VETTING §C).
- **Test:** `pool-v3-counter-review.test.ts`: "a stranger can make an approved receiver pay fees in an asset it was never set up for"
- **Open question for Matt** (counter-review §4, question 2): key approvals by `{receiver, asset}`, or make §C mandatory for every pool-v3 receiver.

## 18. Unauthorized admin: MITIGATED

- **Defense:** every admin function asserts `tx-sender == admin`, for example `flashstack-stx-core.clar:73` (`add-approved-receiver`), `:110` (`transfer-admin`), and `flashstack-pool-v3.clar:195` (`add-asset`).
  - LP `withdraw` is not admin-gated, so the admin cannot seize LP deposits (ADMIN_CUSTODY_MODEL §2).
  - The admin can withdraw the core reserve. That is by design.
- **Tests:**
  - `flashstack-stx-core-reserve.test.ts`: "only the admin can whitelist a receiver"
  - `flashstack-pool-v3.test.ts`: "only admin can add-asset / set-paused"

## 19. Pause abuse: MITIGATED

- **Attacker:** the admin, or whoever holds the admin key.
- **Entry:** `set-paused`.
- **State change:** loans stop.
- **Defense:** `withdraw` is never gated by pause on any pool. Live: `flashstack-stx-pool-v2.clar:111` asserts only on shares. Successors: `flashstack-stx-pool-v3.clar:140` and `flashstack-pool-v3.clar:313`. LPs can always exit.
- **Tests:**
  - `pause-does-not-gate-deposit.test.ts`: "withdraw SUCCEEDS while paused (LPs can always exit)"
  - `v3-pools-pause-gate.test.ts`: "withdraw is NOT blocked by pause: an LP can always exit"
  - `pool-v3-hillary-review.test.ts`: "withdraw is NOT blocked by pause -- LPs can always exit (unchanged, intentional)"

## 20. Pause gap, live pools: CONFIRMED (Low)

- **Attacker:** none. The risk is a depositor misled by "paused".
- **Entry:** `deposit` on a paused v1 or v2 pool.
- **State change and funds:** the deposit succeeds and mints shares. In v1 that uses the pre-F-1 share math (row 7), and in v2 it goes into a pool still exposed to F-9.
- **Defense:** none in the contract (`flashstack-stx-pool-v2.clar:84` asserts only `amount > 0`). The web app reads and shows each pool's on-chain status (#120).
- **Test:** `pause-does-not-gate-deposit.test.ts`: "deposit SUCCEEDS while paused and mints shares"

## 21. Pause gap, successors: FIXED

- **Defense:** `deposit` asserts pause: `flashstack-stx-pool-v3.clar:121`, `flashstack-sbtc-pool-v3.clar:113`, and `flashstack-pool-v3.clar:282-283` (global and per asset).
- **Tests:**
  - `v3-pools-pause-gate.test.ts`: "deposit is REJECTED while paused, with ERR-PAUSED, and mints no shares"
  - `pool-v3-hillary-review.test.ts`: "global pause blocks new deposits"

## 22. Admin-transfer failure, live: CONFIRMED (Medium, operator footgun)

- **Attacker:** none. The risk is an operator mistake.
- **Entry:** `transfer-admin` (`set-admin` on sbtc-core) on the two cores and two v2 pools.
- **State change:** the new admin is written immediately (`flashstack-stx-core.clar:108-112`). A wrong or uncontrolled principal permanently locks pause, fee, cap and the receiver allowlist (BC1).
- **Funds:** none move, but the reserve can never be withdrawn again.
- **Defense:** procedural only (ADMIN_CUSTODY_MODEL §3). Before the call, prove the target principal is controlled by sending a transaction from it, and have a second person check the address.
- **This applies now.** The planned move of admin to a hardware wallet (2026-10-15) is exactly this call, on four live contracts. Prove control of the hardware-wallet address first.
- **Tests:**
  - `bc1-admin-lockout.test.ts`: "transfer-admin to an uncontrolled principal bricks every admin function"
  - `mainnet-fidelity.test.ts`: "flashstack-stx-core: transfer-admin takes effect IMMEDIATELY, as deployed"

## 23. Admin-transfer failure, successors: FIXED

- **Defense:** propose, then accept:
  - `flashstack-stx-core-v2.clar:120,128`
  - `flashstack-sbtc-core-v2.clar:166,175`
  - `flashstack-stx-pool-v3.clar:261,270`
  - `flashstack-sbtc-pool-v3.clar:252,261`
  - `flashstack-pool-v3.clar:158,168`
- **Tests:**
  - `bc1-two-step-fix.test.ts`: "${name}: a bad proposal never locks out, and admin is recoverable", and "${name}: a non-pending principal cannot accept"
  - `mainnet-fidelity.test.ts`: "flashstack-stx-core-v2: the successor DOES have the two-step fix"

## 24. External contract failure: MITIGATED

- **Attacker:** none. A DEX, pool or token the receiver calls fails, or returns less than expected.
- **Entry:** any call the receiver makes inside its callback.
- **Defense:**
  - Any failure either makes the callback return an error or leaves the pool short. Both revert the whole transaction, including the outbound loan (FLASH_LOAN_INVARIANT §3).
  - `flashstack-pool-v3` also turns a failed `get-balance` read into `ERR-BALANCE-READ-FAILED` (`:359`, `:386`) rather than assuming a value.
- **Tests:**
  - The repay-or-revert tests in row 1
  - `v3-pools-reentrancy-lock.test.ts`: "lock is released after an under-repay revert (fails after the callback returns ok)"
- **Related receiver-level case (not the protocol):** a receiver hardcoded to the wrong DEX pool simply fails every loan (`Flashstack-ajv.4.10`).

## 25. Deployment mistake, mainnet plan: CONFIRMED

- **Attacker:** none. The risk is an operator running `clarinet deployments apply --mainnet` from this repo.
- **State change:** the generated plan publishes the `contracts/test/` copies, which are bound to the mock sBTC, alongside the real contracts (`Flashstack-ajv.6.6`).
- **Defense:**
  - A written rule: never `apply --mainnet` from this repo (`deployments/README.md`).
  - Matt confirmed on 2026-10-15 that `settings/Mainnet.toml` holds no mnemonic on his machine, so a mistaken apply fails for lack of a signer.
  - A CI guard pins the known set of test paths, so any new one fails the build.
- **Test:** `mainnet-plan-guard.test.ts`: "publishes no contracts/test/ file beyond the known set" (CI only).
- **Follow-up:** `Flashstack-ajv.6.6`. The structural fix (a separate simnet manifest) is still open.

## 26. Deployment mistake, repo drift: FIXED

- **State change it prevents:** tests proving behaviour that the deployed contract doesn't have (F-7).
- **Defense:**
  - Verbatim pins of deployed sources (`tests/deployed-source-pins.test.ts:63`)
  - Fidelity checks on the localized copies (`tests/mainnet-fidelity.test.ts:43`)
  - A drift check between each canonical file and its simnet copy (`tests/canonical-copy-drift.test.ts:64`)
- **Tests:**
  - `deployed-source-pins.test.ts`: "${file} still matches the source deployed at ${principal}"
  - `canonical-copy-drift.test.ts`: "${file}: differs from contracts/${file} by address localization only"

## 27. Custody, single admin key: CONFIRMED (design risk)

- **Attacker:** anyone who obtains the admin key.
- **Entry:** any admin function.
- **State change and funds:** withdraw the core reserves, approve a hostile receiver, change fees, or pause. LP deposits in the pools can't be seized (row 18).
- **Defense:** none on chain. There is no multisig and no timelock, and pause authority isn't separated from fund authority (ADMIN_CUSTODY_MODEL §1).
- **Status:** migration of the admin key to a hardware wallet started on 2026-10-15. That reduces theft risk; it doesn't add a second signer.
- **Test:** none. This is an operational property.
- **Follow-up:** open question for Matt on multisig and timelock before LP deposits open (ADMIN_CUSTODY_MODEL §4).

## 28. Custody, gen-2 deployer key: CONFIRMED (Low)

ADMIN_CUSTODY_MODEL §1 says the deployer `SP20XD46…` controls nothing. That is true for the cores and pools; on 2026-10-15 `get-admin` returned `SPR9PQAN…` on both cores. It is not true everywhere. The deployer's address is the fixed owner constant on:

- The legacy receivers it published (owner-only rescue functions, for example `bitflow-arb-receiver.clar:121`). On 2026-10-15 these hold 0, apart from dust in the two test receivers.
- `flashstack-yield-vault-v4`, whose `rescue-stx` is gated to the deployer. Its source isn't in this repo, so this was read from chain. Its whole balance is the operator's own deposit.

Exposure if the key leaked: the dust, plus that one deposit. Nothing belonging to another user. No redeploy is needed. Rescue or withdraw what's there, then retire the key.

- **Test:** none. This was established by on-chain balance and source reads.

---

## Follow-up beads

| Row | Bead |
|---|---|
| 14 | **New:** write the pool-v3 listing policy and add a fee-on-transfer test token |
| 15 | **New (small):** read the canonical sBTC token's source before the audit |
| 3, 7 | `Flashstack-ajv.4.8`, `Flashstack-ajv.4.4` |
| 9 | `Flashstack-ajv.3.3` (PR #121) |
| 12 | `Flashstack-ajv.3.4`, PR #123 |
| 25 | `Flashstack-ajv.6.6` |
| 6 | `Flashstack-vwh.5` |
