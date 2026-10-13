(use-trait decoder-trait .pyth-lazer-traits.decoder-trait)

(define-constant ERR_UNAUTHORIZED (err u4003))

(define-constant ERR_PAUSED (err u4004))

(define-constant ERR_CANNOT_CHANGE_OWN_GOVERNANCE (err u4005))

(define-constant ERR_INVALID_DECODER (err u1001))

(define-constant ERR_STALE_PRICE (err u1002))

(define-constant MICROS_PER_SECOND u1000000)

(define-constant ROLE_GOVERNANCE 0x00)
(define-constant ROLE_PAUSE 0x01)

(define-map roles
  {
    who: principal,
    role: (buff 1),
  }
  bool
)

(map-set roles {
  who: tx-sender,
  role: ROLE_GOVERNANCE,
} true
)
(map-set roles {
  who: tx-sender,
  role: ROLE_PAUSE,
} true
)

(define-data-var paused bool false)

(define-data-var trusted-signers (list 100
  {
    pubkey: (buff 33),
    expires-at: uint,
  }
) (list))

(define-data-var stale-price-threshold uint (if is-in-mainnet
  u7200
  u157680000
))

(define-data-var decoder principal .pyth-lazer-decoder-v1)

(define-data-var fee uint u0)

(define-data-var fee-recipient principal tx-sender)

(define-read-only (get-trusted-signers)
  (var-get trusted-signers)
)

(define-read-only (get-stale-price-threshold)
  (var-get stale-price-threshold)
)

(define-read-only (get-decoder)
  (var-get decoder)
)

(define-read-only (get-fee)
  (var-get fee)
)

(define-read-only (get-fee-recipient)
  (var-get fee-recipient)
)

(define-read-only (has-role
    (who principal)
    (role (buff 1))
  )
  (default-to false (map-get? roles {
    who: who,
    role: role,
  })
  )
)

(define-read-only (is-paused)
  (var-get paused)
)

(define-read-only (assert-role
    (who principal)
    (role (buff 1))
  )
  (ok (asserts! (has-role who role) ERR_UNAUTHORIZED))
)

(define-read-only (assert-governance (who principal))
  (assert-role who ROLE_GOVERNANCE)
)

(define-read-only (assert-active)
  (ok (asserts! (not (var-get paused)) ERR_PAUSED))
)

(define-public (set-trusted-signers (signers (list 100 {
  pubkey: (buff 33),
  expires-at: uint,
})))
  (begin

    (try! (assert-governance contract-caller))
    (var-set trusted-signers signers)
    (print {
      type: "trusted-signers",
      action: "updated",
      data: { signers: signers },
    })
    (ok true)
  )
)

(define-public (set-stale-price-threshold (seconds uint))
  (begin
    (try! (assert-active))
    (try! (assert-governance contract-caller))
    (var-set stale-price-threshold seconds)
    (print {
      type: "stale-price-threshold",
      action: "updated",
      data: { seconds: seconds },
    })
    (ok true)
  )
)

(define-public (set-decoder (new-decoder <decoder-trait>))
  (begin
    (try! (assert-active))
    (try! (assert-governance contract-caller))
    (let ((new-principal (contract-of new-decoder)))
      (var-set decoder new-principal)
      (print {
        type: "decoder",
        action: "updated",
        data: { new-decoder: new-principal },
      })
      (ok true)
    )
  )
)

(define-public (set-fee (new-fee uint))
  (begin
    (try! (assert-active))
    (try! (assert-governance contract-caller))
    (var-set fee new-fee)
    (print {
      type: "fee",
      action: "updated",
      data: { new-fee: new-fee },
    })
    (ok true)
  )
)

(define-public (set-fee-recipient (new-recipient principal))
  (begin
    (try! (assert-active))
    (try! (assert-governance contract-caller))
    (var-set fee-recipient new-recipient)
    (print {
      type: "fee-recipient",
      action: "updated",
      data: { new-recipient: new-recipient },
    })
    (ok true)
  )
)

(define-public (set-role
    (who principal)
    (role (buff 1))
    (enabled bool)
  )
  (begin
    (try! (assert-active))
    (try! (assert-governance contract-caller))

    (asserts!
      (not (and
        (is-eq role ROLE_GOVERNANCE)
        (is-eq who contract-caller)
      ))
      ERR_CANNOT_CHANGE_OWN_GOVERNANCE
    )
    (if enabled
      (map-set roles {
        who: who,
        role: role,
      } true
      )
      (map-delete roles {
        who: who,
        role: role,
      })
    )
    (print {
      type: "role",
      action: "updated",
      data: {
        who: who,
        role: role,
        enabled: enabled,
      },
    })
    (ok true)
  )
)

(define-public (pause)
  (begin
    (try! (assert-role contract-caller ROLE_PAUSE))
    (var-set paused true)
    (print {
      type: "pause",
      action: "paused",
      data: { caller: contract-caller },
    })
    (ok true)
  )
)

(define-public (unpause)
  (begin
    (try! (assert-role contract-caller ROLE_PAUSE))
    (var-set paused false)
    (print {
      type: "pause",
      action: "unpaused",
      data: { caller: contract-caller },
    })
    (ok true)
  )
)

(define-public (verify-price-feeds
    (update (buff 8192))
    (decoder-contract <decoder-trait>)
    (max-age (optional uint))
  )
  (begin

    (asserts! (is-eq (contract-of decoder-contract) (var-get decoder))
      ERR_INVALID_DECODER
    )
    (let (

        (decoded (try! (contract-call? decoder-contract decode-and-verify-price-feeds update)))
        (publish-time-seconds (/ (get timestamp decoded) MICROS_PER_SECOND))
        (threshold (default-to (var-get stale-price-threshold) max-age))
      )

      (asserts! (>= (+ publish-time-seconds threshold) stacks-block-time)
        ERR_STALE_PRICE
      )
      (try! (charge-fee))
      (ok decoded)
    )
  )
)

(define-private (charge-fee)
  (let (
      (fee-amount (var-get fee))
      (recipient (var-get fee-recipient))
    )
    (if (and (> fee-amount u0) (not (is-eq tx-sender recipient)))
      (stx-transfer? fee-amount tx-sender recipient)
      (ok true)
    )
  )
)
