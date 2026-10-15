;; HK sBTC Real Receiver v2
;;
;; Plumbing / test receiver for flashstack-sbtc-core. NOT an arbitrage contract.
;;   borrow sBTC -> swap sBTC->STX on Bitflow XYK pool 21 -> swap STX->sBTC back ->
;;   repay principal + fee to the core, atomically.
;;
;; Every run LOSES money by design: ~1.36% Bitflow round trip (2 x 0.5% swap fee
;; plus price impact at ~0.54 sBTC depth, measured 2026-10-14) plus the core fee.
;; The owner pre-funds the shortfall. The point is to prove a real sBTC flash loan
;; against a real DEX route end to end, nothing more.
;;
;; Replaces hk-sbtc-real-receiver-v1, whose hardcoded Velar pool u70 is not an
;; sBTC/STX pool (#98, FINDINGS ajv.4.10), so v1's swap legs can never succeed.
;;
;; Built to docs/security/RECEIVER_VETTING.md:
;;   B4  contract-caller must be the hardcoded live core, checked first.
;;   B5  repay goes to the hardcoded core; the `core` argument must equal it.
;;   C7  the owner arms one loan (amount + both minimums); the callback requires
;;       an exact amount match and clears the arm before swapping. A stranger's
;;       flash-loan naming this receiver reverts unless it matches an arm the
;;       owner set, and then it only does what the owner already asked for.
;;   C8  both minimums are in the OUTPUT token's units (micro-STX for leg 1,
;;       sats for leg 2), set by the owner, never derived from `amount`.
;;   D11 plain SIP-010 transfer to the core, never deposit or a swap into it.
;;   D12 fee from the core's own get-fee-basis-points, max(1, floor(...)).
;;   E16 no setter for any principal. E17 rescue is owner-only, to the owner,
;;       nonzero. E18 two-step ownership transfer.
;;
;; Deployed under an external wallet, so every reference is an absolute mainnet
;; principal (`.name` would resolve to this deployer).
;;
;; Live contracts used (pool 21 read on-chain 2026-10-14, get-pool):
;;   Core:        SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-sbtc-core
;;   sBTC:        SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token   (pool x-token)
;;   STX wrapper: SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2 (pool y-token)
;;   XYK core:    SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-core-v-1-2
;;   Pool 21:     SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1
;;
;; Clarity version: 3

