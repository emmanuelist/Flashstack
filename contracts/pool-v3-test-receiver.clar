;; FlashStack Pool v3 -- Testnet Happy-Path Receiver
;;
;; Proves flashstack-pool-v3's real execute-flash round trip end to end
;; (docs/TESTNET_STAGING.md section 8 action 7/8: pool-v3 was explicitly "not covered"
;; by the existing testnet plan -- this is what closes that gap). Repays
;; principal + fee for whichever listed asset it's called with, fee computed
;; live from the pool's own get-asset rather than assumed.
;;
;; Same shape as contracts/test/test-pool-v3-receiver-good.clar (the simnet
;; unit-test version), adapted for a REAL testnet publish: lives in
;; contracts/, not contracts/test/, same reasoning as
;; contracts/stx-underpay-receiver-v2.clar -- a section-6-checklist receiver has to
;; actually be published on chain, a contracts/test/ copy never is.
;;
;; Needs a pre-funded buffer of the listed asset (at least the fee) before a
;; flash-loan is attempted against it, same operational requirement as
;; stx-test-receiver-v2 / stx-underpay-receiver-v2.
;;
;; Bound to .flashstack-pool-v3 and .flashstack-v3-receiver-trait by name
;; (same-deployer references, no testnet localization needed for either). The
;; sip-010-trait reference below is the real mainnet SIP-010 standard
;; principal, same as flashstack-pool-v3.clar's own use-trait -- it is in
;; scripts/lib/testnet-localize.mjs's OURS table (FlashStack publishes its own
;; copy first on testnet), so deploy-testnet-pool-v3.mjs rewrites it to the
;; testnet deployer automatically, the same mechanism every other contract in
;; this generation already relies on.
;;
;; SECURITY (flagged in review): the first version of this file had the F-10
;; shape -- no contract-caller gate, repaid to the caller-supplied `core`
;; argument instead of a hardcoded target -- so anyone could call
;; execute-flash directly and redirect this contract's balance anywhere.
;; TESTNET ONLY -- holds only a small test buffer and is never meant to be
;; approved on mainnet -- but gated for real anyway rather than left to a
;; comment, same discipline as every other receiver in this project.

(impl-trait .flashstack-v3-receiver-trait.flashstack-v3-receiver-trait)
(use-trait sip-010-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)

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
      ;; Repay to the hardcoded pool, not the caller-supplied `core` -- the
      ;; trait requires the parameter, but trusting it is exactly the F-10 gap.
      (unwrap! (as-contract (contract-call? token transfer (+ amount fee) tx-sender .flashstack-pool-v3 none)) ERR-REPAY)
      (ok true)
    )
  )
)
