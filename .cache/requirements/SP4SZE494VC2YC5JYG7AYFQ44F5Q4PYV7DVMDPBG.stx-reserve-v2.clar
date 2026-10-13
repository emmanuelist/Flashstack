(define-data-var stx-staking uint u0)
(define-data-var stx-for-withdrawals-ststx uint u0)
(define-data-var stx-for-withdrawals-ststxbtc uint u0)

(define-data-var stx-for-ststxbtc-idle uint u0)
(define-data-var migrated bool false)

(define-constant ERR_RESERVED (err u23001))
(define-constant ERR_ALREADY_MIGRATED (err u23002))
(define-constant ERR_NOT_MIGRATION (err u23003))
(define-constant ERR_NOT_PRISTINE (err u23004))


(define-read-only (get-stx-for-withdrawals)
  (var-get stx-for-withdrawals-ststx)
)

(define-read-only (get-stx-for-withdrawals-ststxbtc)
  (var-get stx-for-withdrawals-ststxbtc)
)











(define-data-var escrow-cores (list 20 principal) (list
  .stacking-dao-core-btc-v1 .stacking-dao-core-btc-v2 .stacking-dao-core-btc-v3
  .stacking-dao-core-ststxbtc-v1))

(define-read-only (get-escrow-cores) (var-get escrow-cores))

(define-public (set-escrow-cores (cores (list 20 principal)))
  (begin
    (try! (contract-call? .dao check-is-protocol contract-caller))
    (var-set escrow-cores cores)
    (print { action: "set-escrow-cores", data: { cores: cores } })
    (ok true)))

(define-private (add-core-btc-balance (core principal) (acc uint))
  (+ acc (unwrap-panic (contract-call? .ststxbtc-token-v2 get-balance core))))

(define-read-only (get-escrowed-ststxbtc)
  (fold add-core-btc-balance (var-get escrow-cores) u0))

(define-read-only (get-stx-for-ststxbtc)
  (let (
    (supply (unwrap-panic (contract-call? .ststxbtc-token-v2 get-total-supply)))
    (escrow (get-escrowed-ststxbtc))
  )
    (if (> supply escrow) (- supply escrow) u0)
  )
)

(define-read-only (get-stx-for-ststxbtc-idle)
  (var-get stx-for-ststxbtc-idle)
)

(define-read-only (get-stx-staking)
  (var-get stx-staking)
)

(define-read-only (get-stx-balance)
  (stx-get-balance current-contract)
)

(define-read-only (get-total-stx)
  (+ (stx-get-balance current-contract) (var-get stx-staking))
)

(define-read-only (get-stx-available)
  (let (
    (balance (stx-get-balance current-contract))
    (claimed (+ (var-get stx-for-withdrawals-ststx) (var-get stx-for-ststxbtc-idle)))
  )
    (if (> balance claimed) (- balance claimed) u0)
  )
)


(define-public (lock-stx-for-withdrawal (stx-amount uint))
  (begin
    (try! (contract-call? .dao check-is-protocol contract-caller))
    (var-set stx-for-withdrawals-ststx (+ (var-get stx-for-withdrawals-ststx) stx-amount))
    (print { action: "lock-stx-for-withdrawal", data: { stx-amount: stx-amount, block-height: stacks-block-height } })
    (ok stx-amount)
  )
)

(define-public (request-stx-for-withdrawal (requested-stx uint) (receiver principal))
  (begin
    (try! (contract-call? .dao check-is-protocol contract-caller))
    (asserts! (>= (stx-get-balance current-contract) (+ requested-stx (var-get stx-for-ststxbtc-idle))) ERR_RESERVED)
    (var-set stx-for-withdrawals-ststx (- (var-get stx-for-withdrawals-ststx) requested-stx))
    (try! (as-contract?
      ((with-stx requested-stx))
      (try! (stx-transfer? requested-stx current-contract receiver))
    ))
    (print { action: "request-stx-for-withdrawal", data: { requested-stx: requested-stx, receiver: receiver, block-height: stacks-block-height } })
    (ok requested-stx)
  )
)

(define-public (unlock-stx-from-withdrawal (stx-amount uint))
  (begin
    (try! (contract-call? .dao check-is-protocol contract-caller))
    (var-set stx-for-withdrawals-ststx (- (var-get stx-for-withdrawals-ststx) stx-amount))
    (print { action: "unlock-stx-from-withdrawal", data: { stx-amount: stx-amount, block-height: stacks-block-height } })
    (ok stx-amount)
  )
)


(define-public (lock-stx-for-withdrawal-ststxbtc (stx-amount uint))
  (begin
    (try! (contract-call? .dao check-is-protocol contract-caller))
    (var-set stx-for-withdrawals-ststxbtc (+ (var-get stx-for-withdrawals-ststxbtc) stx-amount))
    (print { action: "lock-stx-for-withdrawal-ststxbtc", data: { stx-amount: stx-amount, block-height: stacks-block-height } })
    (ok stx-amount)
  )
)