(impl-trait 'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.sbtc-flash-receiver-trait.sbtc-flash-receiver-trait)

;; =============================================
;; Constants
;; =============================================

(define-constant FLASH-CORE 'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-sbtc-core)

(define-constant ERR-NOT-OWNER     (err u600))
(define-constant ERR-NOT-CORE      (err u601))
(define-constant ERR-NOT-ARMED     (err u602))
(define-constant ERR-WRONG-AMOUNT  (err u603))
(define-constant ERR-FEE-LOOKUP    (err u604))
(define-constant ERR-SWAP-LEG1     (err u605))
(define-constant ERR-SWAP-LEG2     (err u606))
(define-constant ERR-INSUFFICIENT  (err u607))
(define-constant ERR-REPAY-FAILED  (err u608))
(define-constant ERR-ZERO-AMOUNT   (err u609))
(define-constant ERR-NOT-PENDING   (err u610))
(define-constant ERR-RESCUE-FAILED (err u611))

;; =============================================
;; State
;; =============================================

(define-data-var contract-owner principal tx-sender)
(define-data-var pending-owner (optional principal) none)

;; One prepared loan. Cleared by the callback before any swap.
(define-data-var armed (optional { amount: uint, min-stx-out: uint, min-sbtc-out: uint }) none)

;; =============================================
;; Flash Loan Callback
;; =============================================

(define-public (execute-sbtc-flash (amount uint) (core principal))
  (begin
    (asserts! (is-eq contract-caller FLASH-CORE) ERR-NOT-CORE)
    (asserts! (is-eq core FLASH-CORE) ERR-NOT-CORE)
    (let (
      (arm        (unwrap! (var-get armed) ERR-NOT-ARMED))
      (fee-bp     (unwrap! (contract-call? 'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-sbtc-core
                    get-fee-basis-points) ERR-FEE-LOOKUP))
      (raw-fee    (/ (* amount fee-bp) u10000))
      (fee        (if (> raw-fee u0) raw-fee u1))
      (total-owed (+ amount fee))
    )
      (asserts! (is-eq amount (get amount arm)) ERR-WRONG-AMOUNT)
      (var-set armed none)

      ;; Leg 1: sBTC (x) -> STX (y). Returns the micro-STX received.
      (let (
        (stx-out (unwrap! (as-contract (contract-call? 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-core-v-1-2
          swap-x-for-y
          'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1
          'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
          'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2
          amount
          (get min-stx-out arm))) ERR-SWAP-LEG1))
      )
        ;; Leg 2: STX (y) -> sBTC (x), all of leg 1's output.
        (unwrap! (as-contract (contract-call? 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-core-v-1-2
          swap-y-for-x
          'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1
          'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
          'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2
          stx-out
          (get min-sbtc-out arm))) ERR-SWAP-LEG2)

        (let ((sbtc-now (unwrap!
            (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token get-balance (as-contract tx-sender))
            ERR-REPAY-FAILED)))
          (asserts! (>= sbtc-now total-owed) ERR-INSUFFICIENT)
          (unwrap!
            (as-contract (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
              transfer total-owed tx-sender FLASH-CORE none))
            ERR-REPAY-FAILED)
          (print { event: "sbtc-bitflow-roundtrip", amount: amount, fee: fee,
                   stx-mid: stx-out, sbtc-before-repay: sbtc-now })
          (ok true)
        )
      )
    )
  )
)

;; =============================================
;; Owner: arm one loan
;; =============================================

;; Both minimums must be nonzero: Bitflow rejects min-dy / min-dx of u0.
(define-public (arm-loan (amount uint) (min-stx-out uint) (min-sbtc-out uint))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR-NOT-OWNER)
    (asserts! (and (> amount u0) (> min-stx-out u0) (> min-sbtc-out u0)) ERR-ZERO-AMOUNT)
    (ok (var-set armed (some { amount: amount, min-stx-out: min-stx-out, min-sbtc-out: min-sbtc-out })))
  )
)

(define-public (disarm)
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR-NOT-OWNER)
    (ok (var-set armed none))
  )
)

;; =============================================
;; Owner: rescue (to the owner only)
;; =============================================

(define-public (rescue-sbtc (amount uint))
  (let ((owner (var-get contract-owner)))
    (asserts! (is-eq tx-sender owner) ERR-NOT-OWNER)
    (asserts! (> amount u0) ERR-ZERO-AMOUNT)
    (unwrap!
      (as-contract (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        transfer amount tx-sender owner none))
      ERR-RESCUE-FAILED)
    (ok true)
  )
)

;; Leg 2 spends all of leg 1's STX, so none should remain. Kept as a fail-safe.
(define-public (rescue-stx (amount uint))
  (let ((owner (var-get contract-owner)))
    (asserts! (is-eq tx-sender owner) ERR-NOT-OWNER)
    (asserts! (> amount u0) ERR-ZERO-AMOUNT)
    (unwrap! (as-contract (stx-transfer? amount tx-sender owner)) ERR-RESCUE-FAILED)
    (ok true)
  )
)

;; =============================================
;; Owner: two-step ownership transfer
;; =============================================

(define-public (propose-owner (new-owner principal))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR-NOT-OWNER)
    (ok (var-set pending-owner (some new-owner)))
  )
)

(define-public (accept-ownership)
  (begin
    (asserts! (is-eq (some tx-sender) (var-get pending-owner)) ERR-NOT-PENDING)
    (var-set contract-owner tx-sender)
    (var-set pending-owner none)
    (var-set armed none)
    (ok true)
  )
)

;; =============================================
;; Read-only
;; =============================================

(define-read-only (get-owner) (ok (var-get contract-owner)))
(define-read-only (get-pending-owner) (ok (var-get pending-owner)))
(define-read-only (get-armed) (ok (var-get armed)))

(define-read-only (get-sbtc-balance)
  (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token get-balance (as-contract tx-sender))
)
