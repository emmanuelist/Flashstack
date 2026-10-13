(define-constant DENOMINATOR_8 u100000000)

(define-data-var pending-shares uint u0)

(define-read-only (get-pending-shares)
  (var-get pending-shares)
)

(define-public (add-pending-shares (amount uint))
  (begin
    (try! (contract-call? .dao check-is-protocol contract-caller))
    (var-set pending-shares (+ (var-get pending-shares) amount))
    (ok true)
  )
)

(define-public (remove-pending-shares (amount uint))
  (begin
    (try! (contract-call? .dao check-is-protocol contract-caller))
    (var-set pending-shares (- (var-get pending-shares) amount))
    (ok true)
  )
)


(define-private (compute-ratio (round-up bool))
  (let (
    (total-sbtc (contract-call? .stbtc-reserve get-total-sbtc))
    (reserved (contract-call? .stbtc-reserve get-sbtc-for-withdrawals))
    (active-backing (if (> total-sbtc reserved) (- total-sbtc reserved) u0))
    (stbtc-supply (unwrap-panic (contract-call? .stbtc-token get-total-supply)))
    (active-supply (- stbtc-supply (var-get pending-shares)))
    (raw-num (* active-backing DENOMINATOR_8))
  )
    (if (is-eq active-supply u0)
      DENOMINATOR_8
      (if round-up
        (if (is-eq (mod raw-num active-supply) u0)
          (/ raw-num active-supply)
          (+ (/ raw-num active-supply) u1)
        )
        (/ raw-num active-supply)
      )
    )
  )
)

(define-read-only (get-sbtc-per-stbtc)
  (compute-ratio false)
)

(define-read-only (get-sbtc-per-stbtc-up)
  (compute-ratio true)
)