(define-public (request-stx-for-withdrawal-ststxbtc (requested-stx uint) (receiver principal))
  (begin
    (try! (contract-call? .dao check-is-protocol contract-caller))
    (asserts! (>= (var-get stx-for-ststxbtc-idle) requested-stx) ERR_RESERVED)
    (var-set stx-for-withdrawals-ststxbtc (- (var-get stx-for-withdrawals-ststxbtc) requested-stx))

    (var-set stx-for-ststxbtc-idle (- (var-get stx-for-ststxbtc-idle) requested-stx))
    (try! (as-contract?
      ((with-stx requested-stx))
      (try! (stx-transfer? requested-stx current-contract receiver))
    ))
    (print { action: "request-stx-for-withdrawal-ststxbtc", data: { requested-stx: requested-stx, receiver: receiver, block-height: stacks-block-height } })
    (ok requested-stx)
  )
)


(define-public (lock-stx-for-ststxbtc (stx-amount uint))
  (begin
    (try! (contract-call? .dao check-is-protocol contract-caller))

    (var-set stx-for-ststxbtc-idle (+ (var-get stx-for-ststxbtc-idle) stx-amount))
    (print { action: "lock-stx-for-ststxbtc", data: { stx-amount: stx-amount, block-height: stacks-block-height } })
    (ok stx-amount)
  )
)

(define-public (unlock-stx-for-ststxbtc (stx-amount uint))
  (begin
    (try! (contract-call? .dao check-is-protocol contract-caller))


    (let ((idle (var-get stx-for-ststxbtc-idle)))
      (asserts! (>= idle (+ stx-amount (var-get stx-for-withdrawals-ststxbtc))) ERR_RESERVED)
      (var-set stx-for-ststxbtc-idle (- idle stx-amount))
    )
    (print { action: "unlock-stx-for-ststxbtc", data: { stx-amount: stx-amount, block-height: stacks-block-height } })
    (ok stx-amount)
  )
)


(define-public (pay-stx-from-idle (stx-amount uint) (receiver principal))
  (begin
    (try! (contract-call? .dao check-is-protocol contract-caller))
    (asserts! (>= (stx-get-balance current-contract) (+ stx-amount (+ (var-get stx-for-withdrawals-ststx) (var-get stx-for-ststxbtc-idle)))) ERR_RESERVED)
    (try! (as-contract?
      ((with-stx stx-amount))
      (try! (stx-transfer? stx-amount current-contract receiver))
    ))
    (print { action: "pay-stx-from-idle", data: { stx-amount: stx-amount, receiver: receiver, block-height: stacks-block-height } })
    (ok stx-amount)
  )
)

(define-public (pay-stx-from-idle-ststxbtc (stx-amount uint) (receiver principal))
  (begin
    (try! (contract-call? .dao check-is-protocol contract-caller))
    (asserts! (>= (var-get stx-for-ststxbtc-idle) (+ stx-amount (var-get stx-for-withdrawals-ststxbtc))) ERR_RESERVED)

    (var-set stx-for-ststxbtc-idle (- (var-get stx-for-ststxbtc-idle) stx-amount))
    (try! (as-contract?
      ((with-stx stx-amount))
      (try! (stx-transfer? stx-amount current-contract receiver))
    ))
    (print { action: "pay-stx-from-idle-ststxbtc", data: { stx-amount: stx-amount, receiver: receiver, block-height: stacks-block-height } })
    (ok stx-amount)
  )
)


(define-public (request-stx-to-stack (requested-stx uint))
  (let ((receiver contract-caller))
    (try! (contract-call? .dao check-is-protocol contract-caller))
    (try! (contract-call? .dao check-is-enabled))
    (asserts! (>= (stx-get-balance current-contract) (+ requested-stx (+ (var-get stx-for-withdrawals-ststx) (var-get stx-for-ststxbtc-idle)))) ERR_RESERVED)
    (var-set stx-staking (+ (var-get stx-staking) requested-stx))
    (try! (as-contract?
      ((with-stx requested-stx))
      (try! (stx-transfer? requested-stx current-contract receiver))
    ))
    (print { action: "request-stx-to-stack", data: { requested-stx: requested-stx, receiver: receiver, block-height: stacks-block-height } })
    (ok requested-stx)
  )
)


