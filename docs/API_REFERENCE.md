# FlashStack API Reference

**Network:** Stacks Mainnet  
**Deployer:** `SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5`  
**Last updated:** May 2026

All amounts are in microSTX (1 STX = 1,000,000 microSTX) or satoshis (1 sBTC = 100,000,000 satoshis) unless otherwise noted.

---

## flashstack-stx-core

Full address: `SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-stx-core`  
Explorer: https://explorer.hiro.so/address/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-stx-core?chain=mainnet

### flash-loan

The primary entry point. Borrows STX on behalf of the caller, invokes the receiver callback, and verifies repayment — all in one atomic transaction.

```clarity
(define-public (flash-loan
  (amount uint)
  (receiver <stx-flash-receiver-trait>))
(response bool uint))
```

**Parameters**

| Name | Type | Description |
|---|---|---|
| `amount` | `uint` | Loan size in microSTX. Must be > 0 and ≤ `max-single-loan`. |
| `receiver` | `<stx-flash-receiver-trait>` | The contract that will receive the STX and execute the strategy. Must be on the approved receiver list. |

**Returns:** `(ok true)` on success.

**Errors**

| Code | Constant | Condition |
|---|---|---|
| `u300` | `ERR-NOT-ADMIN` | — |
| `u301` | `ERR-ZERO-AMOUNT` | `amount` is 0 |
| `u302` | `ERR-REPAY-FAILED` | Reserve after callback < reserve before + fee |
| `u303` | `ERR-INSUFFICIENT-RESERVE` | Reserve < `amount` |
| `u304` | `ERR-EXCEEDS-LIMIT` | `amount` > `max-single-loan` |
| `u305` | `ERR-PAUSED` | Protocol is paused |
| `u306` | `ERR-NOT-APPROVED` | Receiver not on allowlist |

**Fee calculation:**  
`fee = max(floor(amount × fee-basis-points / 10000), 1)`  
Default: 5 basis points = 0.05%. On 10 STX, fee = 5,000 microSTX.

**Sequence of events inside `flash-loan`:**
1. Guard checks (paused, amount, limit, approved, reserve)
2. `stx-transfer? amount core receiver-principal` — sends loan
3. `contract-call? receiver execute-stx-flash amount core` — invokes your callback
4. Checks `reserve_after ≥ reserve_before + fee` — verifies repayment
5. Updates `total-loans`, `total-volume`, `total-fees`
6. Returns `(ok true)`

---

### deposit-reserve *(admin only)*

Adds STX to the flash loan reserve from the admin wallet.

```clarity
(define-public (deposit-reserve (amount uint))
(response bool uint))
```

---

### withdraw-reserve *(admin only)*

Removes STX from the reserve to the admin wallet.

```clarity
(define-public (withdraw-reserve (amount uint))
(response bool uint))
```

---

### add-approved-receiver *(admin only)*

Adds a receiver contract to the allowlist so it can call `flash-loan`.

```clarity
(define-public (add-approved-receiver (receiver principal))
(response bool uint))
```

---

### remove-approved-receiver *(admin only)*

Removes a receiver from the allowlist.

```clarity
(define-public (remove-approved-receiver (receiver principal))
(response bool uint))
```

---

### set-fee-basis-points *(admin only)*

Updates the flash loan fee. Valid range: 1–1000 basis points (0.01%–10%).

```clarity
(define-public (set-fee-basis-points (new-fee uint))
(response bool uint))
```

---

### set-paused *(admin only)*

Pauses or unpauses all flash loans. When paused, `flash-loan` returns `ERR-PAUSED (err u305)`.

```clarity
(define-public (set-paused (val bool))
(response bool uint))
```

---

### set-max-single-loan *(admin only)*

Sets the maximum STX that can be borrowed in a single transaction.

```clarity
(define-public (set-max-single-loan (amount uint))
(response bool uint))
```

Current value: `500,000,000,000` microSTX = 500,000 STX.

---

### transfer-admin *(admin only)*

Transfers admin rights to a new principal.

```clarity
(define-public (transfer-admin (new-admin principal))
(response bool uint))
```

---

### get-stats

Returns the full protocol state in a single call.

