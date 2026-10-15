# FlashStack — sBTC Architecture Review

**Author:** External integrator (HK)
**Date:** 2026-06-06
**Purpose:** Map the entire canonical-sBTC flash-loan path before designing `hk-sbtc-real-receiver-v1` (Matt request #2). Precursor research only — **no implementation**.
**Method:** Verified against `contracts/flashstack-sbtc-core.clar`, `flashstack-sbtc-pool.clar`, `sbtc-flash-receiver-trait.clar`, `sbtc-test-receiver.clar`, `velar-sbtc-arb-receiver.clar`, and live mainnet reads (2026-06-06).

---

## 1. Executive summary

The sBTC flash-loan path is **structurally identical** to the STX path — same "borrow → callback → repay → reserve-grew-by-fee-or-revert" invariant — but every STX primitive (`stx-transfer?`, `stx-get-balance`) is replaced by a **SIP-010 cross-contract call** against the canonical sBTC token (`SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token`). The practical consequences for an external receiver are: (1) the receiver repays with `contract-call? sbtc-token transfer …` instead of `stx-transfer?`; (2) the receiver must be seeded with **real canonical sBTC** (a genuine external dependency we did not have in the STX milestone); and (3) the **live reserve is only ~15,010 sats**, which caps loan size far below the advertised 0.1 BTC max.

A near-complete reference already exists on mainnet: `velar-sbtc-arb-receiver` performs a real sBTC→wSTX→sBTC round-trip on Velar. It is missing the **caller gate** that our `hk-stx-real-receiver-v2` introduced, so the recommended design is `velar round-trip ⊕ v2 caller gate` — a direct mirror of the Milestone 1 composition.

---

## 2. Live on-chain state (verified 2026-06-06)

| Contract | Deployed? | Notes |
|---|---|---|
| `SP20XD46….flashstack-sbtc-core` | ✅ | reserve **15,010 sats**, `total-loans u2`, `total-volume u20000`, fee **5 bps**, max-loan **10,000,000 sats (0.1 BTC)**, paused **false** |
| `SP20XD46….flashstack-sbtc-pool` | ✅ | LP pool; also exposes a flash-loan + collateral oracle |
| `SP20XD46….sbtc-flash-receiver-trait` | ✅ | the interface |
| `SP20XD46….sbtc-test-receiver` | ✅ | whitelisted at review time; de-approved 2026-10 under F-10 (`docs/security/FINDINGS_REGISTER.md`) |
| `SP20XD46….velar-sbtc-arb-receiver` | ✅ | whitelisted at review time; de-approved 2026-10 under F-10 (`docs/security/FINDINGS_REGISTER.md`) |
| `SM3VDXK3…sbtc-token` (canonical sBTC) | ✅ | real mainnet token |

Reference evidence tx: `0x67f0c77d…f9baa` → `success / (ok true)`, block 7875468.

> **Note:** this directly **contradicts `docs/TESTING_GUIDE_STX.md:16-18`**, which labels the sBTC path "legacy — do not test." The live `flashstack-sbtc-core` under `SP20XD46…` is active. (Logged in [[docs-feedback-report]] as E5.)

---

## 3. Contract interfaces

### 3.1 `sbtc-flash-receiver-trait` (`sbtc-flash-receiver-trait.clar`)
```clarity
(define-trait sbtc-flash-receiver-trait
  ((execute-sbtc-flash (uint principal) (response bool uint))))
```
One function. Deployed under the **protocol deployer** `SP20XD46…` (contrast: the STX trait is under the *legacy* `SP3TGRVG7…`). An sBTC receiver declares `(impl-trait 'SP20XD46….sbtc-flash-receiver-trait.sbtc-flash-receiver-trait)`.

### 3.2 `flashstack-sbtc-core` (`flashstack-sbtc-core.clar`)
- **Error codes** (`:24-31`): `u300 PAUSED`, `u301 ZERO-AMOUNT`, `u302 REPAY-FAILED`, `u303 INSUFFICIENT-RESERVE`, `u304 EXCEEDS-LIMIT`, `u306 NOT-APPROVED`, `u310 NOT-ADMIN`, `u311 TRANSFER-FAILED`. (Note `u300`/`u310` differ from the STX core, where `u300 = NOT-ADMIN`, `u305 = PAUSED`.)
- **State** (`:37-46`): `admin`, `paused`, `fee-basis-points u5`, `max-single-loan u10000000`, `total-loans`, `total-volume`, `total-fees-collected`, `approved-receivers` map.
- **`flash-loan(amount, receiver<sbtc-flash-receiver-trait>)`** (`:52-91`):
  1. `reserve-before` = `sbtc-token.get-balance(self)` (cross-contract, `unwrap!` — `:60`).
  2. Guards: not paused, amount>0, ≤ max, approved, reserve≥amount (`:64-68`).
  3. `as-contract (sbtc-token.transfer amount self → receiver none)` (`:71-74`).
  4. `try! (receiver.execute-sbtc-flash amount self)` (`:77`).
  5. `reserve-after` ≥ `reserve-before + fee` else `ERR-REPAY-FAILED` (`:80-83`).
  6. Stats; **`total-fees-collected += (reserve-after − reserve-before)`** — the *actual* surplus, not the nominal fee (`:87`). (STX core counts the nominal `fee`.)
- **Admin:** `deposit-reserve(amount)` (`:97`), `withdraw-reserve(amount, to)` (`:108` — **2 args**, vs STX's 1), `add/remove-approved-receiver`, `set-paused`, `set-fee-basis-points`, `set-max-single-loan`, `set-admin` (single-step, `:155`).
- **Read-only:** `get-reserve-balance` (returns the token's `(ok uint)`), `get-fee-basis-points`, `get-max-single-loan`, `get-admin`, `get-stats` (**4 fields only**: total-loans/total-volume/total-fees-collected/paused — `:182-189`), `is-approved-receiver` (**`(ok bool)`** — `:191-193`), `calculate-fee`.

> **Latent contract bug (flag to Matt, not our blocker):** `set-fee-basis-points` asserts `(<= new-fee u100)` but returns `ERR-NOT-ADMIN` on violation (`:143`) — wrong error constant — and has **no lower bound**, so the fee could be set to `0`. The STX core uses `(and (>= u1) (<= u1000)) ERR-INVALID-FEE`, and — notably — `flashstack-sbtc-pool.clar:177` gets it *right* (`(>= u1)(<= u100) ERR-INVALID-FEE`). The sibling contracts disagree.

### 3.3 `flashstack-sbtc-pool` (`flashstack-sbtc-pool.clar`)
A **separate** LP-funded contract (error base `u700`) that *also* offers flash loans (`:113-154`) against an LP-deposited sBTC reserve, plus an LP share system and a **collateral oracle** (`get-share-price`, `get-lp-value`, `get-collateral-snapshot` — sats/share scaled by `1e8`). So there are **two** sBTC flash-loan sources — the admin-reserve `core` and the LP-reserve `pool` — each with its own `approved-receivers` whitelist. For an external receiver, the `core` is the documented target.

---

## 4. Flash-loan lifecycle (sBTC)

```
caller → flashstack-sbtc-core.flash-loan(amount, receiver)
   reserve-before = sbtc-token.get-balance(core)
   guards: not paused · amount>0 · amount ≤ max · approved · reserve ≥ amount
   as-contract sbtc-token.transfer amount: core → receiver
   → receiver.execute-sbtc-flash(amount, core)        [STRATEGY]
        (amount sBTC sats now in receiver's token balance)
        ... DEX legs / liquidation ...
        as-contract sbtc-token.transfer (amount+fee): receiver → core
   assert sbtc-token.get-balance(core) ≥ reserve-before + fee   → (ok true) | revert
```

Identical control flow to STX; the only substitutions are the **asset transfer mechanism** (SIP-010 `transfer` with a trailing `none` memo, wrapped in `as-contract`) and the **balance read** (cross-contract `get-balance`, which returns a `response` and must be `unwrap!`-ed).

---

## 5. Comparative analysis — STX core vs sBTC core

### Similarities (reusable as-is)
- The reserve-invariant security model (repayment verified by before/after balance; reserve never at risk; worst case = atomic revert).
- The whitelist gate (`approved-receivers`, admin-only `add-approved-receiver`).
- Dynamic fee = `max(amount·bp/10000, 1)`; default 5 bps.
- The receiver pays the fee from its **own balance** → **seed-before-loan applies equally** (the sBTC seed is real sBTC).
- The callback shape `(uint principal) → (response bool uint)`.

### Differences (must change for sBTC)
| Aspect | STX core | sBTC core |
|---|---|---|
| Asset primitive | native `stx-transfer?` / `stx-get-balance` | SIP-010 `contract-call? sbtc-token transfer/get-balance` |
| Balance read | cheap, infallible | cross-contract, returns `response` → `unwrap!` |
| Repay call | `(as-contract (stx-transfer? owed tx-sender core))` | `(as-contract (contract-call? SBTC transfer owed tx-sender core none))` |
| Receiver seed asset | STX (we already held it) | **real canonical sBTC** (must acquire) |
| Trait deployer | `SP3TGRVG7…` (legacy) | `SP20XD46…` (protocol) |
| Callback fn | `execute-stx-flash` | `execute-sbtc-flash` |
| Error base | `u300 = NOT-ADMIN`, `u305 = PAUSED` | `u300 = PAUSED`, `u310 = NOT-ADMIN` |
| `get-stats` | 7 fields | 4 fields |
| `is-approved-receiver` | bare `bool` | `(ok bool)` |
| `withdraw-reserve` | `(amount)` | `(amount, to)` |
| Admin transfer | 2-step (`transfer-admin`+`accept-admin`) | 1-step (`set-admin`) |
| Fee accounting | nominal `fee` | actual delta `reserve-after − reserve-before` |
| Default max-loan | 500,000 STX | 0.1 BTC (10,000,000 sats) |
| **Live reserve** | ~75 STX | **~15,010 sats** |

### Reusable components for `hk-sbtc-real-receiver-v1`
- **Our `hk-stx-bitflow-receiver-v1` skeleton**: caller gate (`contract-caller == core` → `ERR-WRONG-CALLER`), dynamic fee lookup, two DEX legs, balance assert, fail-closed repay, owner-only `rescue` + `set-slippage`, read-only `estimate-repayment`. Swap STX primitives → sBTC SIP-010 calls.
- **`velar-sbtc-arb-receiver`** is a near-complete two-leg sBTC round-trip (sBTC→wSTX→sBTC on Velar pool 70) — but its `execute-sbtc-flash` is **public with no caller gate** (`velar-sbtc-arb-receiver.clar:47`). Reusing its swap legs while adding the v2 caller gate is the recommended path.

### New implementation requirements (don't exist in the STX build)
1. **Acquire real canonical sBTC** for the receiver seed — the dominant new dependency (see §6).
2. Import a SIP-010 trait (for `sbtc-token` transfer/get-balance/get-balance calls) into the receiver.
3. Choose a venue. The only proven on-chain sBTC round-trip in-repo is **Velar univ2** (constant-product, ~0.3%/leg → **~0.6% round-trip cost**) — far lossier than Bitflow's stableswap (~0.15% in M1). Seed must be sized to that, or the loan kept small.
4. Handle the cross-contract `get-balance` `response` unwraps (the sBTC core/pool do this; a receiver must too).

---

## 6. Funding & deployment requirements

- **Real sBTC required:** yes. The receiver must hold canonical sBTC to cover fee + round-trip slippage before the first loan. Minimum protocol fee is 1 sat, but a Velar round-trip on a ~0.6%-cost venue means the seed should cover ~0.6% of the loan plus margin. For a 10,000-sat loan that's ~60–100 sats of seed; for safety, seed ~1,000–5,000 sats.
- **Sourcing sBTC:** bridge BTC via the sBTC bridge, or buy sBTC on a Stacks DEX (Velar/Bitflow) using STX we already hold. Acquiring a few thousand sats is cheap (<$5) but is a real logistics step with a confirmation delay.
- **Reserve ceiling:** the live core reserve is **15,010 sats**, so the maximum borrowable today is ~15k sats regardless of the 0.1 BTC cap (guard `reserve ≥ amount`, `:68`). A meaningful demo may need Matt to top up the sBTC reserve via `deposit-reserve`.
- **Deploy cost:** ~0.5 STX (same as the STX receiver; deploy fee is paid in STX).
- **Whitelist:** admin-only `add-approved-receiver` on `flashstack-sbtc-core` — same external dependency on Matt as M1.

---

## 7. Risk areas (for the Phase C design)

| Risk | Severity | Note |
|---|---|---|
| Tiny sBTC reserve (15k sats) caps loan size | Medium (demo scope) | May need Matt to fund reserve for a non-trivial loan |
| Velar univ2 ~0.6% round-trip cost → larger seed | Medium | Pick smallest viable loan; size seed to slippage; `min-out=u1` + repay-assert as in M1 |
| Acquiring real sBTC is an external dependency | Medium | Bridge/buy a few thousand sats before execution |
| `velar-sbtc-arb-receiver` lacks a caller gate | High (if reused verbatim) | Add the v2 `contract-caller == core` gate — do not ship without it |
| sBTC core `set-fee-basis-points` wrong error + no lower bound | Low (protocol, not ours) | Flag to Matt; dynamic fee lookup means our receiver tolerates fee changes anyway |
| SIP-010 post-conditions on transfers | Low | Use `PostConditionMode.Allow` in the execute tx, as in M1 |
| Two sBTC flash-loan sources (core vs pool) | Low | Target `core`; don't cross-wire the pool's whitelist |

---

## 8. Open questions for Phase C

1. **Venue:** stick with Velar pool 70 (proven reference; its receiver was de-approved 2026-10 under F-10) or evaluate a Bitflow sBTC stableswap pair (lower slippage) if one exists? — to verify on-chain in Phase C.
2. **Loan size & reserve:** confirm with Matt whether the sBTC reserve will be topped up, which sets the demo loan size.
3. **Seed source:** bridge vs DEX-buy for the sBTC seed; who funds it.

---

---

## 9. Implementation outcome (2026-06-06 — Milestone 2 build)

Phase C design was implemented and validated off-chain (no broadcast). Findings added since the research above:

- **Live Velar pool 70 reserves confirmed:** `reserve0 (wSTX) = 223,275,450,774 µSTX`, `reserve1 (sBTC) = 65,845,796 sats`. **Swap fee = 0.3%/leg** (`get-fees → swap-fee 9970/10000`; protocol takes 25% *of* that fee). Round-trip cost ≈ **0.6%** for any ≤15k-sat loan (price impact negligible at <0.025% of reserve). Full seed math in `minimum_seed_analysis.md`.
- **sBTC reserve re-confirmed 15,010 sats; fee 5 bps; max-loan 10M sats; not paused; total-loans 2.** Our wallet holds **0 sBTC** — seed must be acquired (Velar buy helper written).
- **Trait-arg passing (new, ADR-S8):** the Velar router's `token0/1/in/out` and `share-fee-to` params are `trait_reference`. Passing a **named constant** there fails the analyzer (`use of unresolved contract`); a **literal** absolute principal resolves for static trait conformance. The receiver therefore uses literals throughout the swap calls, mirroring `velar-sbtc-arb-receiver` exactly. (Note: M1's Bitflow swap args are *also* `trait_reference` and M1 passed constants there successfully on mainnet — both patterns deploy, but literals are what clarinet's static check accepts cleanly, so we standardized on literals.)
- **Validation:** `clarinet check` ✔ (logic-equivalent stubs — the live sBTC/Velar suite does not assemble into simnet, same limitation as the STX suite); caller-gate negative test → `(err u403)`; deploy/seed/execute/buy scripts dry-run clean against live mainnet.

See `hk-sbtc-receiver-deployment-plan.md` for the full ADR table, validation record, and mainnet runbook.

---

*Verified against `contracts/` source and live mainnet reads on 2026-06-06. Implemented as `contracts/hk-sbtc-real-receiver-v1.clar`; see [[hk-sbtc-real-receiver-v1-Design]] and `hk-sbtc-receiver-deployment-plan.md`.*
