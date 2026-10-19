# Testnet Staging Procedure

**Owner:** Security & Contract Lead
**Status:** Procedure defined; **not yet executed for any contract.**
**Evidence date:** 2026-09-17 (repo facts re-read, and testnet chain state
verified read-only via the public Hiro API, on this date)
**Bead:** `Flashstack-ajv.6.1`

---

## 1. Why this exists

FlashStack has never staged a deployment on testnet. The live contracts went
**simnet → mainnet**, with the Clarinet simnet suite as the only pre-deployment
gate.

The simnet suite is good and catches logic bugs, but it cannot catch what actually
goes wrong at publish time: real trait resolution across principals, a real token
contract rather than a local mock, post-conditions, fee and nonce handling, epoch
and clarity-version acceptance, and address-substitution mistakes.

The mainnet history is a record of exactly that class of failure. From
`docs/security/CONTRACT_INVENTORY.md` §3 — `flashstack-stx-core` aborted 3 times,
`flashstack-sbtc-core` twice, `usda-vault-rescue-receiver` five times, plus assorted
`dbg*` and `stx-core-test*` probes. Aborted publishes never take effect, but they
**consume the contract name permanently at that principal**, which is why the live
system carries `-v2`/`-v3`/`-v4`/`-v5` suffixes. That is the cost of debugging on
mainnet.

**Scope: forward-looking only.** The live contracts are immutable and nothing here
changes them. This applies to the undeployed successors — `flashstack-stx-core-v2`,
`flashstack-sbtc-core-v2`, `flashstack-stx-pool-v3`, `flashstack-sbtc-pool-v3` — and
to `flashstack-pool-v3`, the audit target.

---

## 2. The gate

No contract reaches mainnet except through every step, in order:

| # | Step | Gate | Who |
|---|---|---|---|
| 1 | `clarinet check` clean | 0 errors | CI |
| 2 | Full suite green | all tests pass | CI |
| 3 | Security & Contract Lead review | CODEOWNERS approval | Lead |
| 4 | **Testnet deploy from a plan checked into `deployments/`** | all publishes confirmed, no aborts | Operator |
| 5 | **Testnet verification** — exercise the real paths | every assertion in §5 passes | Operator |
| 6 | Post-testnet security review of the recorded evidence | Lead sign-off | Lead |
| 7 | Mainnet deploy from a reviewed plan | txids recorded | Operator |
| 8 | Repo's localized copy updated in the **same** change | `canonical-copy-drift` + `mainnet-fidelity` green | Lead |

Step 8 is not bureaucracy. Skipping it is precisely what produced finding **F-7**:
`contracts/test/flashstack-stx-core.clar` drifted from the deployed contract and the
"deployed core" suite spent weeks asserting the behavior of a contract that does not
exist on mainnet.

---

## 3. Operator setup (one-time)

The operator holds the testnet key. **The Security & Contract Lead does not need it,
must not be given it, and must never be sent a mnemonic, seed phrase or private
key.** Testnet STX is valueless faucet currency, but the habit matters: the same
procedure with `TESTNET_` swapped for `MAINNET_` moves real funds.

1. **Create a fresh wallet.** Use a wallet that can produce a 24-word Stacks
   mnemonic — the Leather browser extension, or Xverse. Create a **new** wallet used
   only for testnet staging. Never reuse a wallet that has ever held mainnet funds.
2. **Switch the wallet to testnet.** Leather: Settings → Change network → Testnet.
   The address changes prefix from `SP…` to `ST…`.
3. **Fund it.** <https://explorer.hiro.so/sandbox/faucet?chain=testnet> — 1000 STX
   per request. Run it **3–4 times**: publishing this many contracts plus funding a
   reserve costs more than a single grant covers.
4. **Confirm the balance** before deploying:
   ```bash
   curl -s https://api.testnet.hiro.so/extended/v1/address/<ST-ADDRESS>/balances \
     | python3 -m json.tool
   ```
5. **Never commit the mnemonic.** Pass it per-invocation, from the shell, and let it
   leave no trace in history:
   ```bash
   read -rs TESTNET_MNEMONIC && export TESTNET_MNEMONIC   # leading space, not echoed
   ```
   `settings/Testnet.toml` is gitignored; `settings/Testnet.toml.example` is the
   committed template. Keep it that way.

---

## 4. What exists today, and what does not

### Exists

`scripts/deploy-testnet.mjs` (393 lines) is real and works. It derives the key from
`TESTNET_MNEMONIC`, rewrites mainnet principals to the testnet deployer, publishes in
dependency order waiting for each confirmation, then whitelists a receiver, funds the
reserve, seeds the receiver and executes a live flash loan — producing testnet txids
as evidence. It is a sound template.

### Does not exist

**It targets the previous generation.** Its deploy list is
`stx-flash-receiver-trait`, `flashstack-stx-core`, `flashstack-stx-pool`,
`flashstack-pool-oracle`, `stx-test-receiver` — none of the contracts this gate is
meant to protect.

Nothing in `scripts/` or `deployments/` targets `flashstack-pool-v3` or any v3/v2
successor. Both committed testnet plans are gen-1: `deployments/testnet-plan.yaml`
names `ST2X1GBHA2WJXREWP231EEQXZ1GDYZEEXYRAD1PA8`, which has **zero transactions** on
testnet, and `deployments/default.testnet-plan.yaml` names the well-known Clarinet
default deployer, whose two testnet contracts belong to unrelated third parties. Both
reference `snp-flashstack-receiver`, whose source was not in this repo when this was written (**D7**, closed 2026-09-21: now committed verbatim).

---

## 5. Three things that had to be solved before the current generation could be staged

> **All three are now resolved (2026-09-17).** Kept in full rather than deleted: each
> records a real constraint an auditor or future maintainer will otherwise re-derive.

These are **open technical questions**, recorded rather than guessed. Each is a real
blocker found by reading the contracts, not a hypothetical.

### 5.1 The address patcher is incomplete

`deploy-testnet.mjs` rewrites exactly two principals:

```js
const MAINNET_ADDRS = [
  "SP3TGRVG7DKGFVRTTVGGS60S59R916FWB4DAB9STZ",
  "SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5",
];
```

The current generation references **three more** that it would silently leave
unpatched — so the publish would abort on testnet with an unresolved contract:

