# Clarity audit — flashstack-stx-pool-v2 / flashstack-sbtc-pool-v2

**Date:** 2026-10-02 · **Method:** manual audit using the `clarity-audit` skill framework
(aibtcdev/skills, static-analysis checklist + risk-color framework) · **Contracts:**
[`contracts/flashstack-stx-pool-v2.clar`](../../contracts/flashstack-stx-pool-v2.clar),
[`contracts/flashstack-sbtc-pool-v2.clar`](../../contracts/flashstack-sbtc-pool-v2.clar) —
both **live, funds-bearing, deployed on mainnet**.

This audit is static analysis only — it does not execute the contracts. It does not
re-derive F-9 from scratch (already confirmed, tracked, and independently cross-verified
twice in `docs/security/FINDINGS_REGISTER.md`); it applies the full checklist to both
contracts end to end and reports what else that pass surfaces alongside reconfirming F-9.

## Summary

Two near-identical "mini Aave pool" LP contracts (STX and sBTC), both implementing the
same ERC-4626-style virtual-shares/virtual-assets model (the F-1 fix) on top of a
balance-delta-checked flash loan. Admin surface is narrow and uniformly gated. The one
**Critical** issue is F-9, already filed and independently confirmed by both Hillary and
Matt — this audit reconfirms it from a fresh read rather than discovers it. Four
additional **Low**/**Informational** items came out of this pass, none new in kind, none
funds-at-risk on their own, but worth fixing opportunistically:

- Both contracts' own header comments are stale (say "Not yet deployed" — they are deployed).
- `ERR-NO-SHARES` is defined in both contracts but never asserted anywhere (dead code).
- `transfer-admin` is single-step with no target confirmation — combined with F-9, this
  means admin-key compromise isn't just "pause/fee/whitelist griefing," it's a direct path
  to triggering F-9 at will (whitelist an attacker-controlled receiver, no waiting required).
- The two pools' `set-fee-basis-points` bounds and `total-fees` accounting diverge from
  each other in ways that don't look deliberate.

**Verdict: CONDITIONAL_PASS** (conditional on F-9's already-tracked remediation).
**Risk level: CRITICAL** (driven entirely by F-9, which this file defers to rather than
re-litigates — see the register for full detail, PoC, and current mitigation status).

| | STX pool v2 | sBTC pool v2 |
|---|---|---|
| Public functions | 9 | 9 |
| Read-only functions | 8 | 10 |
| Private functions | 0 | 0 |
| Maps | 2 | 2 |
| Data vars | 8 | 8 |
| Constants (incl. error codes) | 14 | 14 |

## What works correctly

- **Admin functions are uniformly gated**, first line, every time — `add-approved-receiver`,
  `remove-approved-receiver`, `set-fee-basis-points`, `set-paused`, `set-max-single-loan`,
  `transfer-admin` all `asserts! (is-eq tx-sender (var-get admin))` before anything else.
- **Receiver access is double-gated**: the `<...-flash-receiver-trait>` type constrains the
  call shape, and the separate `approved-receivers` whitelist constrains *which* contracts
  of that shape may actually borrow — neither check alone would be enough.
- **`withdraw` burns shares before transferring STX/sBTC out** (map-set, var-set, *then* the
  transfer) — correct checks-effects-interactions ordering, even though Clarity's lack of a
  receive-hook on asset transfers to a contract principal means classic reentrancy isn't
  reachable here regardless.
- **No unbounded iteration** in either contract — fixed, small number of operations per call.
- **`set-fee-basis-points` is bounded** on both pools (can't be zeroed via admin action,
  can't be set absurdly high) — though the two pools use different bounds, see Findings.
- **Virtual-shares/virtual-assets (F-1) is applied consistently** to deposit, withdraw, and
  (sBTC) the oracle reads — the offset is well-defined at zero shares, no first-depositor
  special case needed.
- Checked whether combining `deposit` (F-9's vector) with an immediate same-callback
  `withdraw` could let a receiver extract value in the same transaction rather than just
  dilute future LPs: it can't — by the time `deposit` returns inside the callback, the pool
  balance is already restored (plus fee), so an immediate `withdraw` of the newly-minted
  shares returns only what was just put in. F-9's actual profit mechanism is the permanent
  dilution of *existing* LPs' share of the pool, not an in-transaction extraction — this
  doesn't change F-9's severity, it just confirms there's no larger variant hiding behind it.

## Findings

| ID | Severity | Contract(s) | Description | Recommendation |
|----|----------|-------------|--------------|-----------------|
| **F-9** | **Critical** | both | Already filed — see `FINDINGS_REGISTER.md`. Reconfirmed on this pass: both contracts' own doc comments claim "Reentrancy-safe: reserve checked after callback returns" (STX pool, line 24) / an equivalent repayment-by-balance-delta claim (sBTC pool) — true only against a receiver that keeps the funds or repays by plain transfer, not one that repays via `deposit()`. The claim is misleadingly absolute as written. | No action beyond what's already tracked — flagging only because the stale claim is *in the contract's own comments*, where a future reader (including a future auditor skimming just the header) could take it at face value. |
| V2-A | Low | both | Header comment says "Not yet deployed. Deploy this in place of the v1 pool... before opening real LP deposits" — both contracts are in fact the live, deployed, funds-bearing versions. Stale from before deployment. | Update both headers to reflect live status, same spirit as the CONTRACT_INVENTORY corrections earlier this week — a header that says "not yet deployed" on a contract holding real funds is exactly the kind of doc/reality gap this project has been actively hunting down. |
| V2-B | Low | both | `ERR-NO-SHARES` (STX: u408, sBTC: u708) is defined but has no call site in either contract — `withdraw`'s actual zero-shares case is caught by `ERR-INSUFFICIENT-SHARES` via the `>=` check against a `default-to u0`. Dead error code. | Either wire it up somewhere it's actually distinct from `ERR-INSUFFICIENT-SHARES`, or remove it. Zero security impact either way. |
| V2-C | Low | both | `transfer-admin` is single-step, no target-confirms-receipt pattern. Not a new observation on its own, but worth connecting explicitly to F-9: whoever holds the admin key can call `add-approved-receiver` directly, which is the *only* gate standing between F-9 and exploitation — so admin-key compromise isn't bounded to "parameter griefing," it's a direct, no-waiting path to triggering F-9. This raises the bar on the admin key's operational security specifically (relevant to the wallet-rotation item already on your pending list) above what it would be for a pool without F-9 open. | Two-step transfer (propose + accept) is the standard fix and matches what you'd want for `set-admin` generally; prioritize it alongside — not instead of — the real F-9 fix, since it narrows the blast radius of the admin key specifically while F-9 remains open. |
| V2-D | Informational | both | Two small divergences between the otherwise-identical pools, neither looks deliberate: (1) `set-fee-basis-points` caps at 10% on the STX pool (`u1000`) vs 1% on the sBTC pool (`u100`); (2) `total-fees` accounting differs — STX pool credits exactly the nominal `fee` regardless of actual repayment surplus, sBTC pool credits the *actual* observed reserve delta (`reserve-after - reserve-before`), so the two pools' `total-fees` counters aren't computed the same way given the same receiver behavior. Neither affects actual share value (both pools price shares off the live balance, not off `total-fees` — this counter is informational/analytics only), so this is cosmetic, not a funds issue. | Worth a decision on whether the fee-bound asymmetry is intentional (STX fees sized in µSTX, sBTC in sats — a 10x cap difference isn't obviously wrong, just unexplained in the source) and whether `total-fees` should be defined the same way on both pools for anyone building a dashboard off `get-stats`. |

## flashstack-pool-oracle-v2 (added 2026-10-14, `Flashstack-ajv.4.2`)

**Contract:** [`contracts/flashstack-pool-oracle-v2.clar`](../../contracts/flashstack-pool-oracle-v2.clar),
live at `SPR9PQANV6XHSDNRAX2GNKCA5Z1KH61961KE0BYG.flashstack-pool-oracle-v2` (published at
block 8,635,570). Reads only `flashstack-stx-pool-v2`. The sBTC pool has its own built-in
oracle functions and wasn't re-reviewed here.

**VERIFIED, deployed vs repo:** the source fetched from Hiro `/v2/contracts/source` on
2026-10-14 is byte-identical to `contracts/flashstack-pool-oracle-v2.clar`
(sha256 `80df9e0c...094ab6` for both). The `contracts/test/` copy differs only by
address localization (`'SPR9PQAN....flashstack-stx-pool-v2` becomes `.flashstack-stx-pool-v2`,
8 lines).

**VERIFIED, live state** (Hiro `call-read`, tip 9,208,372, 2026-10-14): pool balance
1,000,000 uSTX, total shares 1,000,000,000,000, `get-share-price` = `u1`,
`get-collateral-snapshot` = {share-price 1, yield-accrued 0, total-loans 0,
is-healthy true}. The pool is `paused: true`.

**Surface.** Six read-only functions. No public functions, no data vars, no maps, no
admin, no pause. `POOL` is an immutable constant. So there's no admin power to abuse and
no stored price to go stale: every value is computed from the pool's live state at call
time. Two `unwrap-panic`s on the pool's `get-stats` can't fire, because `get-stats`
always returns `ok` (VERIFIED, pool source).

**What works.** `get-lp-value` uses exactly the pool's `withdraw` conversion,
`shares * (balance + 1) / (total + 1e6)` with the same floor. So it equals what an LP
can actually withdraw, and the F-2 scale fix holds (VERIFIED, source, and pinned by
`tests/flashstack-pool-oracle-v2.test.ts`, "no drift"). Withdrawals stay open while the
pool is paused, so values reported during a pause are still redeemable.

**Consumers.** INFERENCE: none known. Nothing in this repo calls it. The web app reads
the pool's own `get-stx-value`, not the oracle (`web/src/lib/stacks/config.ts`). Read-only
calls leave no on-chain trace, so off-chain readers can't be ruled out, and an
on-chain caller would have to be a published contract that names it. No integration
(Zest, ALEX) is in the repo. The findings below are latent until something integrates.

| ID | Severity | Description | Recommendation |
|----|----------|-------------|-----------------|
| **F-11** | Low (latent) | **`get-share-price` has no usable resolution.** The pool mints `1e6` shares per uSTX, so one share is worth about `1e-6` uSTX. `get-share-price` scales by only `1e6`, so it reads `1` at the launch value, ignores any gain short of +100%, and reads `0` for any loss below the launch value. Live, it sits exactly on that edge: `(1,000,000 + 1) * 1e6 / (1e12 + 1e6) = 1`. One uSTX less in the pool reads `0`. `get-collateral-snapshot.share-price` is the same expression. **This sharpens F-3:** F-3 says a 0.05% fee doesn't move the price. In fact nothing short of doubling does, and the price collapses to 0 on the downside. Pinned by test. | Integrators must use `get-lp-value` (correct to the uSTX) and never `get-share-price` or the snapshot's `share-price`. Say so in INTEGRATION_GUIDE before any lending integration. A successor oracle should scale by `1e12` or more, or report value per `1e6` shares. |
| **F-12** | Low (latent) | **Intra-transaction reads.** Every value function reads the pool's live STX balance. During a flash-loan callback the borrowed amount is outside the pool, so any contract that consults the oracle in that transaction sees deflated values (`get-lp-value` lower by the LP's pro-rata share of the loan, `get-share-price` = 0 per F-11). Pinned by test: a receiver reading mid-loan sees price `0` and the LP's value minus the loan. The header claim "Flash loans cannot inflate the pool" is true, but it doesn't address deflation. If a lending protocol priced LP collateral from this oracle, a borrower could take a flash loan from this pool and, inside the callback, trigger liquidations against the temporarily depressed value. INFERENCE: not reachable today. The pool is paused, no receiver has ever been approved on it (F-9 row), and no consumer is known. A direct STX donation raises the reported value too, but that value is real and withdrawable, mostly by the donor, so it isn't a free lunch. | Same as F-11 for integrators: never read the oracle from inside a flash-loan path, and treat it as unsafe for liquidation decisions without a reentrancy guard or time-averaging on the consumer side. Same posture as F-9 for the pool: keep it paused and approve nothing. |
| OV2-A | Informational | The header comment is stale. It says "Not yet deployed", calls itself "a read-only oracle wrapper around flashstack-stx-pool" (v1), and says "Pool balance only increases" (false: `withdraw` decreases it; only the per-share value is non-decreasing). It also says "At launch: 1 share = 1 microSTX" when one share is about `1e-6` uSTX. Same class as V2-A. | Immutable. Correct the description in INTEGRATION_GUIDE and the README instead. |

The same F-11 structure (`VIRTUAL-SHARES` equal to `SHARE-PRECISION`) appears in
`flashstack-sbtc-pool-v2`'s built-in `get-share-price` (1e8/1e8). Checked 2026-10-15
(`Flashstack-ajv.4.12`): it is affected the same way. It reads `1` live, and the detail is in
the FINDINGS_REGISTER F-11 row.

## Notes

- This pass only covered the two v2 pools, not the full `contracts/` tree (~45 files,
  many of them per-integration receiver contracts rather than core protocol contracts).
  Happy to scope a second pass at `flashstack-core`, the v3 pools, or the oracle contracts
  if useful — the v2 pools were the obvious first target given F-9 is open there right now.
- Static analysis only; doesn't replace the Clarinet test suite or F-9's own simnet PoC.
