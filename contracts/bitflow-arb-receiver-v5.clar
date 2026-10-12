;; bitflow-arb-receiver-v5.clar
;; FlashStack - Bitflow STX/stSTX Arbitrage Receiver
;;
;; v5: hardened rewrite, porting the alex-arb-receiver-v5 pattern onto
;; Bitflow's actual swap mechanics. v1-v4 (bitflow-arb-receiver / -v2/-v3/-v4)
;; were found vulnerable under F-10 (no contract-caller check, repaid to a
;; caller-supplied `core` instead of a hardcoded one) and removed from
;; flashstack-stx-core's approved-receiver list. This is the real fix the
;; F-10 removal itself was never meant to be -- removal stopped new loans
;; from reaching the old receivers, it didn't make Bitflow arb usable again.
;;
;; v5 changes vs v1-v4:
;;   [critical] contract-caller == FLASH-CORE asserted -- v1-v4 had no gate,
;;              anyone could call execute-stx-flash directly
;;   [critical] Repay goes to hardcoded FLASH-CORE, never the caller-supplied
;;              `core` parameter (still accepted for trait compliance, but
;;              asserted == FLASH-CORE as defense-in-depth, same as ALEX v5)
;;   [hardening] min-ststx-out: required pre-set slippage floor (was present
;;              in v3, dropped to a flat u1 "accept anything" in v4 -- v5
;;              restores it and makes it mandatory, auto-reset after each use)
;;   [hardening] Leg 1's output captured directly from swap-x-for-y's return
;;              value (confirmed live: stableswap-stx-ststx-v-1-2 returns the
;;              exact output amount, (response uint128 ...), not a get-balance
;;              read after the fact) -- same anti-pollution reasoning as ALEX
;;              v5's [M-1]: a stale stSTX balance already in the contract
;;              can't inflate what Leg 2 swaps
;;   [hardening] max-fee-bp guard against a flash-fee increase between
;;              simulation and execution
;;   [hardening] min-profit floor, minimum loan amount, two-step ownership,
;;              print events, rescue functions validate amount > 0
;;
;; Flow:
;;   1. Owner calls set-max-fee-bp (maximum acceptable flash fee, set once)
;;   2. Owner calls set-min-ststx-out (simulate via BITFLOW-POOL.get-dy off-chain,
;;      apply slippage tolerance)
;;   3. Owner calls set-min-profit (minimum acceptable STX profit after fees)
;;   4. Call flashstack-stx-core.flash-loan(amount, this-contract)
;;   5. Core calls execute-stx-flash (only core can call this)
;;   6. Leg 1: STX -> stSTX on Bitflow stableswap (slippage guarded, exact
;;      output captured from the swap's own return value)
;;   7. Leg 2: stSTX -> STX, using only the stSTX received from Leg 1, floor
;;      = total-owed + min-profit
;;   8. Assert fee <= max-fee-bp, assert profit >= min-profit
;;   9. Repay to hardcoded FLASH-CORE, reset min-ststx-out to u0
;;  10. Profit stays in contract, owner sweeps with rescue-stx

(impl-trait 'SP3TGRVG7DKGFVRTTVGGS60S59R916FWB4DAB9STZ.stx-flash-receiver-trait.stx-flash-receiver-trait)

;; Minimal SIP-010 trait for calling stSTX token
(define-trait sip-010-trait
  (
    (transfer (uint principal principal (optional (buff 34))) (response bool uint))
    (get-name () (response (string-ascii 32) uint))
    (get-symbol () (response (string-ascii 32) uint))
    (get-decimals () (response uint uint))
    (get-balance (principal) (response uint uint))
    (get-total-supply () (response uint uint))
    (get-token-uri () (response (optional (string-utf8 256)) uint))
  )
)

;; =============================================
;; Constants
;; =============================================

(define-constant BASIS-POINTS u10000)

;; Minimum loan size to avoid integer rounding edge cases with fee floor.
;; u1000000 = 1 STX.
(define-constant MIN-LOAN-AMOUNT u1000000)

;; Hardcoded flash core -- repayment never goes to caller-supplied address
(define-constant FLASH-CORE 'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-stx-core)

;; Bitflow STX/stSTX stableswap pool (confirmed from mainnet, same pool v1-v4 used)
(define-constant BITFLOW-POOL 'SPQC38PW542EQJ5M11CR25P7BS1CA6QT4TBXGB3M.stableswap-stx-ststx-v-1-2)
(define-constant STSTX       'SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token)
(define-constant BITFLOW-LP  'SPQC38PW542EQJ5M11CR25P7BS1CA6QT4TBXGB3M.stx-ststx-lp-token-v-1-2)

;; Error codes
(define-constant ERR-NOT-OWNER        (err u500))
(define-constant ERR-SWAP-FAILED      (err u501))
(define-constant ERR-NO-PROFIT        (err u502))
(define-constant ERR-REPAY-FAILED     (err u503))
(define-constant ERR-TRANSFER-FAILED  (err u504))
(define-constant ERR-NOT-CORE         (err u505))
(define-constant ERR-NOT-PENDING      (err u506))
(define-constant ERR-MIN-STSTX-UNSET  (err u507))
(define-constant ERR-LOAN-TOO-SMALL   (err u508))
(define-constant ERR-FEE-TOO-HIGH     (err u509))
(define-constant ERR-ZERO-AMOUNT      (err u510))

;; =============================================
;; State
;; =============================================

(define-data-var contract-owner  principal tx-sender)
(define-data-var pending-owner   (optional principal) none)

;; Pre-set before each flash loan call (off-chain: call BITFLOW-POOL.get-dy,
;; apply slippage tolerance).
;; min-ststx-out: minimum stSTX to accept from Leg 1 (slippage guard).
;;                Defaults to u0 which is INVALID -- execute-stx-flash will revert.
;;                Auto-reset to u0 after each successful execution.
;; min-profit:    minimum STX profit to accept after repayment (anti-griefing)
;; max-fee-bp:    maximum flash fee (basis points) acceptable at execution time.
;;                Protects against a fee increase race condition between
;;                simulation and execution. Default u10 = 0.1%, current
;;                FlashStack fee is u5 = 0.05%.
(define-data-var min-ststx-out   uint u0)
(define-data-var min-profit      uint u1)
(define-data-var max-fee-bp      uint u10)

;; =============================================
;; Flash Loan Callback
;; =============================================

(define-public (execute-stx-flash (amount uint) (core principal))
  (let (
    (fee-bp       (unwrap! (contract-call? FLASH-CORE get-fee-basis-points) ERR-REPAY-FAILED))
    (raw-fee      (/ (* amount fee-bp) BASIS-POINTS))
    (fee          (if (> raw-fee u0) raw-fee u1))
    (total-owed   (+ amount fee))
    (min-ststx    (var-get min-ststx-out))
    (profit-floor (var-get min-profit))
  )
    ;; Only FLASH-CORE may invoke this callback
    (asserts! (is-eq contract-caller FLASH-CORE) ERR-NOT-CORE)

    ;; core parameter accepted for trait compliance; assert matches FLASH-CORE (defense-in-depth)
    (asserts! (is-eq core FLASH-CORE) ERR-NOT-CORE)

    ;; Minimum loan amount guard -- prevents rounding edge cases
    (asserts! (>= amount MIN-LOAN-AMOUNT) ERR-LOAN-TOO-SMALL)

    ;; Slippage pre-set guard -- reverts if owner forgot to call set-min-ststx-out
    (asserts! (> min-ststx u0) ERR-MIN-STSTX-UNSET)

    ;; Fee guard -- reverts if flash core fee was raised since simulation
    (asserts! (<= fee-bp (var-get max-fee-bp)) ERR-FEE-TOO-HIGH)

    ;; Leg 1: STX -> stSTX on Bitflow (slippage guarded by min-ststx-out).
    ;; as-contract required -- STX sits in this contract's balance (sent by
    ;; flashstack-stx-core), so tx-sender must be the receiver contract itself.
    ;; Capture the exact stSTX received directly from the swap's return value
    ;; (confirmed live: swap-x-for-y returns (response uint128 ...)) rather
    ;; than a get-balance read -- a stale stSTX balance already sitting in
    ;; this contract can't inflate what Leg 2 swaps.
    (let ((ststx-received (unwrap! (as-contract (contract-call? BITFLOW-POOL swap-x-for-y
            STSTX
            BITFLOW-LP
            amount
            min-ststx
          )) ERR-SWAP-FAILED)))

      (asserts! (> ststx-received u0) ERR-SWAP-FAILED)

      ;; Leg 2: stSTX -> STX, using only the stSTX received from Leg 1.
      ;; Floor = enough to cover loan + fee + min-profit.
      (let ((min-stx-back (+ total-owed profit-floor)))
        (unwrap! (as-contract (contract-call? BITFLOW-POOL swap-y-for-x
          STSTX
          BITFLOW-LP
          ststx-received
          min-stx-back
        )) ERR-SWAP-FAILED)

        (let ((stx-bal (stx-get-balance (as-contract tx-sender))))
          ;; Minimum profit guard -- reverts if trade was not profitable enough
          (asserts! (>= stx-bal (+ total-owed profit-floor)) ERR-NO-PROFIT)

          ;; Repay to hardcoded FLASH-CORE -- never to caller-supplied core
          (unwrap! (as-contract (stx-transfer? total-owed tx-sender FLASH-CORE)) ERR-REPAY-FAILED)

          ;; Reset min-ststx-out to u0 -- forces explicit re-authorization next loan
          (var-set min-ststx-out u0)

          ;; Emit execution event for off-chain monitoring
          (print {
            event:        "execute-stx-flash",
            amount:       amount,
            ststx-in:     ststx-received,
            stx-back:     stx-bal,
            total-owed:   total-owed,
            profit:       (- stx-bal total-owed),
            fee-bp:       fee-bp,
          })

          ;; Profit remains in contract -- owner sweeps with rescue-stx
          (ok true)
        )
      )
    )
  )
)

;; =============================================
;; Pre-flight Setup (call before each flash loan)
;; =============================================

;; Set minimum acceptable stSTX from Leg 1.
;; Compute off-chain via BITFLOW-POOL.get-dy(STSTX, BITFLOW-LP, loan-amount),
;; apply slippage (e.g. 99% of the quoted output).
;; REQUIRED: execute-stx-flash reverts with ERR-MIN-STSTX-UNSET if this is u0.
;; Auto-reset to u0 after each successful execution.
(define-public (set-min-ststx-out (min-out uint))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR-NOT-OWNER)
    (print { event: "set-min-ststx-out", min-out: min-out })
    (ok (var-set min-ststx-out min-out))
  )
)

;; Set minimum acceptable STX profit after repayment.
;; Prevents griefing and loss-making executions.
(define-public (set-min-profit (min-stx uint))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR-NOT-OWNER)
    (print { event: "set-min-profit", min-stx: min-stx })
    (ok (var-set min-profit min-stx))
  )
)

;; Set maximum acceptable flash fee in basis points.
;; execute-stx-flash reverts with ERR-FEE-TOO-HIGH if live fee exceeds this.
;; Default u10 = 0.1%. Current FlashStack fee is u5 = 0.05%.
;; Raise this only if you expect FlashStack to increase fees.
(define-public (set-max-fee-bp (max-bp uint))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR-NOT-OWNER)
    (print { event: "set-max-fee-bp", max-bp: max-bp })
    (ok (var-set max-fee-bp max-bp))
  )
)

