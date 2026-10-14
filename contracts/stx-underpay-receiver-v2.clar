;; STX Under-pay Receiver v2 -- DELIBERATELY BROKEN, for the solvency check only
;; Repays principal + fee MINUS 1 uSTX. flashstack-stx-core-v2 must reject this
;; with ERR-REPAY-FAILED (u302) and roll the whole transaction back, leaving the
;; reserve untouched. Under-paying by 1 (rather than not repaying at all) is the
;; sharper test: the repayment transfer itself succeeds, so the only thing that
;; can stop it is the core's own reserve-after >= reserve-before + fee check.
;;
;; Needs a pre-funded buffer of at least fee - 1 uSTX, otherwise its own transfer
;; fails first (u500) and the core's check is never reached.
;;
;; Same shape and static target as stx-test-receiver-v2.clar: Clarity requires a
;; statically-known contract-call? target, so this is bound to
;; flashstack-stx-core-v2 (route A, Flashstack-ajv.6.3). See docs/TESTNET_STAGING.md section 6.

(impl-trait 'SP3TGRVG7DKGFVRTTVGGS60S59R916FWB4DAB9STZ.stx-flash-receiver-trait.stx-flash-receiver-trait)

(define-constant ERR-REPAY (err u500))

(define-public (execute-stx-flash (amount uint) (core principal))
  (let (
    (fee-bp (unwrap! (contract-call? .flashstack-stx-core-v2 get-fee-basis-points) ERR-REPAY))
    (raw-fee (/ (* amount fee-bp) u10000))
    (fee (if (> raw-fee u0) raw-fee u1))
    (short-by-one (- (+ amount fee) u1))
  )
    ;; Repay 1 uSTX short of principal + fee
    (unwrap! (as-contract (stx-transfer? short-by-one tx-sender core)) ERR-REPAY)
    (ok true)
  )
)
