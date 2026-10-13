(define-constant DENOMINATOR_6 u1000000)




(define-data-var escrow-cores (list 30 principal) (list
  .stacking-dao-core-v1 .stacking-dao-core-v2 .stacking-dao-core-v3
  .stacking-dao-core-v4 .stacking-dao-core-v5 .stacking-dao-core-v6
  .stacking-dao-core-stx-v1 .stacking-dao-core-stx-v2))

(define-read-only (get-escrow-cores)
  (var-get escrow-cores))

(define-public (set-escrow-cores (cores (list 30 principal)))
  (begin
    (try! (contract-call? .dao check-is-protocol contract-caller))
    (var-set escrow-cores cores)
    (print { action: "set-escrow-cores", data: { cores: cores } })
    (ok true)))




(define-private (add-core-balance (core principal) (acc uint))
  (+ acc (unwrap-panic (contract-call? .ststx-token get-balance core))))


(define-read-only (get-live-escrow)
  (fold add-core-balance (var-get escrow-cores) u0))

(define-private (compute-ratio (round-up bool))
  (let (
    (total-stx (contract-call? .stx-reserve-v2 get-total-stx))
    (stx-for-ststxbtc (contract-call? .stx-reserve-v2 get-stx-for-ststxbtc))
    (stx-for-withdrawals (contract-call? .stx-reserve-v2 get-stx-for-withdrawals))
    (claimed (+ stx-for-ststxbtc stx-for-withdrawals))
    (active-backing (if (> total-stx claimed) (- total-stx claimed) u0))
    (ststx-supply (unwrap-panic (contract-call? .ststx-token get-total-supply)))
    (escrow (get-live-escrow))

    (active-supply (if (> ststx-supply escrow) (- ststx-supply escrow) u0))
    (raw-num (* active-backing DENOMINATOR_6))
  )
    (if (is-eq active-supply u0)
      DENOMINATOR_6
      (if round-up
        (if (is-eq (mod raw-num active-supply) u0)
          (/ raw-num active-supply)
          (+ (/ raw-num active-supply) u1))
        (/ raw-num active-supply)))))


(define-read-only (get-stx-per-ststx)
  (compute-ratio false))

(define-read-only (get-stx-per-ststx-up)
  (compute-ratio true))
