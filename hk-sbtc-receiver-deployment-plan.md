# hk-sbtc-real-receiver-v1 — Deployment Plan, ADRs & Validation Record

**Author:** External integrator (HK)
**Date:** 2026-06-06
**Milestone:** 2 (external sBTC receiver on mainnet)
**Status:** Built & validated off-chain. **Mainnet deploy/execute is GATED on:** (1) acquiring the sBTC seed, (2) Matt whitelisting the receiver. No mainnet transactions broadcast yet.
**Update 2026-10-15:** v1 is now deployed and approved on `flashstack-sbtc-core`. It is being replaced by `hk-sbtc-real-receiver-v2` (Bitflow pool 21, #115), and v1's approval is to be removed once v2's smoke loan passes.
**Companion docs:** `minimum_seed_analysis.md` · `sbtc-architecture-review.md`

---

## 1. What this is

`hk-sbtc-real-receiver-v1.clar` is the canonical-sBTC mirror of the Milestone-1 receiver. Inside one `flashstack-sbtc-core` flash loan it borrows sBTC, runs a **real Velar sBTC→wSTX→sBTC round-trip** (pool 70), and repays principal + fee atomically. Objective is **external strategy execution + repayment, not profit** — the same bar M1 met.

Architecture = **M1 skeleton** (caller gate, dynamic fee, fail-closed repay, owner rescue, read-only estimate) **⊕ `velar-sbtc-arb-receiver` legs** (the proven on-chain sBTC round-trip). Both halves are already deployed-and-proven on mainnet; this contract composes them and adds the caller gate the velar reference lacks.

---

## 2. Architectural Decision Records

| ADR | Decision | Rationale |
|---|---|---|
| **ADR-S1** | Reuse the M1 receiver skeleton; swap STX primitives → sBTC SIP-010 calls | M1 is proven on mainnet; minimizes new surface |
| **ADR-S2** | Add a **caller gate** (`contract-caller == flashstack-sbtc-core` → `ERR-WRONG-CALLER u403`) | `velar-sbtc-arb-receiver` exposes a **public** `execute-sbtc-flash` with no gate — a direct-drain vector. Non-negotiable. **Runtime-tested: a non-core caller returns `(err u403)`** (simnet). |
| **ADR-S3** | Venue = **Velar univ2 pool 70** (wSTX/sBTC) | Only proven on-chain sBTC round-trip in-repo (its receiver, `velar-sbtc-arb-receiver`, was whitelisted then; de-approved 2026-10 under F-10). Live reserves: 223,275 wSTX / 65,845,796 sats. Accept ~0.6% round-trip cost; objective is execution, not profit. |
| **ADR-S4** | `min-out = u1` on both legs; repay-assert + core reserve check are the gates | Same as M1; avoids percentage-floor reverts. No funds at risk — under-repay reverts the whole tx. |
| **ADR-S5** | **Absolute** mainnet principals everywhere | External deploy; `.sugar` would resolve to our wallet (M1 ADR-001) |
| **ADR-S6** | Seed the receiver with real canonical sBTC, sized to round-trip loss + fee + margin; recover via `rescue-sbtc` | Receiver pays fee + slippage from its own balance. See `minimum_seed_analysis.md`: 1,000-sat loan → ~7-sat min seed, **seed 500 sats (safe)**. |
| **ADR-S7** | Size the loan to the live reserve (15,010 sats) | Guard `reserve ≥ amount`. Matt: 1,000-sat demo is sufficient; no top-up wait. |
| **ADR-S8** (new, implementation) | Pass **absolute-principal LITERALS** to the Velar router's `trait_reference` args (token0/1/in/out, share-fee-to), not named constants | The router's token/share-fee-to params are `trait_reference`. The clarity analyzer resolves a **literal** contract principal for static trait conformance; a named constant in that position fails to resolve (`use of unresolved contract`). Mirrors `velar-sbtc-arb-receiver` exactly. Constants are still fine for the call *target* and for non-trait positions, but we use literals throughout the swap calls for one consistent, proven pattern. |

---

## 3. Validation record (off-chain, no broadcast)

| Check | Tool | Result |
|---|---|---|
| Static type-check | `clarinet check` against logic-equivalent stubs (sBTC/Velar live suite won't assemble into simnet — same gap M1 hit with Bitflow) | **✔ 9 contracts checked**, 0 errors, 0 warnings on the receiver |
| Caller-gate negative test | `clarinet console` (simnet) | non-core caller of `execute-sbtc-flash` → **`(err u403)`** |
| Router signature conformance | live Hiro interface read | `swap-exact-tokens-for-tokens(id, token0, token1, token-in, token-out, share-fee-to, amt-in, amt-out-min)` — args match exactly |
| Deploy tx build | `deploy-hk-sbtc-receiver.mjs DRY_RUN=1` | tx built OK (19,264-byte body), Clarity 3, balance/nonce confirmed |
| Execute preflight + tx build | `execute-sbtc-flash-loan.mjs DRY_RUN=1` | reserve→15,010, is-approved→false, seed→0 correctly read; warnings fire; tx built OK |
| Buy-seed quote + tx build | `buy-sbtc.mjs DRY_RUN=1` | 3.5 STX → ~1,029 sats quoted (matches seed analysis); swap tx built OK |
| Parallel-to-deployed-reference | manual diff | swap legs identical in shape to the live `velar-sbtc-arb-receiver`; skeleton identical to the live M1 receiver |

---

## 4. Deliverables (this milestone)

- `contracts/hk-sbtc-real-receiver-v1.clar` — the receiver.
- `scripts/deploy-hk-sbtc-receiver.mjs` — deploy (DRY_RUN, balance/nonce/fee checks).
- `scripts/buy-sbtc.mjs` — acquire sBTC seed via Velar (DRY_RUN, live quote).
- `scripts/seed-hk-sbtc-receiver.mjs` — SIP-010 sBTC seed transfer (DRY_RUN, balance guard).
- `scripts/execute-sbtc-flash-loan.mjs` — execute flash loan (DRY_RUN, full preflight: approved/reserve/seed/estimate).
- `minimum_seed_analysis.md` — economic validation (aggressive/recommended/safe seed tiers).
- `sbtc-architecture-review.md` — updated with live state + implementation findings.
- This deployment plan + ADRs.

---

## 5. Mainnet runbook (execute only when ready)

All scripts read the 24-word mnemonic from `./mbegu2` then `./mbegu` (gitignored live key) or `MAINNET_MNEMONIC`. Run each with `DRY_RUN=1` first.

1. **Acquire sBTC seed:** `node scripts/buy-sbtc.mjs` (default 3.5 STX → ~1,000 sats). Verify wallet sBTC balance.
2. **Deploy:** `node scripts/deploy-hk-sbtc-receiver.mjs` (~0.5 STX). Note the contract id.
3. **Whitelist (Matt):** ask Matt to call `add-approved-receiver` on `flashstack-sbtc-core` for `SP3NZYZA88ENNF0FCR57KBGPFY5RAXWHXXVSB6FBW.hk-sbtc-real-receiver-v1`. Verify `is-approved-receiver → (ok true)`.
4. **Seed:** `SEED_SATS=500 node scripts/seed-hk-sbtc-receiver.mjs`. Verify receiver sBTC balance = 500.
5. **Execute:** `AMOUNT_SATS=1000 node scripts/execute-sbtc-flash-loan.mjs`. Expect `(ok true)` + a `sbtc-velar-roundtrip` print event + reserve `+fee`.
6. **Collect evidence:** txid, print event, Velar swap events, reserve delta, `total-loans` 2→3.
7. **Recover seed:** call `rescue-sbtc(residual, SP3NZYZA…)` to return the ~493-sat residual; optionally sell sBTC back to STX.

---

## 6. Risk posture

- **Reserve at risk: none.** Atomic; any under-repayment reverts the entire tx (core before/after check + our repay-assert).
- **Worst realistic failure:** a failed tx (wasted gas) if the pool drifts and seed margin is too thin — mitigated by seeding the **safe** tier (500 sats).
- **External deps:** acquire sBTC (we control), Matt whitelist (same as M1), Velar pool 70 liquidity (deep), optional reserve top-up (not needed for 1,000-sat demo).
- **Known core bug (`set-fee-basis-points`: wrong error path + no lower bound):** documented in `sbtc-architecture-review.md`; Matt acknowledged; **not a blocker** — our dynamic fee lookup tolerates any valid fee.

---

*Built and validated 2026-06-06 against live mainnet reads and clarinet simnet. No mainnet transactions broadcast. Definition of done (M2): deployed → whitelisted → seeded → `flash-loan` `(ok true)` with evidence → seed recovered.*
