# Counter-review: CLARITY_AUDIT_CORE_AND_V3_POOLS.md

**Owner:** Security & Contract Lead · **Evidence date:** 2026-10-14 · **Repo:** `39dc965`
· **Bead:** `Flashstack-ajv.3.2` · **Reviews:** [`CLARITY_AUDIT_CORE_AND_V3_POOLS.md`](CLARITY_AUDIT_CORE_AND_V3_POOLS.md) (Matt, `e394ac3`, 2026-10-02)

Every claim in that audit was checked again against source, and where a test exists, against the test.
Then the generic pool `flashstack-pool-v3` was reviewed again for anything it, the 2026-08-19 self-review
and the 2026-08-25 independent review (`MULTI_ASSET_CORE_DESIGN.md` §13) missed. Proving tests are in
[`tests/pool-v3-counter-review.test.ts`](../../tests/pool-v3-counter-review.test.ts).

`flashstack-pool-v3` is **not deployed on mainnet**. It is staged on testnet only (#112). Nothing below
affects live funds.

## Summary

- **Audit claims: 7 AGREE, 3 PARTIAL, 2 DISAGREE.** The headline finding (V3-A) was right and has been
  fixed since (#88). The disagreements are the claim that pool-v3 has "nothing new" and the
  function/map counts.
- **New: CR-1 (Medium).** In `flashstack-pool-v3`, share math overflows uint128 for any listed asset
  with more than ~8 decimals, at small balances. LPs then can't withdraw a whole position, new deposits
  abort, and `get-lp-value` aborts. `add-asset` accepts up to 24 decimals. The F2 fix (share-scale =
  10^decimals) is what made the products this large. Not reachable with the assets planned so far
  (sBTC, 8 decimals; USDCx, 6).
- **New: CR-2 (Low).** The receiver allowlist is global, not per asset. A stranger can name any
  approved receiver in any listed asset, and a receiver that pays the fee from its own buffer bleeds that
  buffer to LPs.
- **New, informational:** CR-3 (cached share price can be moved by a donation), CR-4 (the deployed
  gen-1 `flashstack-core` has an admin-only collateral override), CR-5 (relisting resets stats and
  re-reads decimals), CR-6 (`total-fees` counts any surplus), CR-7 (a stale header line).

## 1. The audit's claims, checked

| # | Audit claim | Verdict | Evidence |
|---|---|---|---|
| 1 | **V3-A (Critical):** `flashstack-stx-pool-v3` and `flashstack-sbtc-pool-v3` have no reentrancy lock on `deposit`, so F-9 is present in both successors. | **AGREE** (true at `e394ac3`); **since RESOLVED** | At `678d2fb` neither file had a lock. #88 (`9eef591`, merged 2026-10-06) added `reentrancy-locked`: set first and released before `(ok …)` in `deposit` (`flashstack-stx-pool-v3.clar:117-134`, `flashstack-sbtc-pool-v3.clar:109-124`), `withdraw` (`:152-165`, `:140-151`) and `flash-loan` (`:186-211`, `:175-202`). Error paths revert with the transaction, so the lock can't stick. Proven by `tests/v3-pools-reentrancy-lock.test.ts` ("flash-loan -> callback -> deposit (the F-9 vector) is rejected with ERR-REENTRANT", and the withdraw variant). The audit's table row "Reentrancy lock on deposit: No" is now stale. |
| 2 | V3-A: both headers still claim "Reentrancy-safe: reserve checked after callback returns". | **AGREE** | True at the audit. Still present in `flashstack-stx-pool-v3.clar:36` (see CR-7). |
| 3 | V3-A recommendation: port pool-v3's `asset-locked` pattern; "no reason it wouldn't transplant directly". | **AGREE** | Done in #88 as a single bool. One nuance: a nested flash-loan on the same pool is stopped by the Clarity VM (`CircularReference`), not by the lock. The lock is what stops deposit and withdraw reentry. |
| 4 | V3-B (Low): "not yet deployed" headers to revisit at deploy time. | **AGREE** | Still accurate. Neither pool is deployed. |
| 5 | V3-C (Info): `flashstack-core` `set-admin` is single-step. | **AGREE** | `flashstack-core.clar:242-247`. The deployed source at `SP3TGRVG…flashstack-core` (fetched 2026-10-14) is byte-identical to the repo file. |
| 6 | V3-D (Info): `flashstack-core` admin checks use `contract-caller`. | **AGREE** | `:75`, `:244`, `:251`, `:258` and the other admin functions. |
| 7 | "`flashstack-pool-v3` … this pass found nothing new in it." | **DISAGREE** | CR-1 and CR-2 below, with proving tests. |
| 8 | pool-v3's F1/F2/F3 fixes "re-read and reconfirmed". | **PARTIAL** | All three are present and tested (`tests/pool-v3-hillary-review.test.ts`, F1/F2/F3 blocks). But F2's calibration (`flashstack-pool-v3.clar:202`, `share-scale: (pow u10 decimals)`), combined with `MAX-DECIMALS u24` (`:95`), is the cause of CR-1. |
| 9 | `flashstack-core` C-01/C-02/H-01/L-01/L-02/M-02 fixes present as described. | **PARTIAL** | Spot-checked and present: supply-invariant repayment (C-02, `:125`, `:153`), the 1-sat fee floor (L-01, `:89-91`), the per-block volume cap (M-02, `:110-114`). Missed: the deployed contract still carries `set-test-stx-locked` (CR-4). |
| 10 | Both single-asset v3 pools are the v2 pools plus only BC1 and F-8. | **AGREE** | Comment-stripped diff of `flashstack-{stx,sbtc}-pool-v2.clar` against the `678d2fb` v3 files: 15 changed lines each, all two-step admin plus the one `(asserts! (not (var-get paused)) ERR-PAUSED)` in `deposit`. |
| 11 | Function/map counts in the summary table. | **DISAGREE** (minor) | Counted with `grep -c`. The audit says `flashstack-core` 11/9/2 (public / read-only / maps); it's actually 11/13/3. `flashstack-pool-v3`: 10/11/4 vs actual 11/12/5. At `678d2fb`, `stx-pool-v3`: 9/8/2 vs 10/9/2; `sbtc-pool-v3`: 9/10/2 vs 10/11/2. Neither `flashstack-core` nor `flashstack-pool-v3` changed between 2026-09-09 and the audit, so the counts were off when written. The counts miss `asset-locked` and `test-locked-stx`, both of which matter. |
| 12 | Verdict CONDITIONAL_PASS; pool-v3 risk LOW. | **PARTIAL** | Agree on the conditional pass. pool-v3 is MEDIUM until CR-1 is fixed or its listing policy is written down. |

## 2. New findings

### CR-1 — Medium — share math overflows for high-decimal assets (`flashstack-pool-v3`)

**Where:** `deposit` `:274`, `withdraw` `:326`, `get-lp-value` `:472`; `MAX-DECIMALS u24` at `:95`;
`share-scale = 10^decimals` at `:202`.

**Mechanism.** On an empty pool, the first LP gets `amount × 10^d` shares (`:274`, balance 0, VA 1).
Withdrawing them computes `shares × (balance + 1)`, which is about `a² × 10^d`. Clarity `uint` is 128-bit
(max ≈ 3.4e38) and aborts on overflow. The full position therefore can't be withdrawn in one call once:

| decimals | breaks above (single-LP pool balance) |
|---|---|
| 6 (USDCx, STX) | ~1.8e16 base units (18 billion tokens) |
| 8 (sBTC) | ~1.8e15 sats (18 million BTC) — safe |
| 10 | ~18,000 tokens |
| 12 | ~18 tokens |
| 18 | ~0.000000018 tokens |
| 24 (allowed max) | ~1.8e-17 tokens |

Past the threshold:
- `withdraw` for the whole position aborts with a runtime error. The LP can only exit in chunks small
  enough to keep the product under 2^128. At 18 decimals, with one whole token deposited, that's a few
  hundred base units per call, which in practice means the LP is stuck.
- `deposit` computes `amount × (total-shares + 10^d)`, so any meaningful new deposit aborts.
- `get-lp-value` aborts. A lending integration reading it as collateral value gets an error.
- `flash-loan` is unaffected (fee math is `amount × fee-bp`).

**Proof** (`tests/pool-v3-counter-review.test.ts`, "CR-1"):
- "add-asset accepts an 18-decimal token (MAX-DECIMALS is u24)"
- "18 decimals: an LP holding 1e-7 of a token cannot withdraw its position; new deposits and get-lp-value
  abort". Deposit 1e11 base units, then the full withdraw, a 1e10 deposit and `get-lp-value` all throw
  `ArithmeticOverflow`, while a 1/100 chunk withdraws fine.
- "12 decimals: the same failure at 100 whole tokens"
- "8 decimals (sBTC-shaped) stays safe at 1,000,000 whole tokens"

Test tokens are deployed at runtime with `simnet.deployContract`, not registered in `Clarinet.toml`, so
they never enter the computed mainnet plan.

**Mutation check.** Setting `MAX-DECIMALS` to `u8` in the compiled copy turns the 18- and 12-decimal tests
red. Capping `share-scale` at `10^8` also turns them red at these test sizes, **but it isn't a full fix:**
with scale capped, an 18-decimal asset still overflows at roughly `a² × 10^8 > 3.4e38`, i.e. above ~0.0018
tokens. The base units themselves are too large for `shares × balance` in 128 bits.

**Why it slipped through.** F2 (2026-08-25) correctly moved from a flat `1e6` to `10^decimals` for
inflation protection. Nobody bounded the products for the decimals `add-asset` still accepts. Before F2,
the flat 1e6 had the same issue from 18 decimals upward.

**Recommendation.** Set `MAX-DECIMALS` to `u8`. That covers every asset planned for pool-v3 and turns a
fund-lock into a clean `ERR-DECIMALS-TOO-LARGE` at listing. If higher-decimal assets are ever wanted, the
share math needs restructuring (normalise base units, or a mul-div that never forms the full product),
not just a smaller scale. Until then, add one line to the listing policy: never `add-asset` a token with
more than 8 decimals.

### CR-2 — Low — the receiver allowlist has no asset dimension (`flashstack-pool-v3`)

**Where:** `approved-receivers principal bool` (`:151`), checked at `:372`. `flash-loan` takes any listed
`token` and any `amount ≤ max-loan`, from any caller.

**Effect.** A receiver vetted and approved for asset A can be named by anyone, for asset B, at a time of
their choosing. The pool stays solvent (the per-asset invariant at `:386-387` holds). The cost falls on
the receiver: if it repays the fee from a buffer it holds, every stranger-initiated loan moves one fee
from the receiver to the LPs. This is the RECEIVER_VETTING §C (#98) class, widened by the asset dimension:
an "approved for sBTC" decision is in fact approval for every listed asset.

**Proof.** "CR-2: … a stranger can make an approved receiver pay fees in an asset it was never set up
for". Two assets are listed and the receiver is approved once. A stranger runs two sBTC loans naming it,
and the receiver's sBTC buffer drops by 2 × 500.

**Recommendation.** Either key approvals by `{receiver, asset}`, or make RECEIVER_VETTING item 7 (an
armed, amount-bound loan) mandatory for every pool-v3 receiver and record the approved assets in the
evidence record. Note: the testnet `pool-v3-test-receiver` in #112 has exactly this shape (it pays the
fee for whichever listed asset it's called with, with no caller gate). That's acceptable on testnet; it
must not be approved on mainnet as is.

### CR-3 — Informational — the cached share price moves on a donation

`get-share-price`/`get-lp-value` read the cached `reserve` (`:449-457`), which any deposit (`:306`) or
flash-loan (`:388-389`) refreshes from the live balance. A transfer to the pool followed by any refreshing
call (or an over-repaid flash loan) raises the share price at once. The donor pays the full donation,
spread over all LPs, so it isn't profitable on its own. But an integrator using the share price as
collateral value (`Flashstack-vwh.5`, Zest LP-as-collateral) must not treat it as manipulation-resistant.

### CR-4 — Informational — the deployed gen-1 `flashstack-core` has an admin collateral override

`set-test-stx-locked` (`flashstack-core.clar:64-79`) lets the admin set any account's "locked STX" to any
value, and `get-stx-locked` prefers that map over `stx-account`. That bypasses the 300% collateral check
in `flash-mint`. The deployed source at `SP3TGRVG…flashstack-core` matches the repo file byte for byte
(fetched 2026-10-14), so the override is live. Exposure is limited: the admin is the precautionarily-dead
gen-1 key, and flash-mints must be repaid in the same transaction (supply invariant). Listing it so the
contract inventory doesn't describe the gen-1 core as having no admin-controlled collateral path.

### CR-5 — Informational — relisting resets stats and re-reads decimals

`add-asset` on a soft-delisted asset overwrites the whole entry (`:200-204`). `total-loans`,
`total-volume` and `total-fees` reset to 0, and `share-scale` is recomputed from a live `get-decimals()`.
For a well-behaved token the scale doesn't change. For a token whose decimals could change (upgradeable or
proxy), existing LP shares would re-price. The asset allow-list already trusts the token, so this is a
listing-policy note: don't list tokens with mutable decimals. Also consider `merge` so stats survive a
relist.

The listing policy is now written down in `POOL_V3_LISTING_POLICY.md`. It covers this, CR-1, CR-3, and
fee-on-transfer tokens (threat model row 14), which `tests/pool-v3-fee-on-transfer.test.ts` pins.

### CR-6 — Informational — `total-fees` counts any repayment surplus

`:392` adds `reserve-after − reserve-before`, which includes any over-repayment or donation landing during
the callback. Accounting is correct; the stat overstates fee revenue. Same shape the F1 discussion noted.

### CR-7 — Informational — stale header line

`flashstack-stx-pool-v3.clar:36` still says "Reentrancy-safe: reserve checked after callback returns". The
safety now comes from the #88 lock; the reserve check never provided it (F-9). `flashstack-sbtc-pool-v3`
no longer has the line.

## 3. Checked, no finding

- **Lock release (`asset-locked`):** set first and cleared before `(ok …)` in `deposit` `:277-308`,
  `withdraw` `:331-343` and `flash-loan` `:365-394`. Every early exit is an `err`, which reverts the
  `map-set` with the transaction, so a lock can't be left set.
- **Cross-asset interaction:** a callback can deposit into or borrow a different asset by design. Each
  asset's invariant measures its own live balance, and its share maps are keyed by asset. Nothing found
  that lets asset A's loan move asset B's accounting.
- **Outflow allowances:** both outflows use `as-contract?` with `with-ft (contract-of token) "*" amount`
  (`:339`, `:377`). A malicious listed token can't use the pool's allowance to move a different listed
  asset.
- **Rounding:** shares and withdraw amounts both floor in the pool's favour (`:274`, `:326`). A
  zero-share deposit is rejected (`:291`), and so is a zero-amount withdraw (`:335`).
- **First-depositor inflation:** with VA = 1 and virtual shares = 10^d, zeroing a victim's deposit `V`
  needs a donation above ~`2 × 10^d × V`. That's uneconomic at 6 and 8 decimals.
- **Admin:** two-step (`:158-176`). There's no explicit cancel, but re-proposing overwrites the pending
  admin. Covered by `tests/bc1-two-step-fix.test.ts`.
- **Pause:** global and per-asset pause gate `deposit` and `flash-loan`, never `withdraw`
  (`tests/pool-v3-hillary-review.test.ts`, F3 block). Withdraw on a delisted asset works (soft-delete).

## 4. Open questions for Matt

1. Which assets will pool-v3 list at launch? If only sBTC and USDCx, is `MAX-DECIMALS u8` (CR-1) OK as
   a code change before the audit, rather than a listing-policy note?
2. CR-2: per-asset receiver approval in the contract, or the armed-loan requirement in the checklist?
3. Is pool-v3's `get-share-price` intended as a collateral oracle (`vwh.5`)? If so, CR-3 belongs in the
   integration spec.
4. CR-4: is there any reason to keep the gen-1 `flashstack-core` unpaused? Pausing it needs the gen-1 key.

## Test plan

- `npx vitest run tests/pool-v3-counter-review.test.ts`: 5/5.
- Mutation: `MAX-DECIMALS u24 → u8` in the compiled copy turns 3 CR-1 tests red; capping `share-scale` at
  `10^8` turns the same 3 red (see CR-1 for why that alone isn't a fix).
- Full suite: 304 passed, 3 skipped (the mainnet-plan guard, which needs CI's clarinet version).
