;; Local simnet copy of contracts/pool-v3-test-receiver.clar.
;; Byte-identical except for the sip-010-trait use-trait target, which points
;; at the local mirror instead of the mainnet principal -- same reason
;; contracts/test/flashstack-v3-receiver-trait.clar does, and required for the
;; same trait-matching reason: this contract's execute-flash takes
;; <sip-010-trait> as a parameter, so clarinet check needs every participant
;; (this file, flashstack-v3-receiver-trait, flashstack-pool-v3) resolving
;; sip-010-trait to the SAME concrete trait, not just a structurally identical
;; one at a different principal.

(impl-trait .flashstack-v3-receiver-trait.flashstack-v3-receiver-trait)
(use-trait sip-010-trait .sip-010-trait-ft-standard.sip-010-trait)

(define-constant ERR-ASSET-LOOKUP-FAILED (err u901))
(define-constant ERR-REPAY               (err u902))
(define-constant ERR-NOT-CORE             (err u903))

(define-public (execute-flash (token <sip-010-trait>) (amount uint) (core principal))
  (begin
    (asserts! (is-eq contract-caller .flashstack-pool-v3) ERR-NOT-CORE)
    (let (
      (cfg     (unwrap! (contract-call? .flashstack-pool-v3 get-asset (contract-of token)) ERR-ASSET-LOOKUP-FAILED))
      (raw-fee (/ (* amount (get fee-bp cfg)) u10000))
      (fee     (if (> raw-fee u0) raw-fee u1))
    )
      (unwrap! (as-contract (contract-call? token transfer (+ amount fee) tx-sender .flashstack-pool-v3 none)) ERR-REPAY)
      (ok true)
    )
  )
)