```clarity
(define-read-only (get-stats)
(ok {
  reserve:          uint,   ;; current STX balance of this contract (microSTX)
  total-loans:      uint,   ;; number of successful flash loans ever
  total-volume:     uint,   ;; cumulative STX borrowed (microSTX)
  total-fees:       uint,   ;; cumulative fees collected (microSTX)
  fee-basis-points: uint,   ;; current fee rate (5 = 0.05%)
  paused:           bool,   ;; true if flash loans are suspended
  max-single-loan:  uint,   ;; maximum borrowable per tx (microSTX)
}))
```

**Example — read via curl:**
```bash
curl -s -X POST \
  "https://api.hiro.so/v2/contracts/call-read/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5/flashstack-stx-core/get-stats" \
  -H "Content-Type: application/json" \
  -d '{"sender":"SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5","arguments":[]}'
```

---

### get-reserve-balance

Returns the current STX balance held by the core contract (microSTX).

```clarity
(define-read-only (get-reserve-balance)
uint)
```

---

### get-fee-basis-points

Returns the current fee rate in basis points.

```clarity
(define-read-only (get-fee-basis-points)
(ok uint))
```

Current value: `5` (0.05%).

---

### get-max-single-loan

Returns the maximum loan size per transaction in microSTX.

```clarity
(define-read-only (get-max-single-loan)
(ok uint))
```

---

### is-approved-receiver

Returns `true` if the given principal is on the receiver allowlist, `false` otherwise.

```clarity
(define-read-only (is-approved-receiver (receiver principal))
bool)
```

**Example check before deploying:**
```js
import { fetchCallReadOnlyFunction, Cl, cvToJSON } from "@stacks/transactions";

const result = await fetchCallReadOnlyFunction({
  contractAddress: "SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5",
  contractName:    "flashstack-stx-core",
  functionName:    "is-approved-receiver",
  functionArgs:    [Cl.principal("YOUR-ADDRESS.your-receiver")],
  network:         STACKS_MAINNET,
  senderAddress:   "SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5",
});
console.log(cvToJSON(result)); // true or false
```

---

### calculate-fee

Returns the fee that would be charged on a given loan amount.

```clarity
(define-read-only (calculate-fee (amount uint))
(ok uint))
```

**Fee formula:** `max(floor(amount × fee-basis-points / 10000), 1)`

---

### get-admin

Returns the current admin principal.

```clarity
(define-read-only (get-admin)
(ok principal))
```

---

## flashstack-sbtc-core

Full address: `SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-sbtc-core`  
Explorer: https://explorer.hiro.so/address/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-sbtc-core?chain=mainnet

Canonical sBTC: `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token`

The sBTC core has the same interface as `flashstack-stx-core` with two differences:
- `flash-loan` accepts a `<sbtc-flash-receiver-trait>` receiver
- The callback is `execute-sbtc-flash` instead of `execute-stx-flash`
- Repayment uses `sbtc-token.transfer` instead of `stx-transfer?`

### flash-loan

```clarity
(define-public (flash-loan
  (amount uint)
  (receiver <sbtc-flash-receiver-trait>))
(response bool uint))
```

**Parameters**

| Name | Type | Description |
|---|---|---|
| `amount` | `uint` | Loan size in satoshis. Must be > 0 and ≤ `max-single-loan`. |
| `receiver` | `<sbtc-flash-receiver-trait>` | Must implement `execute-sbtc-flash` and be on the approved list. |

**Errors** (same codes as STX core)

| Code | Constant | Condition |
|---|---|---|
| `u300` | `ERR-PAUSED` | Protocol is paused |
| `u301` | `ERR-ZERO-AMOUNT` | Amount is 0 |
| `u302` | `ERR-REPAY-FAILED` | Reserve did not grow by the fee |
| `u303` | `ERR-INSUFFICIENT-RESERVE` | Reserve < amount |
| `u304` | `ERR-EXCEEDS-LIMIT` | Amount > max-single-loan |
| `u306` | `ERR-NOT-APPROVED` | Receiver not on allowlist |
| `u310` | `ERR-NOT-ADMIN` | Admin-only function |
| `u311` | `ERR-TRANSFER-FAILED` | sBTC transfer failed |

### Read-only functions