| Principal | Referenced by | Nature |
|---|---|---|
| `SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard` | `flashstack-pool-v3`, `flashstack-v3-receiver-trait` | The SIP-010 standard trait. Exists on testnet at a **different** principal — must be remapped, not rewritten to the deployer. |
| `SPR9PQANV6XHSDNRAX2GNKCA5Z1KH61961KE0BYG.flashstack-v3-receiver-trait` | `flashstack-pool-v3` | Our own trait. Rewrites to the deployer correctly, but only if the address is added to the list. |
| `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token` | `flashstack-sbtc-core-v2`, `flashstack-sbtc-pool-v3` | Canonical sBTC — see 5.2. |

**Decision needed:** the patcher must distinguish *rewrite-to-deployer* (our own
contracts) from *remap-to-testnet-equivalent* (a third-party dependency).

**Narrowed 2026-09-17.** Testnet has been regenesised — burn height is only 17,656 —
so **no third-party mainnet infrastructure can be assumed present**. Probing the
usual addresses for a canonical `sip-010-trait-ft-standard` on testnet returned 404 /
invalid-address. That is not a problem: the repo already carries its own copy at
`contracts/test/sip-010-trait-ft-standard.clar`, so the trait should simply be
**published by us as the first contract in the plan** and rewritten to the deployer
like everything else we own.

Net effect: §5.1 collapses to adding `SP3FBR2AGK5H9…` and `SPR9PQAN…` to the patch
list and publishing our trait copy first. The only dependency with **no** testnet
substitute is canonical sBTC — which is §5.2, and is a genuinely different problem.

### 5.2 ~~The sBTC contracts cannot be staged faithfully~~ — RESOLVED 2026-09-17

The original concern was that canonical sBTC (`SM3VDXK3…sbtc-token`) is mainnet-only,
so staging `flashstack-sbtc-core-v2` / `flashstack-sbtc-pool-v3` would require a mock
— meaning the bytes staged are not the bytes shipped, which destroys the value for
exactly the integration risk being tested.

**A real sBTC deployment exists on testnet, and its source is byte-identical to
mainnet.** Verified read-only; nothing deployed:

`ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM` carries the complete sBTC contract set,
and every contract matches mainnet exactly (SHA-256 over
`/v2/contracts/source`, both chains):

| Contract | Bytes | Result |
|---|---|---|
| `sbtc-token` | 4,759 | **identical** (`sha256 8f0a0edd…`) |
| `sbtc-registry` | 11,209 | **identical** |
| `sbtc-deposit` | 4,151 | **identical** |
| `sbtc-withdrawal` | 12,264 | **identical** |
| `sbtc-bootstrap-signers` | 5,801 | **identical** |

`sbtc-token`'s only internal dependency is `.sbtc-registry`, which is present and
also identical. A live `get-decimals()` read returns `(ok u8)`, matching mainnet — so
`share-scale` calibration (pv3-F2) would be exercised against the real value.

**Consequence:** staging the sBTC line is a *faithful* stage, not a mock-backed one.
The localizer maps `SM3VDXK3…` to this principal rather than to a hand-written mock.

**One caveat to record rather than gloss.** That address is the well-known Clarinet
default deployer, whose key is public. The *code* is provably canonical; the
*deployment* is not authoritative, and anyone can exercise its protocol roles. On
testnet that is acceptable — no value is at stake and the point is integration
mechanics, not custody — but the evidence should say "staged against a byte-identical
sBTC deployment at the public Clarinet deployer address", never "staged against
canonical sBTC".

**Resolved 2026-09-18 — obtain it by plain SIP-010 `transfer`, not by minting.**
Read-only investigation; nothing deployed, no key used.

`protocol-mint` is unreachable for us, and confirming *why* matters more than the
conclusion: it asserts `sbtc-registry.is-protocol-caller` on **`contract-caller`**,
and the registry seeds only three roles — `.sbtc-deposit` (mint), `.sbtc-withdrawal`
(burn), `.sbtc-bootstrap-signers` (governance). `update-protocol-contract` itself
requires the governance role, so the set cannot be extended from outside. Going
through the front door instead, `sbtc-deposit.complete-deposit-wrapper` asserts
`tx-sender` equals the registry's current signer principal, live-read as
`SN35NB5S0NFPMSDNFHHJFK7AMZ750J58H7VTA7G6R` — not us. Confirmed directly:
`is-protocol-caller(deposit-role, ST1PQHQ…)` returns `(err u400)`.

None of that is needed, because **the balance already exists**. Live reads:

| | |
|---|---|
| `get-total-supply` | `u2100000000000000` = **21,000,000 sBTC** |
| `get-balance(ST1PQHQ…)` | `u8000000000` = **80 sBTC** |

`transfer` authorises on `(is-eq tx-sender sender)`, so whoever signs as `ST1PQHQ…`
can send sBTC to the staging deployer with an ordinary SIP-010 transfer. That key is
the public Clarinet default mnemonic, so this is available to anyone — which is the
point, and also the caveat.

**What this sharpens about §5.2's caveat.** A 21,000,000 sBTC supply — the entire
Bitcoin supply, pre-minted — is not how sBTC behaves anywhere real. This deployment
is a **test fixture** that happens to use byte-identical contract code, not a live
sBTC protocol instance. The distinction matters for what a staging run can claim:

- **Faithful**, because the code is byte-identical: trait resolution, SIP-010
  conformance, `get-decimals` = 8, transfer semantics, post-conditions, and
  therefore pool-v3's `share-scale` calibration (pv3-F2).
- **Not faithful**: deposit/withdrawal flows, signer attestation, realistic supply
  or balance distribution. A staging run must not claim to have exercised those.

Also: the 80 sBTC sits at a key anyone holds, so the balance can vanish between runs.
Treat funding as a step in the procedure, not a precondition to assume.

**Superseded 2026-10-14 — switched to a second, better deployment.** Found while
funding the pool-v3 staging deployer (section 8 action 9): a real SIP-010 transfer of
testnet sBTC landed on `SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token`, not on
`ST1PQHQ…`. Investigated rather than assumed, same discipline as the rest of this
section:

- **All five contracts of the set re-verified byte-identical** to mainnet at this new
  address too — same SHA-256 hashes, same byte counts as the `ST1PQHQ…` table above.
- **This one looks like the real thing, not a test fixture.** `get-total-supply` reads
  `u3611904974` (~36.1 sBTC) — a plausible, organically-grown figure, not `ST1PQHQ…`'s
  21,000,000 sBTC pre-mint (the entire Bitcoin supply, artificial by inspection).
  `get-current-signer-principal` resolves to a real testnet **multisig** principal
  (version byte 21, `SN…` prefix), consistent with an actual bridge signer set rather
  than a bootstrap placeholder. The registry exposes
  `get-current-aggregate-pubkey`/`get-current-signer-data`/`get-current-signer-set` —
  the real signer-management surface, present and apparently live.