;; =============================================
;; Admin
;; =============================================

;; Two-step ownership transfer -- prevents locking out via typo
(define-public (propose-owner (new-owner principal))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR-NOT-OWNER)
    (print { event: "ownership-proposed", new-owner: new-owner })
    (ok (var-set pending-owner (some new-owner)))
  )
)

(define-public (accept-ownership)
  (let ((pending (unwrap! (var-get pending-owner) ERR-NOT-PENDING)))
    (asserts! (is-eq tx-sender pending) ERR-NOT-PENDING)
    (var-set contract-owner pending)
    (var-set pending-owner none)
    (print { event: "ownership-accepted", new-owner: pending })
    (ok true)
  )
)

(define-public (rescue-stx (amount uint) (to principal))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR-NOT-OWNER)
    (asserts! (> amount u0) ERR-ZERO-AMOUNT)
    (print { event: "rescue-stx", amount: amount, to: to })
    (unwrap! (as-contract (stx-transfer? amount tx-sender to)) ERR-TRANSFER-FAILED)
    (ok true)
  )
)

(define-public (rescue-ststx (amount uint) (to principal))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR-NOT-OWNER)
    (asserts! (> amount u0) ERR-ZERO-AMOUNT)
    (print { event: "rescue-ststx", amount: amount, to: to })
    (unwrap!
      (as-contract (contract-call? STSTX transfer amount tx-sender to none))
      ERR-TRANSFER-FAILED)
    (ok true)
  )
)