(define-public (request-stx-for-staking (ststx-amount uint) (ststxbtc-amount uint))

  (let ((receiver contract-caller))
    (try! (contract-call? .dao check-is-protocol contract-caller))
    (try! (contract-call? .dao check-is-enabled))
    (asserts! (or (is-eq ststx-amount u0)
                  (>= (stx-get-balance current-contract) (+ ststx-amount (+ (var-get stx-for-withdrawals-ststx) (var-get stx-for-ststxbtc-idle))))) ERR_RESERVED)
    (asserts! (or (is-eq ststxbtc-amount u0)
                  (>= (var-get stx-for-ststxbtc-idle) (+ ststxbtc-amount (var-get stx-for-withdrawals-ststxbtc)))) ERR_RESERVED)
    (var-set stx-for-ststxbtc-idle (- (var-get stx-for-ststxbtc-idle) ststxbtc-amount))
    (var-set stx-staking (+ (var-get stx-staking) (+ ststx-amount ststxbtc-amount)))
    (try! (as-contract?
      ((with-stx (+ ststx-amount ststxbtc-amount)))
      (try! (stx-transfer? (+ ststx-amount ststxbtc-amount) current-contract receiver))
    ))
    (print { action: "request-stx-for-staking", data: { ststx-amount: ststx-amount, ststxbtc-amount: ststxbtc-amount, receiver: receiver, block-height: stacks-block-height } })
    (ok (+ ststx-amount ststxbtc-amount))
  )
)


(define-public (return-stx-from-stacking (stx-amount uint))
  (begin
    (try! (contract-call? .dao check-is-protocol contract-caller))
    (try! (contract-call? .dao check-is-enabled))
    (var-set stx-staking (- (var-get stx-staking) stx-amount))
    (try! (stx-transfer? stx-amount tx-sender current-contract))
    (print { action: "return-stx-from-stacking", data: { stx-amount: stx-amount, block-height: stacks-block-height } })
    (ok stx-amount)
  )
)


(define-public (return-stx-from-staking-split (ststx-amount uint) (ststxbtc-amount uint))
  (let (
    (earmark (get-stx-for-ststxbtc))
    (idle (var-get stx-for-ststxbtc-idle))
    (staked-ststxbtc (if (> earmark idle) (- earmark idle) u0))
    (staking (var-get stx-staking))
    (staked-ststx (if (> staking staked-ststxbtc) (- staking staked-ststxbtc) u0))
  )
    (try! (contract-call? .dao check-is-protocol contract-caller))
    (try! (contract-call? .dao check-is-enabled))
    (asserts! (>= staked-ststxbtc ststxbtc-amount) ERR_RESERVED)
    (asserts! (>= staked-ststx ststx-amount) ERR_RESERVED)
    (var-set stx-for-ststxbtc-idle (+ (var-get stx-for-ststxbtc-idle) ststxbtc-amount))
    (var-set stx-staking (- (var-get stx-staking) (+ ststx-amount ststxbtc-amount)))
    (try! (stx-transfer? (+ ststx-amount ststxbtc-amount) tx-sender current-contract))
    (print { action: "return-stx-from-staking-split", data: { ststx-amount: ststx-amount, ststxbtc-amount: ststxbtc-amount, block-height: stacks-block-height } })
    (ok (+ ststx-amount ststxbtc-amount))
  )
)


(define-public (get-stx (requested-stx uint) (receiver principal))
  (begin
    (try! (contract-call? .dao check-is-protocol contract-caller))
    (asserts! (>= (stx-get-balance current-contract) (+ requested-stx (+ (var-get stx-for-withdrawals-ststx) (var-get stx-for-ststxbtc-idle)))) ERR_RESERVED)
    (try! (as-contract?
      ((with-stx requested-stx))
      (try! (stx-transfer? requested-stx current-contract receiver))
    ))
    (print { action: "get-stx", data: { requested-stx: requested-stx, receiver: receiver, block-height: stacks-block-height } })
    (ok requested-stx)
  )
)





(define-public (receive-migration (staking uint) (idle uint) (wd-ststx uint) (wd-ststxbtc uint))
  (begin


    (asserts! (is-eq contract-caller .migration-v3) ERR_NOT_MIGRATION)
    (asserts! (not (var-get migrated)) ERR_ALREADY_MIGRATED)


    (asserts! (and (is-eq (var-get stx-for-ststxbtc-idle) u0)
                   (is-eq (var-get stx-for-withdrawals-ststx) u0)
                   (is-eq (var-get stx-for-withdrawals-ststxbtc) u0)
                   (is-eq (var-get stx-staking) u0)) ERR_NOT_PRISTINE)
    (var-set stx-staking staking)
    (var-set stx-for-ststxbtc-idle idle)
    (var-set stx-for-withdrawals-ststx wd-ststx)
    (var-set stx-for-withdrawals-ststxbtc wd-ststxbtc)
    (var-set migrated true)
    (print { action: "receive-migration", data: { staking: staking, idle: idle, wd-ststx: wd-ststx, wd-ststxbtc: wd-ststxbtc, block-height: stacks-block-height } })
    (ok true)
  )
)
