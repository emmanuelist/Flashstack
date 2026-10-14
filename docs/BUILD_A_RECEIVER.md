# Build a FlashStack Receiver

**For:** Stacks developers who want to write a custom flash loan strategy  
**Network:** Stacks Mainnet  
**Time:** ~30 minutes to deploy a working receiver

---

## What Is a Receiver?

A receiver is a Clarity smart contract that implements a single callback function. When you call `flash-loan` on FlashStack, the protocol sends STX (or sBTC) to your receiver contract and immediately calls your callback. Inside the callback, your contract executes any strategy — a DEX swap, a liquidation, a collateral swap, anything — and then repays principal + fee before returning. If repayment fails, the entire transaction reverts automatically. No partial execution is possible.

```
You → flashstack-stx-core.flash-loan(amount, receiver)
         ↓
      STX sent to receiver
         ↓
      receiver.execute-stx-flash(amount, core) ← your strategy runs here
         ↓
      receiver repays principal + 0.05% fee
         ↓
      core verifies repayment → success or full revert
```

Zero capital required for a **profitable** strategy — the arb or liquidation profit covers the fee, and if the strategy produces a loss the transaction reverts (you lose only the ~0.001 STX network fee). One subtlety to know before you deploy, though: your receiver must be holding `amount + fee` *before* it repays.

### Do You Need a Seed?

The loan gives your receiver the **principal**. It does **not** give you the **fee** or cover any **slippage** — and the core checks it got back `amount + fee` before the transaction can succeed. So the only question is whether your callback ends holding at least `amount + fee`:

| Your strategy | Seed needed? |
|---|---|
| **Profitable arb / liquidation** (profit ≥ fee + slippage) | **No** — profit covers the fee; genuinely zero capital. |
| **Break-even round-trip** (e.g. STX→stSTX→STX just to prove execution) | **Yes** — a small seed to cover the fee (0.05%) + DEX slippage. |
| **Any strategy, while testing** | **Yes** — seed a buffer so a thin market doesn't revert your tx. |

A freshly deployed, zero-balance receiver **cannot borrow even 1 µSTX** for a break-even strategy: it has nothing to pay the fee with, so the repay check reverts before your strategy ever profits. Seed it by sending a small amount of STX (or sBTC) to the contract after deploy, and add an owner-only `rescue-*` function (shown below) so you can pull the seed back out afterward.

---

## Deployed Contracts

All FlashStack contracts are under `SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5`.

| Contract | Role |
|----------|------|
| `flashstack-stx-core` | STX flash loan engine |
| `flashstack-sbtc-core` | sBTC flash loan engine |
| `stx-flash-receiver-trait` | STX callback interface |
| `sbtc-flash-receiver-trait` | sBTC callback interface |
| `stx-test-receiver` | **De-approved (F-10)** — no `contract-caller` check; a loan naming it returns `(err u306)` |
| `sbtc-test-receiver` | **De-approved (F-10)** — no `contract-caller` check; a loan naming it returns `(err u306)` |
| `bitflow-arb-receiver-v4` | **De-approved (F-10)** — no `contract-caller` check. Hardened rewrite: `contracts/bitflow-arb-receiver-v5.clar`, not yet deployed |
| `velar-sbtc-arb-receiver` | **Non-functional, de-approved** — hardcodes Velar pool `u70`, which is not an sBTC/STX pool (see `docs/security/FINDINGS_REGISTER.md` F-10) |

Canonical sBTC token: `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token`

---

## Part 1 — STX Receiver

### The Minimal Template

Every STX receiver must implement this trait:

```clarity
(impl-trait 'SP3TGRVG7DKGFVRTTVGGS60S59R916FWB4DAB9STZ.stx-flash-receiver-trait.stx-flash-receiver-trait)
```

Minimum working receiver:

```clarity
(impl-trait 'SP3TGRVG7DKGFVRTTVGGS60S59R916FWB4DAB9STZ.stx-flash-receiver-trait.stx-flash-receiver-trait)

(define-constant CORE 'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-stx-core)

(define-public (execute-stx-flash (amount uint) (core principal))
  (let (
    ;; Look up the current fee rate dynamically — never hardcode
    (fee-bp    (unwrap! (contract-call? CORE get-fee-basis-points) (err u500)))
    (raw-fee   (/ (* amount fee-bp) u10000))
    (fee       (if (> raw-fee u0) raw-fee u1))  ;; minimum 1 microSTX
    (total-owed (+ amount fee))
  )
    ;; Only the real core may call this, and repayment goes to it, never to `core` (F-10)
    (asserts! (is-eq contract-caller CORE) (err u403))

    ;; --- YOUR STRATEGY GOES HERE ---
    ;; (amount) microSTX is already in this contract at this point.
    ;; Execute swaps, liquidations, or any on-chain call.
    ;; You must end with at least (total-owed) microSTX in this contract.
    ;; --- END STRATEGY ---

    ;; Repay principal + fee to the core contract
    (unwrap! (as-contract (stx-transfer? total-owed tx-sender CORE)) (err u501))
    (ok true)
  )
)
```

