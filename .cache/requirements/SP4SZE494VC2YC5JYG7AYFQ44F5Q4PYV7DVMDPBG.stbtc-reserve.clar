(define-data-var sbtc-staking uint u0)
(define-data-var sbtc-for-withdrawals uint u0)


(define-read-only (get-sbtc-for-withdrawals)
  (var-get sbtc-for-withdrawals)
)

(define-read-only (get-sbtc-staking)
  (var-get sbtc-staking)
)

(define-read-only (get-sbtc-balance)
  (unwrap-panic (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token get-balance current-contract))
)

(define-read-only (get-total-sbtc)
  (+ (get-sbtc-balance) (var-get sbtc-staking))
)

(define-read-only (get-sbtc-available)
  (let (
    (balance (get-sbtc-balance))
    (reserved (var-get sbtc-for-withdrawals))
  )
    (if (> balance reserved) (- balance reserved) u0)
  )
)


(define-public (lock-sbtc-for-withdrawal (sbtc-amount uint))
  (begin
    (try! (contract-call? .dao check-is-protocol contract-caller))

    (var-set sbtc-for-withdrawals (+ (var-get sbtc-for-withdrawals) sbtc-amount))
    (print { action: "lock-sbtc-for-withdrawal", data: { sbtc-amount: sbtc-amount, block-height: stacks-block-height } })
    (ok sbtc-amount)
  )
)

(define-public (request-sbtc-for-withdrawal (requested-sbtc uint) (receiver principal))
  (begin
    (try! (contract-call? .dao check-is-protocol contract-caller))

    (var-set sbtc-for-withdrawals (- (var-get sbtc-for-withdrawals) requested-sbtc))
    (try! (as-contract?
      ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" requested-sbtc))
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer requested-sbtc tx-sender receiver none))
    ))
    (print { action: "request-sbtc-for-withdrawal", data: { requested-sbtc: requested-sbtc, receiver: receiver, block-height: stacks-block-height } })
    (ok requested-sbtc)
  )
)

(define-public (unlock-sbtc-from-withdrawal (sbtc-amount uint))
  (begin
    (try! (contract-call? .dao check-is-protocol contract-caller))

    (var-set sbtc-for-withdrawals (- (var-get sbtc-for-withdrawals) sbtc-amount))
    (print { action: "unlock-sbtc-from-withdrawal", data: { sbtc-amount: sbtc-amount, block-height: stacks-block-height } })
    (ok sbtc-amount)
  )
)

(define-public (pay-sbtc-from-idle (sbtc-amount uint) (receiver principal))
  (begin
    (try! (contract-call? .dao check-is-protocol contract-caller))
    (try! (as-contract?
      ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" sbtc-amount))
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer sbtc-amount tx-sender receiver none))
    ))
    (print { action: "pay-sbtc-from-idle", data: { sbtc-amount: sbtc-amount, receiver: receiver, block-height: stacks-block-height } })
    (ok sbtc-amount)
  )
)


(define-public (request-sbtc-to-stack (requested-sbtc uint))
  (let (
    (receiver contract-caller)
  )
    (try! (contract-call? .dao check-is-protocol contract-caller))
    (try! (contract-call? .dao check-is-enabled))
    (asserts! (>= (get-sbtc-available) requested-sbtc) ERR_RESERVED)
    (var-set sbtc-staking (+ (var-get sbtc-staking) requested-sbtc))
    (try! (as-contract?
      ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" requested-sbtc))
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer requested-sbtc tx-sender receiver none))
    ))
    (print { action: "request-sbtc-to-stack", data: { requested-sbtc: requested-sbtc, receiver: receiver, block-height: stacks-block-height } })
    (ok requested-sbtc)
  )
)

(define-public (return-sbtc-from-stacking (sbtc-amount uint))
  (begin
    (try! (contract-call? .dao check-is-protocol contract-caller))
    (try! (contract-call? .dao check-is-enabled))

    (var-set sbtc-staking (- (var-get sbtc-staking) sbtc-amount))
    (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer sbtc-amount tx-sender current-contract none))
    (print { action: "return-sbtc-from-stacking", data: { sbtc-amount: sbtc-amount, block-height: stacks-block-height } })
    (ok sbtc-amount)
  )
)

(define-constant ERR_RESERVED (err u22001))

(define-public (get-sbtc (requested-sbtc uint) (receiver principal))
  (begin
    (try! (contract-call? .dao check-is-protocol contract-caller))
    (asserts! (>= (get-sbtc-balance) (+ requested-sbtc (var-get sbtc-for-withdrawals))) ERR_RESERVED)
    (try! (as-contract?
      ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" requested-sbtc))
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer requested-sbtc tx-sender receiver none))
    ))
    (print { action: "get-sbtc", data: { requested-sbtc: requested-sbtc, receiver: receiver, block-height: stacks-block-height } })
    (ok requested-sbtc)
  )
)
