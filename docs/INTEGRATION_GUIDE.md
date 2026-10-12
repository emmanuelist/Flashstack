# FlashStack Integration Guide

**Network:** Stacks Mainnet  
**Protocol version:** 1.0  
**Last updated:** May 2026

---

## What Is FlashStack?

FlashStack is a flash loan protocol on Bitcoin L2 (Stacks). It lets any developer borrow STX or canonical sBTC with zero collateral, execute any on-chain strategy, and repay — all within a single atomic transaction. If repayment fails, the entire transaction reverts automatically. No partial execution is possible.

**You don't need capital to fund the loan** — FlashStack provides the principal. But your receiver must be holding `amount + fee` by the time the callback returns. A profitable strategy (arb, liquidation) covers the fee out of its own profit. A break-even or test strategy must be **pre-seeded** with a small buffer to cover the fee plus any DEX slippage, or the repayment check reverts. See [BUILD_A_RECEIVER.md](BUILD_A_RECEIVER.md) → *Do you need a seed?*

---

## Deployed Contracts

All contracts are under deployer `SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5` on Stacks mainnet.

### STX Flash Loans

| Contract | Address | Explorer |
|---|---|---|
| `flashstack-stx-core` | `SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-stx-core` | [View](https://explorer.hiro.so/address/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-stx-core?chain=mainnet) |
| `flashstack-stx-pool` | `SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-stx-pool` | [View](https://explorer.hiro.so/address/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-stx-pool?chain=mainnet) |
| `flashstack-pool-oracle` | `SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-pool-oracle` | [View](https://explorer.hiro.so/address/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-pool-oracle?chain=mainnet) |
| `stx-flash-receiver-trait` | `SP3TGRVG7DKGFVRTTVGGS60S59R916FWB4DAB9STZ.stx-flash-receiver-trait` | [View](https://explorer.hiro.so/address/SP3TGRVG7DKGFVRTTVGGS60S59R916FWB4DAB9STZ.stx-flash-receiver-trait?chain=mainnet) |
| `stx-test-receiver` | `SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.stx-test-receiver` | [View](https://explorer.hiro.so/address/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.stx-test-receiver?chain=mainnet) |
| `bitflow-arb-receiver-v4` | `SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.bitflow-arb-receiver-v4` | [View](https://explorer.hiro.so/address/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.bitflow-arb-receiver-v4?chain=mainnet) |
| `flashstack-yield-vault-v4` | `SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-yield-vault-v4` | [View](https://explorer.hiro.so/address/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-yield-vault-v4?chain=mainnet) |

### sBTC Flash Loans

Canonical sBTC token: `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token` (~4,000 BTC in circulation on Stacks)

| Contract | Address | Explorer |
|---|---|---|
| `flashstack-sbtc-core` | `SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-sbtc-core` | [View](https://explorer.hiro.so/address/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-sbtc-core?chain=mainnet) |
| `flashstack-sbtc-pool` | `SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-sbtc-pool` | [View](https://explorer.hiro.so/address/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-sbtc-pool?chain=mainnet) |
| `sbtc-flash-receiver-trait` | `SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.sbtc-flash-receiver-trait` | [View](https://explorer.hiro.so/address/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.sbtc-flash-receiver-trait?chain=mainnet) |
| `sbtc-test-receiver` | `SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.sbtc-test-receiver` | [View](https://explorer.hiro.so/address/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.sbtc-test-receiver?chain=mainnet) |
| `velar-sbtc-arb-receiver` | `SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.velar-sbtc-arb-receiver` | [View](https://explorer.hiro.so/address/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.velar-sbtc-arb-receiver?chain=mainnet) |

---

## How a Flash Loan Works

```
Caller → flashstack-stx-core.flash-loan(amount, your-receiver)
              │
              ├─ Guards: not paused, amount > 0, amount ≤ max,
              │          receiver is whitelisted, reserve ≥ amount
              │
              ├─ Sends (amount) STX to your-receiver
              │
              └─ Calls your-receiver.execute-stx-flash(amount, core)
                          │
                          ├─ Your strategy runs here
                          │  (DEX swaps, liquidations, anything)
                          │
                          └─ You send (amount + fee) back to core
                                    │
                          core verifies: reserve_after ≥ reserve_before + fee
                                    │
                              ✓ (ok true)  or  ✗ full revert
```

**Fee:** 5 basis points (0.05%). On a 10 STX loan, the fee is 0.005 STX.  
**Minimum fee:** 1 microSTX (for very small loans where 0.05% rounds to zero).  
**Maximum loan:** 500,000 STX per transaction (current setting; readable via `get-max-single-loan`).  
**Atomicity:** Clarity guarantees the entire transaction is one atomic unit. There is no way to receive the loan without repaying it in the same block.

---

## Quick Start: STX Flash Loan in 5 Steps

### Step 1 — Write your receiver contract

Every STX receiver must implement the `stx-flash-receiver-trait`. The minimum working receiver:

```clarity
;; my-receiver.clar
(impl-trait 'SP3TGRVG7DKGFVRTTVGGS60S59R916FWB4DAB9STZ.stx-flash-receiver-trait.stx-flash-receiver-trait)

(define-constant CORE 'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-stx-core)
(define-constant ERR-REPAY (err u500))

(define-public (execute-stx-flash (amount uint) (core principal))
  (let (
    ;; Always fetch the fee dynamically — never hardcode
    (fee-bp    (unwrap! (contract-call? CORE get-fee-basis-points) ERR-REPAY))
    (raw-fee   (/ (* amount fee-bp) u10000))
    (fee       (if (> raw-fee u0) raw-fee u1))
    (total-owed (+ amount fee))
  )
    ;; ── YOUR STRATEGY GOES HERE ──────────────────────────────
    ;; (amount) microSTX is in this contract right now.
    ;; Call DEX swaps, liquidations, or any on-chain function.
    ;; You must have (total-owed) microSTX in this contract
    ;; before the next line executes.
    ;; ─────────────────────────────────────────────────────────

    ;; Repay principal + fee — must use as-contract
    (unwrap! (as-contract (stx-transfer? total-owed tx-sender core)) ERR-REPAY)
    (ok true)
  )
)
```

**Critical rules:**
- Always call `get-fee-basis-points` dynamically. Do not hardcode `u5`. If the fee changes, a hardcoded value will cause underpayment and the transaction will revert.
- Always use `as-contract` when transferring STX back. The STX lives in the contract's balance, not the caller's.
- Use literal principals for all `contract-call?` trait arguments. Clarity performs static analysis at deploy time and will reject contracts that pass `define-constant` values where a `<trait>` type is expected.

### Step 2 — Deploy your contract

```bash
# Using the @stacks/transactions SDK
import { makeContractDeploy, ClarityVersion, PostConditionMode } from "@stacks/transactions";
import { readFileSync } from "fs";

const tx = await makeContractDeploy({
  contractName:      "my-receiver",
  codeBody:          readFileSync("contracts/my-receiver.clar", "utf8"),
  senderKey:         yourPrivateKey,
  network:           STACKS_MAINNET,
  clarityVersion:    ClarityVersion.Clarity3,
  postConditionMode: PostConditionMode.Allow,
  fee:               500_000,  // 0.5 STX
  nonce:             currentNonce,
});
```

### Step 3 — Get whitelisted

Only approved receivers can borrow from FlashStack. Open a GitHub issue at https://github.com/mattglory/Flashstack/issues with your deployed contract address and a brief description of your strategy. Whitelisting is typically same-day.

### Step 4 — Verify your receiver is approved

```bash
curl -s -X POST \
  "https://api.hiro.so/v2/contracts/call-read/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5/flashstack-stx-core/is-approved-receiver" \
  -H "Content-Type: application/json" \
  -d "{\"sender\":\"YOUR-ADDRESS\",\"arguments\":[\"<serialized-contract-principal>\"]}"
# NOTE: the argument must be a Clarity-serialized contract-principal (hex starting 0x06...),
# NOT the ascii-hex of the string. Generate it in JS:
#   Cl.serialize(Cl.contractPrincipal("YOUR-ADDRESS", "my-receiver"))
```

Or check on Hiro Explorer: navigate to your contract address and call `is-approved-receiver` with your receiver principal as argument.

### Step 5 — Execute the flash loan

```js
import { makeContractCall, PostConditionMode, Cl } from "@stacks/transactions";

const tx = await makeContractCall({
  contractAddress:   "SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5",
  contractName:      "flashstack-stx-core",
  functionName:      "flash-loan",
  functionArgs: [
    Cl.uint(10_000_000),                                            // 10 STX in microSTX
    Cl.principal("YOUR-ADDRESS.my-receiver"),
  ],
  senderKey:         yourPrivateKey,
  network:           STACKS_MAINNET,
  postConditionMode: PostConditionMode.Allow,
  fee:               300_000,
});
```

A successful transaction returns `(ok true)` and shows up in `get-stats` with `total-loans` incremented by 1.

---

## Quick Start: sBTC Flash Loan

The sBTC flow is identical to STX with two differences: the trait and the repayment method.

```clarity
;; my-sbtc-receiver.clar
(impl-trait 'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.sbtc-flash-receiver-trait.sbtc-flash-receiver-trait)

(define-constant SBTC_CORE 'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-sbtc-core)
(define-constant SBTC      'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)
(define-constant ERR-REPAY (err u500))

(define-public (execute-sbtc-flash (amount uint) (core principal))
  (let (
    (fee-bp    (unwrap! (contract-call? SBTC_CORE get-fee-basis-points) ERR-REPAY))
    (raw-fee   (/ (* amount fee-bp) u10000))
    (fee       (if (> raw-fee u0) raw-fee u1))
    (total-owed (+ amount fee))
  )
    ;; ── YOUR STRATEGY ────────────────────────────────────────
    ;; (amount) canonical sBTC satoshis are in this contract.
    ;; ─────────────────────────────────────────────────────────

    ;; Repay canonical sBTC — use the token contract, not stx-transfer?
    (unwrap! (as-contract
      (contract-call? SBTC transfer total-owed tx-sender core none))
      ERR-REPAY)
    (ok true)
  )
)
```

To execute:

```js
const tx = await makeContractCall({
  contractAddress: "SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5",
  contractName:    "flashstack-sbtc-core",
  functionName:    "flash-loan",
  functionArgs: [
    Cl.uint(10_000),                                               // 0.0001 sBTC (satoshis)
    Cl.principal("YOUR-ADDRESS.my-sbtc-receiver"),
  ],
  // ...
});
```

---

## Use Cases

### DEX Arbitrage

Borrow STX, execute a round-trip swap on a Stacks DEX, repay, keep the spread.

**Live example:** `bitflow-arb-receiver-v4` borrows STX, swaps STX→stSTX→STX on Bitflow's stableswap (`SPQC38PW542EQJ5M11CR25P7BS1CA6QT4TBXGB3M.stableswap-stx-ststx-v-1-2`), repays principal + fee, and the spread stays in the receiver for the caller.

Confirmed mainnet arb tx: `0xabd33fc46ffa204ce61f25664f057e414063f28ce75c8387a6df9116453110cb`

Source: [contracts/bitflow-arb-receiver.clar](../contracts/bitflow-arb-receiver.clar)

> ⚠️ **Reading the in-repo examples?** They reference the core with `.contract` sugar (e.g. `.flashstack-stx-core`), which resolves to **the deployer's own address**. That works only because they are deployed under the protocol deployer. If you deploy under **your own** wallet, `.flashstack-stx-core` would resolve to `YOUR-ADDRESS.flashstack-stx-core` — a contract that doesn't exist — and every core call fails. **Always use the absolute principal** `'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-stx-core`, exactly as the templates above do.

**Pattern:**
```clarity
;; Leg 1: STX → TOKEN on DEX
(unwrap! (as-contract (contract-call? 'DEX-CONTRACT swap-x-for-y
  'TOKEN-X 'TOKEN-Y factor dx none)) ERR-SWAP-FAILED)

;; Leg 2: TOKEN → STX on DEX
(let ((token-bal (unwrap! (as-contract (contract-call? 'TOKEN get-balance tx-sender)) ERR-SWAP-FAILED)))
  (unwrap! (as-contract (contract-call? 'DEX-CONTRACT swap-y-for-x
    'TOKEN-X 'TOKEN-Y factor token-bal none)) ERR-SWAP-FAILED)

  ;; Verify profitable and repay
  (let ((stx-bal (stx-get-balance (as-contract tx-sender))))
    (asserts! (>= stx-bal total-owed) ERR-NO-PROFIT)
    (unwrap! (as-contract (stx-transfer? total-owed tx-sender core)) ERR-REPAY)
    (ok true)
  )
)
```

---

### Flash Liquidation

Borrow the debt amount, call the lending protocol's liquidation function, receive discounted collateral, repay the flash loan, keep the liquidation bonus. Zero capital required.

**When to use:** A borrower's health factor drops below 1.0 on a lending protocol (Zest, Arkadiko). The liquidator flash-borrows the exact debt, liquidates, and profits from the liquidation discount without holding any assets beforehand.

**Pattern (STX debt, STX collateral):**
```clarity
;; Hardcoded, not the caller-supplied `core` parameter -- F-10 (docs/security/FINDINGS_REGISTER.md)
;; was exactly this: a receiver with no contract-caller check that repaid
;; to whatever `core` the caller passed in, letting anyone call
;; execute-stx-flash directly (not through a real flash loan) and redirect
;; the receiver's own balance. `core` is still accepted as a parameter for
;; trait compliance, but never trusted.
(define-constant FLASH-CORE 'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-stx-core)

(define-public (execute-stx-flash (amount uint) (core principal))
  (let (
    (fee-bp    (unwrap! (contract-call? FLASH-CORE get-fee-basis-points) ERR-REPAY))
    (raw-fee   (/ (* amount fee-bp) u10000))
    (fee       (if (> raw-fee u0) raw-fee u1))
    (total-owed (+ amount fee))
  )
    ;; Only FLASH-CORE may invoke this callback
    (asserts! (is-eq contract-caller FLASH-CORE) ERR-NOT-CORE)
    (asserts! (is-eq core FLASH-CORE) ERR-NOT-CORE) ;; defense-in-depth

    ;; Repay borrower's debt to the lending protocol
    (unwrap! (as-contract
      (contract-call? 'LENDING-PROTOCOL liquidation-call
        borrower-address
        debt-amount
        collateral-token))
      ERR-LIQUIDATION)

    ;; Now we hold discounted collateral.
    ;; If collateral is STX: verify balance and repay.
    ;; If collateral is another token: swap it first, then repay.
    (let ((stx-now (stx-get-balance (as-contract tx-sender))))
      (asserts! (>= stx-now total-owed) ERR-NO-PROFIT)
      (unwrap! (as-contract (stx-transfer? total-owed tx-sender FLASH-CORE)) ERR-REPAY)
      (ok true)
    )
  )
)
```

Source: [contracts/zest-v2-liquidation-receiver.clar](../contracts/zest-v2-liquidation-receiver.clar) (not yet deployed — targets the live `v0-8-market`; also needs a real signed Pyth Lazer price feed threaded through on v0-8, see the contract's own header)

---

### Collateral Swap

Swap one collateral type for another in a single transaction without closing a position. Borrow token B, post it as collateral, withdraw token A, swap A for B, repay the flash loan. The net effect is that the user's collateral changes from A to B with no gap in coverage.

---

### Auto-Compounding Yield Vault

Users deposit STX into a shared vault and receive shares. A keeper calls `flash-loan` with the vault as receiver. The vault executes a DEX arb, captures the spread, and leaves it in the vault — raising the share price for all depositors automatically.

**Live example:** `flashstack-yield-vault-v4` monitors Bitflow for stSTX arb windows and compounds automatically.

Source: [contracts/flashstack-yield-vault.clar](../contracts/flashstack-yield-vault.clar)

---

## Protocol-Level Integration (for Lending Protocols)

If you are building or operating a lending protocol on Stacks and want to offer flash liquidations to your liquidators:

**What your protocol needs to do:**
1. Accept a call from an external contract (the FlashStack receiver) to trigger liquidations
2. Release discounted collateral to the calling contract within the same transaction
3. No whitelist required on FlashStack's side for the lending protocol itself — only the receiver contract needs to be approved

**What FlashStack provides:**
- Instant liquidity for the debt amount (STX or sBTC)
- Atomic repayment guarantee — if the liquidator does not repay, the entire transaction reverts and your protocol's state is unchanged
- `flashstack-pool-oracle` — a read-only function that returns LP share prices, usable for valuing FlashStack LP positions as collateral

**Contact:** Open a GitHub issue at https://github.com/mattglory/Flashstack/issues or reach out at https://x.com/flashstackbtc to discuss a protocol-level integration.

---

## Getting Whitelisted

FlashStack uses an allowlist on both `flashstack-stx-core` and `flashstack-sbtc-core`. Only approved receiver principals can call `flash-loan`.

To request whitelisting:
1. Deploy your receiver contract to mainnet
2. Verify it returns `(ok true)` from `execute-stx-flash` or `execute-sbtc-flash` (test with a read-only simulation first)
3. Open a GitHub issue at https://github.com/mattglory/Flashstack/issues with:
   - Your deployed contract address (full `ADDRESS.contract-name`)
   - A brief description of your strategy
   - The explorer link to your deployed contract

Whitelisting is typically processed the same day. There is no fee.

---

## Testing Your Receiver Before Mainnet

**Use the testnet deployment script** to deploy a full FlashStack environment under your own wallet on Stacks testnet and verify your receiver works end-to-end before touching mainnet funds:

```bash
# Fund your testnet address first:
# https://explorer.hiro.so/sandbox/faucet?chain=testnet

TESTNET_MNEMONIC="word1 ... word24" node scripts/deploy-testnet.mjs
```

This deploys all 5 contracts (trait, core, pool, oracle, test receiver), whitelists the receiver, seeds it, funds the reserve, and executes a flash loan — producing testnet txids as verification evidence.

**Pre-flight check on mainnet** — verify the current fee and reserve before executing:

```bash
# Check fee rate
curl -s -X POST "https://api.hiro.so/v2/contracts/call-read/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5/flashstack-stx-core/get-fee-basis-points" \
  -H "Content-Type: application/json" \
  -d '{"sender":"SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5","arguments":[]}'

# Check reserve balance and stats
curl -s -X POST "https://api.hiro.so/v2/contracts/call-read/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5/flashstack-stx-core/get-stats" \
  -H "Content-Type: application/json" \
  -d '{"sender":"SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5","arguments":[]}'
```

---

## Common Errors

| Error code | Constant | Cause | Fix |
|---|---|---|---|
| `(err u300)` | `ERR-NOT-ADMIN` | Called an admin function from a non-admin wallet | Only callable by the protocol admin |
| `(err u301)` | `ERR-ZERO-AMOUNT` | Loan amount is 0 | Pass a positive microSTX amount |
| `(err u302)` | `ERR-REPAY-FAILED` | Reserve did not grow by the fee after your callback | Your strategy did not return enough STX/sBTC |
| `(err u303)` | `ERR-INSUFFICIENT-RESERVE` | Loan amount exceeds available reserve | Borrow less or check `get-reserve-balance` first |
| `(err u304)` | `ERR-EXCEEDS-LIMIT` | Loan amount exceeds `max-single-loan` | Check `get-max-single-loan`; currently 500,000 STX |
| `(err u305)` | `ERR-PAUSED` | Protocol is paused | Check `get-stats` for paused status |
| `(err u306)` | `ERR-NOT-APPROVED` | Receiver not on the allowlist | Request whitelisting via GitHub issue |
| `(err u307)` | `ERR-INVALID-FEE` | Fee set outside 1–1000 basis points | Admin only; valid range is 0.01%–10% |
| `(err none)` on deploy | Clarity analysis error | Usually a `define-constant` used where a trait reference is required | Use literal principals in all `contract-call?` expressions |
| `ContractAlreadyExists` | Contract name taken | A previous deploy (even a failed one) reserved the name | Append `-v2`, `-v3`, etc. |

---

## Further Reading

- [BUILD_A_RECEIVER.md](BUILD_A_RECEIVER.md) — complete step-by-step guide to writing, testing, and deploying a custom receiver with worked code examples
- [API_REFERENCE.md](API_REFERENCE.md) — every public function and read-only function on both core contracts
- [TESTING_GUIDE_STX.md](TESTING_GUIDE_STX.md) — step-by-step STX flash loan test scenarios
- [TESTING_GUIDE_SBTC.md](TESTING_GUIDE_SBTC.md) — sBTC-specific test flows
- [LP_COLLATERAL_INTEGRATION_SPEC.md](LP_COLLATERAL_INTEGRATION_SPEC.md) — using FlashStack LP shares as lending collateral
- [GitHub repository](https://github.com/mattglory/Flashstack) — all source code, MIT licensed