;; =============================================
;; Read-only
;; =============================================

;; Planning helper only -- spread-bp/fee-bp must come from a live BITFLOW-POOL.get-dy
;; quote and FLASH-CORE.get-fee-basis-points, not a theoretical price ratio.
;; Race condition: live fee/pool state may change between simulation and execution.
;; ERR-FEE-TOO-HIGH (max-fee-bp) and ERR-NO-PROFIT are the on-chain backstops.
(define-read-only (simulate (loan-amount uint) (spread-bp uint) (fee-bp uint))
  (let (
    (raw-fee (/ (* loan-amount fee-bp) BASIS-POINTS))
    (fee     (if (> raw-fee u0) raw-fee u1))
    (spread  (/ (* loan-amount spread-bp) BASIS-POINTS))
    (profit  (if (> spread fee) (- spread fee) u0))
  )
    {
      loan-amount:  loan-amount,
      spread-bp:    spread-bp,
      fee-bp:       fee-bp,
      spread:       spread,
      flash-fee:    fee,
      net-profit:   profit,
      profitable:   (> spread fee),
      owed-to-core: (+ loan-amount fee),
    }
  )
)

(define-read-only (get-stx-balance)
  (stx-get-balance (as-contract tx-sender))
)

;; Inline principal literal, not the STSTX constant -- Clarinet's read-only
;; purity checker only resolves an as-contract-wrapped call target statically
;; when it's a literal; a define-constant reference here (functionally
;; identical) trips a false "detected a writing operation" error.
(define-read-only (get-ststx-balance)
  (as-contract (contract-call? 'SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token get-balance tx-sender))
)

(define-read-only (get-settings)
  (ok {
    contract-owner: (var-get contract-owner),
    pending-owner:  (var-get pending-owner),
    min-ststx-out:  (var-get min-ststx-out),
    min-profit:     (var-get min-profit),
    max-fee-bp:     (var-get max-fee-bp),
  })
)
