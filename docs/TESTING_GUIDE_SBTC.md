# FlashStack sBTC Testing Guide

**Last Updated:** May 2026
**For:** External testers, developers, grant reviewers
**Network:** Stacks Mainnet only

---

## Overview

FlashStack supports canonical sBTC flash loans — borrow real Bitcoin (backed 1:1) with zero collateral, execute any on-chain strategy, repay in the same atomic transaction.

| Asset | Core Contract | Status |
|-------|--------------|--------|
| STX | `flashstack-stx-core` | Active |
| sBTC (canonical) | `flashstack-sbtc-core` | Active |

This guide covers the **sBTC path**. For STX testing see `docs/TESTING_GUIDE_STX.md`.

---

## Deployed Contracts (Stacks Mainnet)

All contracts are under deployer `SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5`.

| Contract | Role | Explorer |
|----------|------|----------|
| `flashstack-sbtc-core` | sBTC flash loan engine — holds reserve, executes loans | [View](https://explorer.hiro.so/address/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-sbtc-core?chain=mainnet) |
| `sbtc-flash-receiver-trait` | Interface all sBTC receivers must implement | [View](https://explorer.hiro.so/address/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.sbtc-flash-receiver-trait?chain=mainnet) |
| `sbtc-test-receiver` | **De-approved (F-10)** — no `contract-caller` check; a loan naming it now returns `(err u306)` | [View](https://explorer.hiro.so/address/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.sbtc-test-receiver?chain=mainnet) |

**Canonical sBTC token:** `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token`

---

## Before You Start

- **You need a Leather or Xverse wallet** with a small amount of STX for gas (~0.01 STX covers all tests)
- **You do NOT need sBTC in your wallet** — the sBTC reserve lives in `flashstack-sbtc-core`. Your wallet only pays the Stacks tx fee.
- **All testing is on Stacks Mainnet.** There is no testnet deployment.
- **Flash loans are atomic** — if the receiver fails to repay, the entire transaction reverts. You lose only the gas fee (~$0.001). No other funds are at risk.
- Any new receiver contract you deploy must be whitelisted by the admin via `add-approved-receiver` before it can borrow. Contact Matt to get whitelisted.

---

## Test Suite

### Test 1 — Basic sBTC Flash Loan (Smoke Test)

> **Not runnable as written.** `sbtc-test-receiver` was de-approved on `flashstack-sbtc-core` under F-10 (`docs/security/FINDINGS_REGISTER.md`), so the steps below now return `(err u306)`. Use your own receiver, built from the template below and vetted with `docs/security/RECEIVER_VETTING.md`, once it's approved.

**What it tests:** Core sBTC flash loan mechanic — borrow canonical sBTC, repay in same tx.

**Via the frontend (easiest):**
1. Go to [flashstack.vercel.app/flash-loan](https://flashstack.vercel.app/flash-loan)
2. Click the **sBTC Flash Loan** tab
3. Connect your wallet (Mainnet)
4. Enter amount: `0.00010000` (10,000 sats — safe, within reserve)
5. Receiver: **sBTC Test Receiver** (default)
6. Click **Execute sBTC Flash Loan**
7. Approve in Leather/Xverse

**Via Hiro Explorer (direct contract call):**
1. Go to [flashstack-sbtc-core on Explorer](https://explorer.hiro.so/address/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-sbtc-core?chain=mainnet)
2. Click **Call contract** → connect wallet
3. Select function: `flash-loan`
4. Parameters:
   ```
   amount:   u10000
   receiver: SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.sbtc-test-receiver
   ```
5. Submit

**What success looks like:**
- Transaction confirmed (green checkmark)
- Result: `(ok true)`
- Tokens Transferred shows two sBTC movements:
  - `SP20...core → SP20...sbtc-test-receiver` (loan sent)
  - `SP20...sbtc-test-receiver → SP20...core` (principal + fee repaid)
- `get-stats` on `flashstack-sbtc-core` shows `total-loans` incremented by 1

**What failure looks like:**

| Error | Meaning | Fix |
|-------|---------|-----|
| `(err u303)` | Reserve too low | Reduce loan amount below current reserve |
| `(err u306)` | Receiver not whitelisted | Contact Matt to whitelist |
| `(err u301)` | Zero amount | Use a positive amount |
| `(err u304)` | Exceeds max loan | Max is 10,000,000 sats (0.1 BTC) |
| `(err u300)` | Protocol paused | Contact Matt |

---

### Test 2 — Read Contract State (No Wallet Needed)

All read-only functions are free — no wallet, no gas.

Go to the [flashstack-sbtc-core explorer page](https://explorer.hiro.so/address/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-sbtc-core?chain=mainnet) and call:

| Function | Expected Result |
|----------|----------------|
| `get-reserve-balance` | > 0 sats (current reserve) |
| `get-fee-basis-points` | `(ok u5)` — 0.05% fee |
| `get-max-single-loan` | `(ok u10000000)` — 0.1 BTC |
| `get-admin` | `(ok SPR9PQANV6XHSDNRAX2GNKCA5Z1KH61961KE0BYG)`. Admin was rotated off the deployer wallet. |
| `is-approved-receiver` → `SP20XD46...sbtc-test-receiver` | `(ok false)` — de-approved under F-10 |
| `calculate-fee u10000` | `(ok u1)` — minimum 1 sat fee |
| `calculate-fee u1000000` | `(ok u50)` — 0.05% of 1M sats |
| `get-stats` | tuple with total-loans, total-volume, total-fees-collected |

---

### Test 3 — Failure Cases (Expected Reverts)

These should all fail cleanly with no fund loss:

| Test | How to trigger | Expected error |
|------|---------------|----------------|
| Loan exceeds reserve | `flash-loan` with amount > reserve | `(err u303)` |
| Loan exceeds max | `flash-loan` with amount > `u10000000` | `(err u304)` |
| Unapproved receiver | `flash-loan` with an unwhitelisted contract | `(err u306)` |
| Zero amount | `flash-loan` with `u0` | `(err u301)` |

All revert cleanly — only gas is spent.

---

## Write Your Own sBTC Receiver

Any Clarity contract that implements the `sbtc-flash-receiver-trait` can borrow sBTC from FlashStack.

**The trait (one function required):**
```clarity
(define-trait sbtc-flash-receiver-trait
  (
    (execute-sbtc-flash (uint principal) (response bool uint))
  )
)
```

**Minimal receiver template:**
```clarity
(impl-trait 'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.sbtc-flash-receiver-trait.sbtc-flash-receiver-trait)

(define-constant SBTC 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)
(define-constant CORE 'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-sbtc-core)

(define-constant ERR-REPAY-FAILED (err u500))
(define-constant ERR-NOT-CORE (err u403))

;; Called by flashstack-sbtc-core after transferring sBTC to this contract.
;; sBTC is already in this contract when this function runs.
;; You MUST repay amount + fee before this function returns.
(define-public (execute-sbtc-flash (amount uint) (core principal))
  (begin
    ;; Only the real core may call this, and repayment goes to it, never to `core` (F-10)
    (asserts! (is-eq contract-caller CORE) ERR-NOT-CORE)
    (let (
      ;; Get current fee rate from core
      (fee-bp  (unwrap! (contract-call? CORE get-fee-basis-points) ERR-REPAY-FAILED))
      (raw-fee (/ (* amount fee-bp) u10000))
      (fee     (if (> raw-fee u0) raw-fee u1))  ;; minimum 1 sat
      (owed    (+ amount fee))
    )
      ;; ── YOUR STRATEGY GOES HERE ──────────────────────────────
      ;; e.g. swap sBTC for USDA on Velar, arbitrage, liquidate
      ;; The sBTC loan is already in this contract.
      ;; ─────────────────────────────────────────────────────────

      ;; Repay principal + fee to core
      (unwrap!
        (as-contract (contract-call? SBTC transfer owed tx-sender CORE none))
        ERR-REPAY-FAILED)
      (ok true)
    )
  )
)
```

**Key points:**
- Assert `contract-caller` is the core as the first expression, before the fee lookup, and repay to the `CORE` constant, never the `core` argument (F-10, `docs/security/RECEIVER_VETTING.md`)
- Use `as-contract` when calling `transfer` — the contract is the sender, not tx-sender
- The fee is minimum 1 sat regardless of amount
- Pre-fund your receiver with enough sBTC to cover the fee if your strategy doesn't generate surplus
- Repayment must happen before `execute-sbtc-flash` returns — it's verified by the core

**Deployment steps:**
1. Write your receiver contract
2. Deploy to Stacks Mainnet (`clarinet deploy` or via Hiro Explorer)
3. Message Matt with your deployed contract address to get whitelisted
4. Call `flash-loan(amount, your-receiver)` on `flashstack-sbtc-core`

---

## Confirmed Mainnet Transactions (Evidence)

| Tx | Type | Explorer |
|----|------|---------|
| `0x67f0c77d...` | sBTC flash loan — test receiver | [View](https://explorer.hiro.so/txid/0x67f0c77d9d7ab9762c08a3638ba0990d5bbc3d19db8adc1a0d616cd7170f9baa?chain=mainnet) |
| `0xc9d8e86f...` | sBTC flash loan — production frontend | [View](https://explorer.hiro.so/txid/0xc9d8e86f5ffcfc61537a25d6108a4b8ac0cf075568027a878cf2e9bcf6d53b4e?chain=mainnet) |

---

## Questions / Issues

- Message Matt directly on X [@flashstackbtc](https://x.com/flashstackbtc) or via GitHub
- For failed txs: share the txid from [Hiro Explorer](https://explorer.hiro.so)
- To request whitelist for your receiver contract: open an issue on [GitHub](https://github.com/mattglory/Flashstack)
- Do not call admin functions (`deposit-reserve`, `add-approved-receiver`, `set-paused`) — admin wallet (`SPR9PQAN...`) only