- **It is not a stockpile.** The contract's own principal holds zero — balances sit on
  individual holders via `protocol-mint`, the way a real bridge actually works, not
  pooled at the deployer for easy test distribution. A working transfer has to come
  from some address that already holds a balance. One such address,
  `STDMN71Z0H9EF8CRKAWTGBB5YS0BNV26HZ79QFFP`, holds ~2.03 sBTC and ~991.7M testnet STX
  across 4,578+ transactions, consistent with a distributor or faucet — **not**
  independently confirmed as one; record what's verifiable, not a guess about who runs
  it.
- **Not independently confirmed:** who operates this deployment, or whether it's
  connected to a real Bitcoin-testnet bridge rather than another (better-built)
  fixture. The evidence above is suggestive, not proof — record it as that.

`scripts/lib/testnet-localize.mjs`'s `TESTNET_EQUIVALENT` entry and
`scripts/deploy-testnet-pool-v3.mjs` both now point at
`SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1`. `ST1PQHQ…`'s deployment is untouched and
still holds its own balance — nothing about it was wrong, it simply stopped being the
more useful of two valid choices. Same caveat as before, updated: evidence should read
"staged against a byte-identical sBTC deployment at
`SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1`", never "staged against canonical sBTC" or
"the official testnet bridge" — this project has not independently confirmed who
operates it.

### 5.3 ~~`flashstack-pool-v3` needs epoch 4.0 on testnet~~ — RESOLVED 2026-09-17

**Testnet accepts Clarity 6. `flashstack-pool-v3` can be staged.** Verified by
public read-only API, no deployment:

- **Testnet is past Epoch 4.0.** `GET /v2/pox` lists `Epoch40` at `start_height
  2702`; current burn height is **17,656**. Node reports `stacks-node 4.0.1`.
- **Clarity 6 publishes actually succeed.** Across 400 recent testnet
  contract-deploy transactions: **64 at `clarity_version = 6`, all `success`, and
  zero `abort_by_response` at that version.** (Every other version has failures —
  cv3 70, cv4 41 — so this is not a quiet-period artifact.) Example:
  `ST1M193TGQK6DZ958F9YT51AD756E6GN26PHS798Q.counter`, block 395,236.
- **The specific primitives pool-v3 depends on are live**, not merely the version
  number: `as-contract?`, `current-contract` **and** `with-ft` all appear in
  successfully-deployed testnet contracts (e.g.
  `ST23DXFQJVPA735K0HWRYFS6EF8BHJ2ENSZ3NNNMC.stackspot-sponsor`). This is the part
  that mattered — §11 records that `as-contract` is a hard error from Clarity 4, so
  version acceptance alone would not have proven the replacement forms work.

No action needed. This blocker is closed.

---

## 6. Verification checklist (step 5 of the gate)

A testnet deploy that only proves "the publish confirmed" has not tested anything the
simnet suite did not already cover. Record a txid for each:

**Per contract published**
- [ ] Publish transaction is `success`, not `abort_by_response`
- [ ] Source fetched back from `/v2/contracts/source/<addr>/<name>` matches the
      submitted source modulo address localization — the same rule
      `tests/canonical-copy-drift.test.ts` enforces in-repo
- [ ] `/v2/contracts/interface/…` exposes the expected public functions, and **does
      not** expose any it shouldn't (this is what would have caught F-7)

**Per pool / core**
- [ ] `deposit` succeeds and credits the expected shares
- [ ] `withdraw` returns the expected amount and **still works while paused** (LP exit
      is never gated)
- [ ] `deposit` is **rejected** while paused (pv3-F3)
- [ ] Flash loan happy path: reserve grows by exactly the fee
- [ ] Flash loan with a non-repaying receiver: whole transaction reverts, reserve
      untouched — the solvency invariant, against a real token, on a real chain
- [ ] Unapproved receiver is rejected
- [ ] Two-step admin: `transfer-admin` does **not** change admin; `accept-admin` from
      a non-pending principal fails; the original admin retains control throughout
      (BC1)

**`flashstack-pool-v3` only**
- [ ] `add-asset` derives `share-scale` from a live `get-decimals()` (pv3-F2) — assert
      the actual value, not just success
- [ ] Same-asset reentrancy during a flash-loan callback reverts with `ERR-REENTRANT`
      u815 (pv3-F1)
- [ ] A **different**-asset flash loan inside a callback still succeeds — the lock is
      per-asset by design and must not have become global
- [ ] Oracle reads for a never-listed token return `ERR-NOT-LISTED`, not a
      plausible-looking default

**Recorded output**
- [ ] Every txid written into `deployments/` alongside the plan that produced it
- [ ] Contract addresses, block heights, and the commit SHA staged

---

## 6a. First testnet run — 2026-09-18