### Important Rules

1. **Always use `as-contract`** when transferring STX back to core. The STX lives in the contract's balance, not the caller's.
2. **Always look up `get-fee-basis-points` dynamically.** The fee can change. Hardcoding `u5` is a bug — if the fee increases, your repayment will be short and the tx will revert.
3. **Use literal principals for trait arguments.** If you call a function that takes `<ft-trait>`, write the principal inline (e.g., `'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.token-alex`). Using a `define-constant` for a trait argument will fail Clarity's static analysis.
4. **Minimum fee is 1 microSTX.** For tiny loans, `(/ (* amount fee-bp) u10000)` rounds to zero. The template handles this with `(if (> raw-fee u0) raw-fee u1)`.
5. **Deploying under your own wallet? Use absolute principals — never `.contract` sugar.** The in-repo example contracts call the core as `.flashstack-stx-core`. That sugar resolves to *the deploying address*, so it works **only** because those examples are deployed under the protocol deployer. Under your own wallet, `.flashstack-stx-core` resolves to `YOUR-ADDRESS.flashstack-stx-core` — a contract that doesn't exist — and every core call fails. Always write the full `'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-stx-core`, exactly as every template in this guide does.
6. **Gate the callback and hardcode the repay target (F-10).** Assert `(is-eq contract-caller CORE)` before anything else, and repay to the `CORE` constant, never to the `core` argument. Without that, anyone can call `execute-stx-flash` directly, and removing the receiver from the whitelist doesn't stop it. Run [docs/security/RECEIVER_VETTING.md](security/RECEIVER_VETTING.md) before asking for approval.

### A Real Strategy: DEX Arbitrage

```clarity
(impl-trait 'SP3TGRVG7DKGFVRTTVGGS60S59R916FWB4DAB9STZ.stx-flash-receiver-trait.stx-flash-receiver-trait)

(define-constant ERR-SWAP-FAILED  (err u501))
(define-constant ERR-NO-PROFIT    (err u502))
(define-constant ERR-REPAY-FAILED (err u503))
(define-constant ERR-NOT-CORE     (err u505))
(define-constant CORE 'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-stx-core)

(define-public (execute-stx-flash (amount uint) (core principal))
  (let (
    (fee-bp    (unwrap! (contract-call? CORE get-fee-basis-points) ERR-REPAY-FAILED))
    (raw-fee   (/ (* amount fee-bp) u10000))
    (fee       (if (> raw-fee u0) raw-fee u1))
    (total-owed (+ amount fee))
  )
    ;; Only the real core may call this, and repayment goes to it, never to `core` (F-10)
    (asserts! (is-eq contract-caller CORE) ERR-NOT-CORE)

    ;; Leg 1: swap STX for some token on your chosen DEX
    ;; (unwrap! (as-contract (contract-call? 'YOUR-DEX swap-x-for-y ...)) ERR-SWAP-FAILED)

    ;; Leg 2: swap that token back for STX
    ;; (unwrap! (as-contract (contract-call? 'YOUR-DEX swap-y-for-x ...)) ERR-SWAP-FAILED)

    ;; Verify we came out ahead
    (let ((stx-bal (stx-get-balance (as-contract tx-sender))))
      (asserts! (>= stx-bal total-owed) ERR-NO-PROFIT)
      (unwrap! (as-contract (stx-transfer? total-owed tx-sender CORE)) ERR-REPAY-FAILED)
      (ok true)
    )
  )
)

;; Rescue any trapped STX (admin only)
(define-constant OWNER tx-sender)
(define-public (rescue-stx (amount uint) (to principal))
  (begin
    (asserts! (is-eq tx-sender OWNER) (err u600))
    (unwrap! (as-contract (stx-transfer? amount tx-sender to)) (err u601))
    (ok true)
  )
)
```

Examples to read: [contracts/bitflow-arb-receiver-v5.clar](../contracts/bitflow-arb-receiver-v5.clar) (not yet deployed) and [contracts/alex-arb-receiver-v5.clar](../contracts/alex-arb-receiver-v5.clar) (approved on `flashstack-stx-core`). The originals they replace, `bitflow-arb-receiver.clar` (deployed as `bitflow-arb-receiver-v4`) and `alex-arb-receiver.clar`, are de-approved under F-10 — don't copy them. **Read them for the swap logic — but they use `.flashstack-stx-core` sugar (see rule 5). If you deploy under your own wallet, copy the absolute-principal form from the templates above, not the sugar.**

---

## Part 2 — sBTC Receiver

### The Minimal Template

```clarity
(impl-trait 'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.sbtc-flash-receiver-trait.sbtc-flash-receiver-trait)

(define-constant SBTC 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)
(define-constant CORE 'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-sbtc-core)

(define-public (execute-sbtc-flash (amount uint) (core principal))
  (let (
    (fee-bp  (unwrap! (contract-call? CORE get-fee-basis-points) (err u500)))
    (raw-fee (/ (* amount fee-bp) u10000))
    (fee     (if (> raw-fee u0) raw-fee u1))
    (owed    (+ amount fee))
  )
    ;; Only the real core may call this, and repayment goes to it, never to `core` (F-10)
    (asserts! (is-eq contract-caller CORE) (err u403))

    ;; --- YOUR STRATEGY ---
    ;; (amount) canonical sBTC satoshis are in this contract.
    ;; --- END STRATEGY ---

    ;; Repay principal + fee
    (unwrap! (as-contract (contract-call? SBTC transfer owed tx-sender CORE none)) (err u501))
    (ok true)
  )
)
```

Key difference from STX: repayment uses `contract-call?` with the sBTC token contract, not `stx-transfer?`.

Reference for the sBTC repayment call only: [contracts/velar-sbtc-arb-receiver.clar](../contracts/velar-sbtc-arb-receiver.clar). Don't copy it as a strategy: its swap legs hardcode Velar pool `u70`, which is not an sBTC/STX pool, so they always revert, and it lacks the `contract-caller` guard F-10 requires. The verified sBTC/STX route is Bitflow `SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1` via `xyk-core-v-1-2`.

---

## Part 3 — Deploy and Get Whitelisted

### Step 1: Deploy your contract

Use Clarinet or the Hiro deployment tool. Your contract must implement the correct trait — Clarity checks this at deploy time and will reject the contract if it doesn't.

Deploy script pattern (see [scripts/deploy-alex-receiver.mjs](../scripts/deploy-alex-receiver.mjs) for a complete example):

```js
import { makeContractDeploy, ClarityVersion, PostConditionMode } from "@stacks/transactions";
import { readFileSync } from "fs";

const deployTx = await makeContractDeploy({
  contractName: "my-receiver",
  codeBody: readFileSync("contracts/my-receiver.clar", "utf8"),
  senderKey: privateKey,
  network: STACKS_MAINNET,
  clarityVersion: ClarityVersion.Clarity3,
  postConditionMode: PostConditionMode.Allow,
  fee: 500_000,
  nonce: currentNonce,
});
```

> ⚠️ **`makeContractDeploy` does not type-check your Clarity.** It just submits the source. A contract with a static-analysis error still broadcasts, fails on-chain (`(err none)` / `abort_by_response`), and **permanently reserves the contract name** — you'll have to rename to `-v2`. So type-check *before* you deploy. But note: **`clarinet check` only validates contracts listed in `Clarinet.toml`.** A receiver you deploy by script is not part of the project, so `clarinet check` (and `npm run check`) silently **skip it**. To actually check it, add it to `Clarinet.toml` — declaring the mainnet contracts it calls as `[[project.requirements]]` — then run `clarinet check`. (Also: a simnet run won't resolve hard-coded mainnet principals, so validate the type-check in a Clarinet project that pulls those requirements, or against local stubs.)

### Step 2: Get whitelisted

FlashStack uses an allowlist. Only approved receivers can borrow. To get your contract whitelisted:

**Option A — Open a GitHub issue:**  
Go to https://github.com/mattglory/Flashstack/issues with your contract address and a brief description of your strategy. The admin will call `add-approved-receiver` on `flashstack-stx-core` or `flashstack-sbtc-core`.

**Option B — Contact directly:**  
DM [@flashstackbtc](https://x.com/flashstackbtc) on X with your contract address.

Whitelisting is quick — usually same day for legitimate strategies.

### Step 3: Add a pre-flight `estimate` read-only

Before executing a live flash loan, add a read-only function to your receiver so you (and the whitelister) can verify the repayment math with no gas. Here is the exact pattern — including the one gotcha that bites everyone:

```clarity
(define-read-only (estimate-repayment (amount uint))
  (let (
    ;; GOTCHA: inside a define-read-only you MUST inline the core as a LITERAL
    ;; principal. A `(define-constant CORE 'SP...)` reference is REJECTED here:
    ;; Clarity can't prove the cross-contract call is read-only through a bound
    ;; variable, so `clarinet check` / deploy fails with an analysis error.
    (fee-bp  (unwrap-panic (contract-call?
               'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-stx-core
               get-fee-basis-points)))
    (raw-fee (/ (* amount fee-bp) u10000))
    (fee     (if (> raw-fee u0) raw-fee u1))
  )
    (ok { loan-amount: amount, fee-to-pay: fee, total-owed: (+ amount fee) })
  )
)
```

> **Why inline it?** In a *public* function, using a `(define-constant CORE 'SP…)` in a `contract-call?` is fine. In a `define-read-only`, the same constant fails static analysis — you must write the absolute principal literally. This is a real, easy-to-miss deploy blocker (distinct from the trait-argument rule above).

You can also sanity-check the live fee directly over HTTP:

```bash
# Check current fee rate
curl -s -X POST "https://api.hiro.so/v2/contracts/call-read/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5/flashstack-stx-core/get-fee-basis-points" \
  -H "Content-Type: application/json" \
  -d '{"sender":"YOUR-ADDRESS","arguments":[]}' | python3 -m json.tool
# Returns: {"okay":true,"result":"0x010000000000000000000000000000000005"} → 5 basis points (0.05%)
```

### Step 4: Execute the flash loan

```js
import { makeContractCall, PostConditionMode, Cl } from "@stacks/transactions";

const tx = await makeContractCall({
  contractAddress: "SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5",
  contractName: "flashstack-stx-core",
  functionName: "flash-loan",
  functionArgs: [
    Cl.uint(loanAmountMicroSTX),
    Cl.principal("YOUR-ADDRESS.your-receiver"),
  ],
  senderKey: privateKey,
  network: STACKS_MAINNET,
  postConditionMode: PostConditionMode.Allow,
  fee: 300_000,
});
```

---

## Common Errors and Fixes

| Error | Cause | Fix |
|-------|-------|-----|
| `(err u403)` on swap | DEX blocklist check — some AMMs block new contracts by default | Contact the DEX team to confirm your contract is permitted |
| `(err none)` on deploy | Clarity static analysis failed — likely a `define-constant` used as a `<trait>` argument | Replace constants with literal principals in all `contract-call?` expressions that take trait-typed parameters |
| `(err none)` on deploy (read-only fn) | A `define-constant` core principal used in a `contract-call?` inside a `define-read-only` | Inline the absolute principal literal inside the read-only (see Step 3) |
| Repayment reverts on a break-even strategy | Receiver had no seed — nothing to pay the fee/slippage with | Seed the receiver after deploy (see *Do You Need a Seed?*) |
| `ContractAlreadyExists` | A previous failed deploy (even `abort_by_response`) reserved the contract name | Rename your contract (e.g., append `-v2`) |
| Repayment reverts | Strategy produced a loss — `stx-bal < total-owed` | Add a pre-flight `asserts!` check or use the `simulate` read-only before live execution |
| `ERR-NOT-APPROVED` from core | Receiver not on the allowlist | Open a GitHub issue or DM to get whitelisted |

---

## Strategies Worth Building

**STX strategies** (borrow from `flashstack-stx-core`):
- Bitflow STX/stSTX arb — stSTX trades above peg after stacking reward cycles
- ALEX STX/ALEX arb — ALEX briefly overpriced before emissions events
- Arkadiko liquidations — undercollateralized vaults, STX debt repaid at discount
- Collateral swap — atomically swap one collateral type for another without closing a position

**sBTC strategies** (borrow from `flashstack-sbtc-core`):
- Velar wSTX/sBTC arb — live receiver already deployed, use as reference
- Zest sBTC liquidations — pending Zest whitelist

---

## Further Reading

- [STX Testing Guide](TESTING_GUIDE_STX.md) — how to run existing test scenarios
- [sBTC Testing Guide](TESTING_GUIDE_SBTC.md) — sBTC-specific test flows
- [LP Collateral Integration Spec](LP_COLLATERAL_INTEGRATION_SPEC.md) — using FlashStack LP shares as lending collateral
- [Live receiver contracts](../contracts/) — read the source of deployed strategies
- [GitHub](https://github.com/mattglory/Flashstack) — full repo, MIT licensed