Same interface as STX core: `get-stats`, `get-reserve-balance`, `get-fee-basis-points`, `get-max-single-loan`, `is-approved-receiver`, `calculate-fee`, `get-admin`.

---

## Receiver Trait Interfaces

### stx-flash-receiver-trait

Deployed at: `SP3TGRVG7DKGFVRTTVGGS60S59R916FWB4DAB9STZ.stx-flash-receiver-trait`

```clarity
(define-trait stx-flash-receiver-trait
  (
    (execute-stx-flash
      (uint principal)
      (response bool uint))
  )
)
```

Your STX receiver must:
1. Declare `(impl-trait 'SP3TGRVG7DKGFVRTTVGGS60S59R916FWB4DAB9STZ.stx-flash-receiver-trait.stx-flash-receiver-trait)`
2. Define `(define-public (execute-stx-flash (amount uint) (core principal)) ...)`, asserting `(is-eq contract-caller <hardcoded core>)` as its first expression, before any read of the core (including the fee lookup), and never trusting the `core` argument (F-10, `docs/security/RECEIVER_VETTING.md`)
3. By the time `execute-stx-flash` returns, `stx-get-balance(as-contract tx-sender) ≥ amount + fee` must be true — or the caller `flash-loan` will fail its reserve check and revert the entire transaction

### sbtc-flash-receiver-trait

Deployed at: `SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.sbtc-flash-receiver-trait`

```clarity
(define-trait sbtc-flash-receiver-trait
  (
    (execute-sbtc-flash
      (uint principal)
      (response bool uint))
  )
)
```

Your sBTC receiver must:
1. Declare `(impl-trait 'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.sbtc-flash-receiver-trait.sbtc-flash-receiver-trait)`
2. Define `(define-public (execute-sbtc-flash (amount uint) (core principal)) ...)`
3. Assert `(is-eq contract-caller <hardcoded core>)` as the first expression, before any read of the core including the fee lookup (F-10, `docs/security/RECEIVER_VETTING.md`)
4. Repay to the hardcoded core, not the `core` argument: `(contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer total-owed tx-sender CORE none)` wrapped in `as-contract`

---

## flashstack-pool-oracle

Full address: `SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-pool-oracle`

Provides LP share prices for lending protocols that want to accept FlashStack LP positions as collateral.

### get-share-price

Returns the current price of one LP share in microSTX.

```clarity
(define-read-only (get-share-price)
(ok uint))
```

The share price starts at `1,000,000` microSTX (1 STX per share) at first deposit and increases as fees accumulate in the pool.

### get-pool-stats

Returns full pool state: total shares, total STX, share price.

```clarity
(define-read-only (get-pool-stats)
(ok { total-shares: uint, total-stx: uint, share-price: uint }))
```

For full LP collateral integration spec, see [LP_COLLATERAL_INTEGRATION_SPEC.md](LP_COLLATERAL_INTEGRATION_SPEC.md).

---

## Confirmed Mainnet Transactions

These transactions can be independently verified on Hiro Explorer.

| Transaction | Type | Details |
|---|---|---|
| [`0xabd33fc4...110cb`](https://explorer.hiro.so/txid/0xabd33fc46ffa204ce61f25664f057e414063f28ce75c8387a6df9116453110cb?chain=mainnet) | STX flash loan + Bitflow arb | `flashstack-stx-core.flash-loan(10 STX, bitflow-arb-receiver-v4)` → STX→stSTX→STX round-trip → `(ok true)` |
| [`0x67f0c77d...f9baa`](https://explorer.hiro.so/txid/0x67f0c77d9d7ab9762c08a3638ba0990d5bbc3d19db8adc1a0d616cd7170f9baa?chain=mainnet) | sBTC flash loan | `flashstack-sbtc-core.flash-loan(0.0001 sBTC, sbtc-test-receiver)` → canonical sBTC → `(ok true)` |
| [`0xc9d8e86f...53b4e`](https://explorer.hiro.so/txid/0xc9d8e86f5ffcfc61537a25d6108a4b8ac0cf075568027a878cf2e9bcf6d53b4e?chain=mainnet) | sBTC flash loan via frontend | Same as above, initiated through flashstack.vercel.app → `(ok true)` |