`scripts/deploy-testnet.mjs` run against `flashstack-stx-core-v2` + `stx-test-receiver-v2`
(#56). Deployer: `ST3XQ5DMH4BRXVZWAHKJFBNND17CPCSAYMV4T0NFT`. Every item below was
independently re-verified against the live testnet API after the run, not taken from
the script's own success output.

**Proven, with evidence:**
- [x] All three publishes `success`: [`stx-flash-receiver-trait`](https://explorer.hiro.so/txid/5949a87346009951f1975a52bd59f92e32934d2371a667ca31aa77c85da769e4?chain=testnet), [`flashstack-stx-core-v2`](https://explorer.hiro.so/txid/fe11c31edcaf368f8b9e0efc3447565ce2509793e243145e4a6295c901462209?chain=testnet), [`stx-test-receiver-v2`](https://explorer.hiro.so/txid/d81602ea5785eb2983894474da28d03b9f9fd5ec0a0070ad834d958f6b5a2d90?chain=testnet)
- [x] Source fetched back from `/v2/contracts/source/…` for `flashstack-stx-core-v2`
      matches `localize(local-source, deployer)` **exactly** — byte-for-byte
      comparison, not eyeballed
- [x] Flash loan happy path: reserve went from `50,000,000` (post-fund) to
      `50,005,000` post-loan — **exactly** the 0.05% fee on a 10 STX loan (5,000
      µSTX), read back and decoded from `get-reserve-balance`, not assumed.
      [Evidence tx](https://explorer.hiro.so/txid/6edae18d820a4819178d22634351273e9d59015d2735fd312cef006992aa208d?chain=testnet)
- [x] Two-step admin happy path: [`transfer-admin`](https://explorer.hiro.so/txid/23c454f6030b86a94d450ce4e20fd62585a2d82ae87f7f5f5081a1ec0bdab9f2?chain=testnet)
      (propose to self) then [`accept-admin`](https://explorer.hiro.so/txid/b8f7fdffcdc60728d79272421537d5495ea1bd85f6b3ff335bbdc04d0951b414?chain=testnet)
      both `success`; `get-admin` decodes to `(ok ST3XQ5DM…)`, confirmed against
      the deployer, not just a non-error response
- [x] Interface check: public and read-only function sets on the deployed
      `flashstack-stx-core-v2` match the local source exactly, in both
      directions — 10 public, 8 read-only, zero unexpected on-chain functions.
      `transfer-admin` and `accept-admin` both present, confirming the BC1
      shape on chain. This is the check that would have caught F-7 had it
      existed then. (Verified independently on review, not part of the
      original run.)

**NOT proven by this run — genuinely open, not implied by the above:**
- [ ] Flash loan with a non-repaying receiver reverts
- [ ] Unapproved receiver is rejected
- [x] ~~**The actual negative case BC1 exists to prevent**~~ — proven separately,
      with a second key. See §6b.
- [ ] Recorded in `deployments/` alongside a plan file; block heights not
      captured

**Note on staleness:** this run predates `a92fb8e` (the fix landed on #56
after this evidence was recorded). It used the *old* Step 8 — propose-to-self
then accept, with no read-only assertions — not the corrected sequence that
proposes to a principal the key doesn't control and asserts `get-admin`
unchanged in between. The two-step admin happy-path evidence above still
holds (both txs did succeed and the end state is correct), but it does not
carry the assertion strength `a92fb8e` added. **A re-run against the current
script is required before this document can be treated as current BC1
evidence, not optional.** (§6b below proves the negative case with a
different, purpose-built script — it does not substitute for this re-run.)

---

## 6b. BC1 negative-path proof — 2026-09-18

`scripts/deploy-testnet-bc1-negative.mjs`, a second, purpose-built script —
not `deploy-testnet.mjs` — run against the already-deployed
`flashstack-stx-core-v2` from §6a. Two independent keys: the original
deployer `ST3XQ5DMH4BRXVZWAHKJFBNND17CPCSAYMV4T0NFT` (current admin) and a
freshly generated, faucet-funded second wallet
`ST2YZPFDGFZH37GTRG2RA7WME4QWTC3KNAP1SB96D`. Every item below was
independently re-verified against the live testnet API — sender, function,
args, and result decoded from each tx directly, plus a fresh `get-admin` /
`get-pending-admin` read after the run — not taken from the script's own
console output.

**Proven, with evidence:**
- [x] `transfer-admin` (deployer proposes second key):
      [`4a9f4aad…`](https://explorer.hiro.so/txid/4a9f4aad4955898999f07427d64238c3775cc6e0abe7fcf5576b87d8f8b6b2e2?chain=testnet)
      `success`, `(ok true)`, block 409791. Confirmed `get-admin` unchanged
      (deployer) and `get-pending-admin` = `(some ST2YZPFDGFZH…)` immediately
      after.
- [x] **The negative case itself**: deployer — the *old* admin, not the
      pending one — calls `accept-admin`:
      [`9107e675…`](https://explorer.hiro.so/txid/9107e6752e467ab16fb8d09888fc2684d63fb8ed15ca827381c81f1284dbd3ef?chain=testnet),
      block 409793. `tx_status` is `abort_by_response`, `tx_result` is
      `(err u309)` — `ERR-NOT-PENDING-ADMIN`, read directly from
      `contracts/flashstack-stx-core-v2.clar:40`, not a generic failure.
      `get-admin` re-checked immediately after: still the deployer, confirming
      the rejected call had zero effect on state. This is `accept-admin` from
      a non-pending principal actually failing on-chain, not merely untried.
- [x] Legitimate acceptance: the second key — the real pending admin — calls
      `accept-admin`:
      [`aa6f8a14…`](https://explorer.hiro.so/txid/aa6f8a145503e99a4daa2cad54bfc0acc4ee18424fbcbbf5db92b13b79283775?chain=testnet),
      block 409795, `success`, `(ok true)`. `get-admin` re-checked: now the
      second key — authority genuinely moved, from the correct caller only.
- [x] State restored: second key proposes back to the deployer
      ([`79b759e3…`](https://explorer.hiro.so/txid/79b759e381a04b569bc38486e27d2b00fe7bc281d949e0072252e2711a79bfe9?chain=testnet),
      block 409796), deployer accepts
      ([`d6c8e7aa…`](https://explorer.hiro.so/txid/d6c8e7aa02df47a4f2ab6d159b30afc3ca9ad4b412d36676373fda7d17de72d1?chain=testnet),
      block 409799). Final state independently re-read post-run: `get-admin`
      decodes to the original deployer, `get-pending-admin` decodes to
      `none` — the contract is back exactly where it started, so later runs
      and this document can keep assuming the deployer is admin.
- [x] Block ordering coherent throughout (409791 → 409793 → 409795 → 409796
      → 409799), sender on each tx matches the principal the step claims made
      the call.

**Still open:** this proves the negative case for `flashstack-stx-core-v2`
only. The v3-track successors (`flashstack-stx-pool-v3`,
`flashstack-sbtc-pool-v3`, `flashstack-sbtc-core-v2`) share the same
`transfer-admin`/`accept-admin` shape but are unstaged and untested — this
result doesn't extend to them automatically.

---

## 6c. §6a re-run — PREPARED, NOT EXECUTED

> **This section contains no evidence.** It is a form. Every value in the block
> below is a placeholder, and the checkboxes are inside a fenced code block
> precisely so they cannot be read as ticked. Nothing here has happened.

§6a's BC1 rows come from the *pre-`a92fb8e`* Step 8 — propose-to-self, then
accept, with no read-only assertions — and §6a says outright that a re-run
against the current script is required, not optional. §6b proves the negative
case with a second key and explicitly does not substitute. The current Step 8
(`scripts/deploy-testnet.mjs:354-405`) proposes to `ST1PQHQ…`, a principal the
signing key does not control, and asserts `get-admin` is **unchanged** in
between — the one assertion that distinguishes a correct two-step contract from
a broken one-step one. That is what has to be run.

**The plan it runs is now written**: `deployments/testnet-current-gen-plan.yaml`
— contract set, order, fees, nonce discipline and arguments, each field
referenced back to the line of `deploy-testnet.mjs` it was read off, with empty
`evidence:` slots to fill.

### The execution decision — made: route A

Live read of the §6a deployment on 2026-09-21 (sender `ST3XQ5DM…`): `get-admin`
= the deployer, `get-pending-admin` = `none`, `get-reserve-balance` =
`u50005000`, `is-approved-receiver` = `true`, deployer nonce 12, balance
`946490000` µSTX. The deployment is intact and §6b's restore held.

So Steps 1–3 of the plan would publish contract names that **already exist** at
that address, and a name is consumed permanently there whether or not the
publish took effect (`CONTRACT_INVENTORY` §3, deployment scars). Two routes:

| | Route | Cost | What it needs first |
|---|---|---|---|
| **A** ✅ | Admin steps only, against the existing deployment | 300,000 µSTX | **Chosen.** Needed step selection, which `--steps=admin` now provides (PR #66). Note it is a run of `deploy-testnet.mjs`'s own Step 8 path — extracted, not copied — but not of the *whole* script; `Flashstack-ajv.6.3`'s acceptance criterion was amended to say so. |
| **B** ❌ | A fresh `-v3` line, full 10-step run | 53.31 STX | **Not a rename in the script.** `contracts/stx-test-receiver-v2.clar:16` calls `.flashstack-stx-core-v2` statically, so a `-v3` core needs a `-v3` receiver source too — new `.clar` files and a wider diff than this evidence gap warrants. **Parked:** staging `flashstack-stx-pool-v3` is worth more than a `-v3` rename. |

**Decided 2026-09-21: route A.** §6b already proves the property on this
deployment, so the gap is assertion strength on the positive path, not a
deployment — and B would rewrite contracts to fix a documentation problem.
`deploy-testnet.mjs --steps=admin` (PR #66) runs Step 8 and nothing else, and
refuses unless the contract exists, admin is the signing deployer and
pending-admin is `none` (`scripts/lib/testnet-preconditions.mjs`). Steps 1–7 of
the plan file below therefore stay unexecuted for this line; only the 8a/8b/8c
`evidence:` slots get filled.

### Drop-in replacement for §6a

On a successful run, this replaces §6a in full — including deleting §6a's
staleness note, which no longer applies — and §6c goes away with it.

```markdown
## 6a. Testnet run — <DATE>

`scripts/deploy-testnet.mjs` at `<COMMIT-SHA>` run against `<CONTRACT-SET>`.
Deployer: `<DEPLOYER>`. Plan: `deployments/testnet-current-gen-plan.yaml`.
Every item below was independently re-verified against the live testnet API
after the run — sender, function, args and decoded result read off each tx —
not taken from the script's own success output.

**Proven, with evidence:**
- [ ] All three publishes `success`: trait `<TXID-1>` (block `<H>`), core
      `<TXID-2>` (block `<H>`), receiver `<TXID-3>` (block `<H>`)
- [ ] Source fetched back from `/v2/contracts/source/…` for `<CORE>` matches
      `localize(local-source, deployer)` byte-for-byte — compared, not eyeballed
- [ ] Interface check: public and read-only function sets on the deployed
      `<CORE>` match the local source in both directions — `<N>` public,
      `<M>` read-only, zero unexpected on-chain functions. This is the check
      that would have caught F-7.
- [ ] Flash loan happy path: reserve `<BEFORE>` → `<AFTER>`, exactly the 0.05%
      fee (5,000 µSTX on a 10 STX loan at `fee-bp` = `u5`), decoded from
      `get-reserve-balance`, not assumed. `<TXID-7>` (block `<H>`)
- [ ] **BC1 with assertion strength** — the corrected Step 8 (`a92fb8e`),
      proposing to a principal this key does not control:
  - [ ] `transfer-admin` → `ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM`:
        `<TXID-8a>` (block `<H>`), `success`
  - [ ] `get-admin` read immediately after: **still `<DEPLOYER>`** — admin did
        not move on propose. *This is the assertion the pre-fix run could not
        make: propose-to-self leaves admin equal to the deployer either way.*
  - [ ] `get-pending-admin` = `(some ST1PQHQ…)` — the proposal landed, and
        landed on someone else
  - [ ] `transfer-admin` → self (re-propose): `<TXID-8b>` (block `<H>`);
        `get-pending-admin` = `(some <DEPLOYER>)` — the earlier proposal was
        overwritten, so a mis-addressed proposal is recoverable before anyone
        accepts it
  - [ ] `accept-admin`: `<TXID-8c>` (block `<H>`), `success`; `get-admin` =
        `<DEPLOYER>`, `get-pending-admin` = `none`
- [ ] Recorded in `deployments/testnet-current-gen-plan.yaml`: every
      `evidence:` slot filled with txid, block height and status, alongside the
      commit SHA staged

**NOT proven by this run — genuinely open, not implied by the above:**
- [ ] Flash loan with a non-repaying receiver reverts — receiver now written:
      `contracts/stx-underpay-receiver-v2.clar` repays 1 µSTX short and is
      proven in simnet (`tests/stx-core-v2-underpay.test.ts`: `err u302`,
      reserve read back unchanged). Still not run on testnet: it has to be
      published, whitelisted, funded with a buffer ≥ the fee, then borrowed
      against, with `get-reserve-balance` read back afterwards
- [ ] Unapproved receiver is rejected — needs no new contract, but no step in
      the plan performs it
- [x] ~~The negative case BC1 exists to prevent~~ — proven separately with a
      second key. See §6b.
```

### Verification protocol for the filled-in version

Each txid is checked against `/extended/v1/tx/0x<txid>`: `tx_status`, `sender_address`,
`contract_call.function_name`, decoded `function_args`, `tx_result.repr`, and
`block_height`. Each state claim is a fresh `/v2/contracts/call-read` **after**
the run, decoded through `scripts/lib/testnet-readonly.mjs` — not the value the
script printed during it. A row whose evidence cannot be reproduced that way
does not get ticked.

## 6d. `flashstack-pool-v3` testnet run — SUCCESS 2026-10-14

`scripts/deploy-testnet-pool-v3.mjs` at `65e129b` (section 8 action 9), run against
`flashstack-pool-v3` + `pool-v3-test-receiver` (`flashstack-v3-receiver-trait` and
`sip-010-trait-ft-standard` already published from two earlier partial attempts the
same day — the script's own `deployIfNeeded` skipped republishing them, see below).
Deployer: `ST3XQ5DMH4BRXVZWAHKJFBNND17CPCSAYMV4T0NFT` (same identity as the STX
line's §6a/§6c runs). Plan: `deployments/testnet-pool-v3-plan.yaml`. Every item below
was independently re-verified against the live testnet API after the run — not taken
from the script's own console output.

**Getting here took three live-caught bugs, each fixed before the next attempt, not
guessed at in advance:**
1. `(err none)` on the very first publish (`flashstack-v3-receiver-trait`) — its
   `use-trait` resolves `.sip-010-trait-ft-standard` under this deployer, wrongly
   assumed already published from the STX line's own run (which publishes a
   *different* trait, `stx-flash-receiver-trait`, that never touches SIP-010).
   Confirmed via a live 404, fixed by adding the publish as a real step.
2. `(err none)` again, this time on `flashstack-pool-v3` itself — the deploy helper
   hardcoded Clarity 3 for every contract (copied from `deploy-testnet.mjs`, which
   never deploys a Clarity 6 contract). Confirmed on the actual broadcast
   (`clarity_version: 3`), fixed by passing `ClarityVersion.Clarity6` explicitly for
   this one contract.
3. `ContractAlreadyExists` on a from-scratch retry — the two already-confirmed trait
   publishes from attempt 2 can't be re-broadcast (deployment scars,
   `CONTRACT_INVENTORY.md` §3). Fixed by checking `contractExists()` before each of
   the four publishes and skipping (nonce untouched) if already there.

**Proven, with evidence (every txid `success`, independently re-checked against
`/extended/v1/tx/0x<txid>`):**
- [x] `flashstack-v3-receiver-trait` and `sip-010-trait-ft-standard` present at the
      deployer (both from an earlier partial attempt the same day; re-confirmed live
      via `/v2/contracts/interface/` returning `200`, not re-published this run)
- [x] `flashstack-pool-v3` publish: [`16b1e35e…`](https://explorer.hiro.so/txid/16b1e35eba85c4a71ee0e6afd4f6a389a82aad793abdf7498c0e3605c02bbb89?chain=testnet),
      block 723643, `(ok true)`
- [x] `pool-v3-test-receiver` publish: [`a8d869b3…`](https://explorer.hiro.so/txid/a8d869b3f1ab6b3ee065cf294854fe7ba13e31eaa484826c5366cd24682cd2d0?chain=testnet),
      block 723645, `(ok true)`
- [x] `add-asset` (sBTC, `fee-bp` 5, `max-loan` 100000 sats):
      [`33b15f69…`](https://explorer.hiro.so/txid/33b15f69bdf9c6b5538e70a84991936804d46caed41d43644db2296635b128b9?chain=testnet),
      block 723648, `(ok true)`. Re-read after: `is-listed` = `true`,
      `get-asset` = `{enabled: true, fee-bp: u5, max-loan: u100000, paused: false,
      share-scale: u100000000}` — `share-scale` = 1e8 confirms the live
      `get-decimals()` = 8 read against the real sBTC dependency (pv3-F2), not assumed
- [x] `add-approved-receiver`: [`d4cf646e…`](https://explorer.hiro.so/txid/d4cf646e1a50d095cbade5ca8055fdb617b74d37b0c5716066db817376f45edf?chain=testnet),
      block 723650, `(ok true)`. Re-read after: `is-approved-receiver` = `true`
- [x] `deposit` (10,000 sats): [`e73ee01f…`](https://explorer.hiro.so/txid/e73ee01fe8aff47a4924ae18f694d0d7b7556c093675bdc0103e5238da868c45?chain=testnet),
      block 723652, `(ok u1000000000000)` — 1e12 LP shares, exactly matching the
      virtual-shares formula for a first deposit (`amount * share-scale / VIRTUAL-ASSETS`
      = `10000 * 1e8 / 1`), not assumed
- [x] Receiver fee-buffer seed (100 sats): [`1afefb0a…`](https://explorer.hiro.so/txid/1afefb0ad09ada89b7ffd4899e084342af8b3a21cb6e76deac903823aebdc465?chain=testnet),
      block 723655, `(ok true)`
- [x] **Flash loan — THE testnet evidence**: [`de45aff4…`](https://explorer.hiro.so/txid/de45aff486db933ea4426c61b9b76e4d9f9e420a72c32eafa4e9348ec0d4734a?chain=testnet),
      block 723657, `(ok true)`. `get-reserve` before/after, read live: `u10000` →
      `u10001`, grew by exactly the 1-sat fee (`raw-fee = (2000 * 5) / 10000 = 1`,
      the `u0`-floor-to-`u1` path is not reached at this size). Receiver's own
      sBTC balance, read live: `99` sats — 100 seeded + 2,000 borrowed − 2,001 repaid,
      every sat accounted for, not just "the tx succeeded"
- [x] `get-asset` after the loan: `total-loans: u1`, `total-volume: u2000`,
      `total-fees: u1` — all three stats match the single loan above exactly

**NOT proven by this run — genuinely open, not implied by the above:**
- [ ] Non-repaying or under-paying receiver reverts — no such receiver exists for
      `flashstack-pool-v3` yet. `stx-underpay-receiver-v2.clar` (PR #110) is the
      precedent for `flashstack-stx-core-v2` only, not this contract.
- [ ] Unapproved receiver is rejected — needs no new contract, but no step here
      performs it
- [ ] Multi-asset behavior (a second listed asset, cross-asset flows, the per-asset
      reentrancy lock design doc section 13 describes) — this run lists exactly one
      asset (sBTC)
- [ ] `flashstack-stx-pool-v3` and `flashstack-sbtc-core-v2` — separate contracts,
      each needs its own receiver, deliberately not folded into this run (see
      `deploy-testnet-pool-v3.mjs`'s own header)

---

## 6e. `flashstack-stx-pool-v3` / `flashstack-sbtc-pool-v3` testnet plan — PLANNED, NOT EXECUTED

Flashstack-ajv.6.9. **Nothing here has run, and nothing may be broadcast until Matt
approves this plan.** The step-by-step plan, with every fee, amount, signer and
expected result, is `deployments/testnet-v3-pools-plan.yaml`. This section explains
the parts the YAML can't carry: what still has to be written, why the adversarial
receiver is safe to publish, and what promotion to mainnet needs.

### What this run proves that nothing else has

These two pools are the F-9 successors (`Flashstack-ajv.4.9`, #88). Their lock is
proven in simnet only (`tests/v3-pools-reentrancy-lock.test.ts`). On testnet, per
pool, this plan proves:
- an honest flash loan, with the exact fee landing in the pool
- a receiver that isn't approved is rejected (`ERR-NOT-APPROVED`)
- `max-single-loan` is enforced (`ERR-EXCEEDS-LIMIT`), then restored
- deposit-as-repayment and withdraw-reentry from the callback both fail with
  `ERR-REENTRANT` (u411 / u712) and change nothing
- under-repayment fails (`ERR-REPAY-FAILED`)
- the lock is released afterwards (an honest loan through the same receiver succeeds,
  and the receiver's seeded shares can be withdrawn outside a loan)
- pause blocks `deposit` and `flash-loan` but never `withdraw` (F-8)
- the two-step admin transfer, with a wrong-principal `accept-admin` rejected
  (`ERR-NOT-PENDING-ADMIN`, u410 / u711), using the same two keys as §6b

That also closes, for these two pools, the §6d items "under-paying receiver reverts"
and "unapproved receiver is rejected".

### Facts checked against source before writing the plan

| | `flashstack-stx-pool-v3` | `flashstack-sbtc-pool-v3` |
|---|---|---|
| Clarity version | 3 (`as-contract`, Clarinet.toml registration) | 3 |
| Two-step admin | `transfer-admin` :261 → `accept-admin` :270, `get-pending-admin` :337 | `transfer-admin` :252 → `accept-admin` :261, `get-pending-admin` :368 |
| Receiver trait | `stx-flash-receiver-trait` (gen-1 principal, localized to K1) — **already at K1** | `sbtc-flash-receiver-trait` (gen-2 principal, localized to K1) — **not at K1 yet, step P1** |
| Hardcoded token | none (native STX) | `SM3VDXK3…sbtc-token` ×12, localized to `SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1` |
| Pause gates | `deposit` :121, `flash-loan` :188; `withdraw` ungated | `deposit` :113, `flash-loan` :177; `withdraw` ungated |
| Defaults at publish | fee 5 bp, max loan 5,000 STX, not paused | fee 5 bp, max loan 0.1 BTC, not paused |

Both pools publish **unpaused**. That's safe on testnet: no receiver is approved
until step A6/B6, so `flash-loan` is unreachable, and an open `deposit` only lets
someone add their own testnet funds.

The three §6d lessons are built in:
- `sbtc-flash-receiver-trait` is published first (P1). It's the one `use-trait`
  target K1 doesn't have.
- The Clarity version is passed per contract. It's 3 for everything here.
- Every publish goes through `deployIfNeeded`, so a re-run skips names that already
  exist.

The sBTC line uses the corrected testnet sBTC (`SN3VMH…`, not `ST1PQHQ…`) and is
sized to the 9,900 sats K1 already holds, so no new manual sBTC transfer is needed.

### To be written before the run (needs Matt's approval)

1. **`contracts/stx-pool-v3-test-receiver.clar`** and **`contracts/sbtc-pool-v3-test-receiver.clar`**:
   honest receivers that have to pass `docs/security/RECEIVER_VETTING.md` in full.
   Unlike `stx-test-receiver-v2` and the simnet fixtures, they need:
   - **B4:** `(asserts! (is-eq contract-caller .flashstack-<x>-pool-v3) ERR-NOT-POOL)`
     as the first line of `execute-*-flash`, before the fee read. That's the ordering
     #118 fixed in the templates and that v5 still gets wrong.
   - **B5:** repayment goes to the constant `.flashstack-<x>-pool-v3`. The `core`
     argument is checked against it and never used as a destination. This is the
     same fix #112 applied to `pool-v3-test-receiver.clar`.
   - **C7:** owner-only `arm (amount)`. `execute-*-flash` asserts the armed amount
     equals the loan amount and clears it, so a stranger can't spend the fee buffer
     by naming the receiver (the CR-2 shape).
   - **D12:** the fee comes from the pool's own `get-fee-basis-points`. **D11:**
     repayment is a plain `stx-transfer?` or sBTC `transfer`.
   - **E17:** owner-only rescue to the owner. The owner is a constant (the deployer).
     There's no transfer function, so there's nothing to brick (E18 is N/A, stated
     in the vetting record).
2. **`contracts/stx-pool-v3-adversarial-receiver.clar`** and **`contracts/sbtc-pool-v3-adversarial-receiver.clar`**:
   the simnet `test-*-pool-v3-receiver-reentrant.clar` modes u0–u3, rebuilt with the
   same B4/B5/C7/E17 gates. Every function that changes state is owner-only:
   - `arm (mode amount)`: single-use, bound to the exact amount
   - `seed-deposit`
   - `exit`, which withdraws its own shares outside a loan
   - `rescue-*`

   Mode u4 (nested flash loan) is left out: the VM aborts it with `CircularReference`
   before the lock is reached, it's already pinned in simnet, and it would need a
   third receiver.
3. **Simnet copies.** Each new `contracts/` receiver also gets a localized
   `contracts/test/` copy that is registered and pinned by `canonical-copy-drift`.
   This is the #110/#112 pattern. Each one is an addition to the mainnet-plan guard's
   `KNOWN_TEST_PATHS` (31 → 35), the drift pair count (15 → 19), and, once #124 is
   merged, the contract-registry guard's `UNREGISTERED` table. The tests for these
   copies run against the canonical pool sources and fail if a guard is removed
   (RECEIVER_VETTING item 19).
4. **`scripts/deploy-testnet-v3-pools.mjs`**: copies `deploy-testnet-pool-v3.mjs`'s
   helpers as they are (`deployIfNeeded`, the explicit `clarityVersion`,
   `waitForConfirm`, `assertFullyLocalized`) and adds:
   - **dry-run by default.** It needs `--broadcast` to send anything.
   - **two signers.** K2's mnemonic goes in a separate env var and is used only for
     A35/A36/B35/B36.
   - **an `--line=a|b` switch**, so line B can't run on a partial line A.
   - **an `expect` assertion after every step**, checked against `tx_status`/`tx_result`
     from the API, not the script's own bookkeeping. On a mismatch it pauses and stops,
     per the YAML's `stop-rules`.

### Why the adversarial receiver is safe to publish, even on testnet

It deliberately breaks RECEIVER_VETTING item 13 ("no reentry"). That is the point:
it's the only way to prove the lock on chain. The exception is bounded in four ways:
- **It targets only the locked pools.** Its pool principal is the relative name
  `.flashstack-<x>-pool-v3`, which resolves only to K1's v3 pool, and that pool
  carries the F-9 lock. It can't name the live, unlocked v2 pools, so the repo never
  holds a working exploit against a funds-bearing contract.
- **Nobody but its owner can trigger it.** With the `contract-caller` gate and
  owner-only arming, a stranger can neither call the callback directly nor start a
  loan that runs a mode.
- **It's approved only for the run.** It's approved at A14/B14 and removed at
  A26/B26, rescued to zero at A27/B27, and the removal is read back. Its vetting
  record names the item-13 exception and the removal txid.
- **It's testnet-only by construction.** The `contracts/test/` copy is in the
  mainnet-plan guard's known test set, and the canonical file is never registered.
  An `apply --mainnet` can't publish it (D6/ajv.6.6), and it holds only testnet
  funds.

If the lock were missing, the run would show it as a *successful* A18/B18. The stop
rules treat that as a security finding: pause, stop, report.

### Evidence (to be filled from the run)

Use §6d's format: every txid re-checked against `/extended/v1/tx/0x<txid>`. For each
expected failure, record `tx_status: abort_by_response` with the exact `tx_result`
code, and read the state back before and after to show nothing changed. Record
source hashes (`deployed` vs `localize(repo@<sha>)`) for every publish, and the
final state: admin K1, no pending admin, unpaused, adversarial receiver removed with
balance 0.

### Promotion to mainnet (same bar as this cycle)

Testnet success here is necessary but not sufficient. Before either pool goes to
mainnet:
- Matt independently reproduces the run's key results before merge.
- The mainnet deploy script is dry-run by default and hard-checks that the signing
  key matches the expected deployer.
- Every mainnet step is read back on chain.
- The deployed source is diffed against the reviewed commit.
- Each mainnet receiver gets its own vetting record before `add-approved-receiver`.
- The target admin is `SPR9PQAN…` (or its hardware-wallet successor), handed over
  with `transfer-admin` → `accept-admin`, never assumed.
- Never `clarinet deployments apply --mainnet` from this repo
  (`deployments/README.md`, D6/ajv.6.6).
- The v2 → v3 LP migration path (`Flashstack-ajv.4.4`) has to be decided first.
- Two findings outside this plan apply before mainnet: sbtc-pool-v3's
  `get-share-price` has the F-11 scaling gap (`Flashstack-ajv.3.4`, #123). Rescale it
  before mainnet, or accept and document it. If it's rescaled, this plan runs against
  the rescaled source.

---

## 7. What is deliberately not in this document

Fees, nonce handling and batch ordering are **not** specified here. They should be
derived from `scripts/deploy-testnet.mjs`, which already handles them correctly
against a real chain, rather than invented in prose. Writing plausible-looking
operational numbers that have never been executed would be worse than leaving the gap
visible.

A deployment plan for the current generation **is** now committed, at
`deployments/testnet-current-gen-plan.yaml` — §5.1–5.3 are all resolved, so the
precondition for writing one is met. It derives every fee, nonce and ordering
decision from `scripts/deploy-testnet.mjs` with per-field line references, rather
than restating them here. It is deliberately **not** a Clarinet plan and must not
be run with `clarinet deployments apply`: Clarinet publishes source verbatim, which
would broadcast contracts still carrying mainnet principals (§5.1).

---

## 8. Next actions

| # | Action | Blocked on |
|---|---|---|
| 1 | ~~Confirm testnet epoch/clarity-version support for pool-v3 (§5.3)~~ | **DONE 2026-09-17 — testnet accepts Clarity 6** |
| 2 | ~~Decide the sBTC mock question (§5.2)~~ | **DONE 2026-09-17 — byte-identical sBTC exists on testnet; no mock needed** |
| 3 | ~~Extend the patcher (§5.1)~~ | **DONE — PR #55**, `scripts/lib/testnet-localize.mjs` |
| 4 | ~~Map `SM3VDXK3…` → `ST1PQHQ…` in the localizer and move it from `THIRD_PARTY` to a new `TESTNET_EQUIVALENT` set~~ | **DONE — PR #55**, `TESTNET_EQUIVALENT` in `scripts/lib/testnet-localize.mjs` |
| 5 | ~~Determine how the deployer obtains a testnet sBTC balance~~ | **DONE 2026-09-18 — SIP-010 `transfer` from `ST1PQHQ…`, which holds 80 sBTC. Minting is unreachable and unnecessary (§5.2)** |
| 6 | ~~Write `deployments/testnet-current-gen-plan.yaml`~~ | **DONE 2026-09-21** — written from `deploy-testnet.mjs`, `evidence:` slots empty pending a run |
| 7 | Execute the stage and record evidence | A funded testnet deployer — **operator only** |
| 8 | Re-run §6a against the corrected Step 8 (`a92fb8e`) | **Route A chosen**; `--steps=admin` in PR #66. Then a funded key — operator only |
| 9 | ~~Write a receiver + deploy script + plan for `flashstack-pool-v3`~~ | **DONE 2026-10-14** — `contracts/pool-v3-test-receiver.clar` (+ localized copy, D6 shape — its `execute-flash` takes `<sip-010-trait>` as a parameter, which needs the same canonical/contracts-test pairing `flashstack-pool-v3` itself uses), `scripts/deploy-testnet-pool-v3.mjs`, `deployments/testnet-pool-v3-plan.yaml`. `clarinet check` and the full suite both pass with the new files. |
| 10 | ~~Execute the pool-v3 stage and record evidence~~ | **DONE 2026-10-14 — see §6d.** Operator-run; three live-caught bugs fixed across three attempts (missing trait publish, wrong Clarity version, deployment-scar resumability), fourth attempt succeeded end to end. All 7 new txids independently re-verified, state reconciles exactly (reserve, receiver balance, loan/volume/fee stats). |
| 11 | Plan the `flashstack-stx-pool-v3` / `flashstack-sbtc-pool-v3` stage | **PLANNED 2026-10-15 — §6e**, `deployments/testnet-v3-pools-plan.yaml` (ajv.6.9). Awaiting Matt's review |
| 12 | Write the four receivers (+ simnet copies, guard updates) and `scripts/deploy-testnet-v3-pools.mjs` per §6e | Matt's approval of #11 |
| 13 | Execute the v3-pools stage and record evidence in §6e | #12 merged, then a funded K1 + K2 — **operator only** |

**All three original blockers are closed, and `flashstack-pool-v3` is now staged on
testnet with real, independently-verified evidence (§6d) — not just "stageable."**
Still open for this line: the two §6d "not proven" items (non-repaying/under-paying
receiver, unapproved receiver, multi-asset behavior), and `flashstack-stx-pool-v3` /
`flashstack-sbtc-core-v2` remain entirely unstaged, each needing its own receiver.
None of this needs an owner decision — it's further execution, not a question.
