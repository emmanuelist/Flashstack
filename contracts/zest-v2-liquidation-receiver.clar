;; zest-v2-liquidation-receiver.clar
;; FlashStack Receiver -- Zest Protocol Flash Liquidation
;;
;; v0-8 migration: v0-4-market is dead -- confirmed directly, not assumed.
;; v0-market-vault.get-impl() (the real authorization gate on Zest's shared
;; vault infrastructure) now returns v0-8-market exclusively, on all 7 of
;; Zest's per-asset vaults, with zero exceptions. v0-4-market's own most
;; recent transactions all abort for exactly that reason -- it's no longer
;; the authorized impl, so it can't touch vault state at all anymore.
;;
;; liquidate()'s auth model does NOT need Zest's cooperation -- confirmed
;; directly against the real deployed source, not assumed or just told:
;; `(asserts! (is-eq contract-caller tx-sender) ERR-AUTHORIZATION)` is an
;; anti-proxy guard (satisfied by as-contract, used throughout this
;; contract already), not an integrator whitelist, and liquidate() takes
;; the borrower as an explicit argument -- it was never gated behind
;; whoever holds the position. Confirmed by Zest's CTO (Emil) and
;; independently re-verified by reading the deployed source directly.
;;
;; What v0-8 actually requires that v0-4 didn't: a real signed Pyth Lazer
;; price update on every call, not the old write-feeds-with-none-bypass
;; v0-4 tolerated. Proved this end-to-end before wiring it in here: fetched
;; a real signed update from Pyth's live stream, submitted it to Zest's
;; actual deployed pyth-lazer-decoder-v1.recover-signer (read-only, nothing
;; on-chain touched), and the recovered signer matched Zest's registered
;; trusted pubkey exactly. set-price-feed below is how that buffer gets
;; into this contract -- Clarity can't fetch it itself, so an off-chain
;; keeper must fetch a fresh one and call set-price-feed immediately before
;; every flash-loan call. Auto-reset to none after each use, same reason
;; as the slippage pre-sets below: forces explicit re-fetching, not silent
;; reuse of a stale (and by then probably-expired) signed update.
;;
;; Supported modes (set-target before calling flash-loan):
;;   1 - DISABLED. STX flash -> pay USDCx debt -> receive sBTC collateral
;;      -> swap sBTC->STX -> repay. See SWAP ROUTE note below -- there is
;;      currently no valid Velar pool for this leg. set-target rejects
;;      mode 1 with ERR-NO-SWAP-ROUTE.
;;   2 - DISABLED, same reason as mode 1 (USDH debt instead of USDCx).
;;   3 - DISABLED, same reason as mode 1 (wSTX debt instead of USDCx).
;;   4 - STX flash  -> pay wSTX debt  -> receive wSTX collateral -> repay (no swap --
;;      same asset both sides, the flash-borrowed STX itself is the payment,
;;      since Zest's wSTX is a thin passthrough to native STX). The only
;;      mode execute-stx-flash actually runs right now.
;;   5 - sBTC flash -> pay sBTC debt  -> receive sBTC collateral -> repay (no swap,
;;      same reasoning as mode 4 -- goes through execute-sbtc-flash, a
;;      separate entry point, since it needs flashstack-sbtc-core not
;;      flashstack-stx-core)
;;
;; SWAP ROUTE (modes 1-3, disabled -- found while wiring up the keeper
;; bot's live Velar quote, verified directly against chain state, not
;; assumed): VELAR-POOL-SBTC-STX (u70) is NOT the sBTC/STX pool -- it's
;; an unrelated wstx/meme-coin pool (confirmed: token0=wstx, token1 is a
;; meme token). Scanned all 87 Velar pools directly: the only wstx-paired
;; pool with "sbtc" in its token name is id 60, but it trades
;; SP3R4MHK99JAAM0N3T0CBZRZVSVQFG1N75DQ08JSD.sbtc -- a DIFFERENT contract
;; from the canonical sBTC (SM3VDXK3...sbtc-token) this receiver actually
;; redeems from Zest's vault. Fixing the pool id alone wouldn't work --
;; there is no known Velar route for the REAL sBTC this receiver holds.
;; The same wrong u70 assumption is also hardcoded in
;; contracts/velar-sbtc-arb-receiver.clar and contracts/hk-sbtc-real-receiver-v1.clar
;; -- worth flagging separately, not fixed here. Modes 1-3's swap-leg code
;; is left in place below (now with the min-stx-out/profit fixes applied)
;; for whenever a real route is found, but is unreachable: set-target
;; rejects arming them, and execute-stx-flash asserts mode == u4 as
;; defense in depth on top of that.
;;
;; Modes 4-5 replace what zest-liquidation-receiver.clar (retired -- it
;; targeted a long-dead contract, SP2VCQJGH...pool-borrow-v2-3, and had none
;; of this contract's F-10 hardening) was reaching for: same-asset
;; liquidations need no swap at all, so no slippage and no swap-failure
;; mode -- the simplest, lowest-risk liquidations to capture.
;;
;; Collateral is ALWAYS seized and redeemed as a vault share (v0-vault-sbtc
;; / v0-vault-stx), never the raw underlying (sbtc-token / wstx), even
;; though the registry's collateral:true/false flags make the raw
;; underlying look structurally valid too. Verified empirically, not just
;; from those flags: querying v0-market-vault.get-collateral() directly
;; across real registered accounts shows 100% of real sBTC/STX collateral
;; is held as vault shares. Passing the raw underlying as collateral-ft
;; would make liquidate()'s collateral-remove -> send-tokens call move
;; funds from an empty balance, silently seizing nothing. Every mode calls
;; liquidate() with the vault-share contract, captures the exact share
;; amount from its own return value, then calls that vault's redeem() --
;; wrapped in as-contract, same as every other self-call here -- to
;; convert the shares into real spendable underlying before swapping or
;; repaying.
;;
;; SECURITY (found in external review, verified independently before
;; fixing -- same discipline as the F-10 remediation earlier this session):
;;
;;   flashstack-stx-core.flash-loan has NO caller restriction at all --
;;   confirmed directly against its deployed source. Anyone can call it
;;   for any approved receiver, with any amount, as long as the receiver
;;   is approved. Combined with a keeper that sends set-target,
;;   set-price-feed, and flash-loan as three SEPARATE transactions, a
;;   third party could watch the first two land on-chain and then fire the
;;   flash-loan themselves, at a moment and with an amount of their own
;;   choosing. armed-amount below closes the "amount of their own
;;   choosing" half of that: execute-stx-flash/execute-sbtc-flash now
;;   assert the real flash-loan amount matches exactly what was armed via
;;   set-target, or revert.
;;
;;   The sBTC->STX swap's old minimum-output floor (modes 1-3) was
;;   computed as `sbtc-bal * slippage-bp / 10000` -- a number scaled to
;;   SATS, the INPUT token's units. Confirmed directly against Velar's
;;   deployed univ2-router that amt-out-min is checked against the
;;   OUTPUT token's units (microSTX here). 1 sat of sBTC is worth on the
;;   order of 2,000+ microSTX at typical BTC/STX prices, so that computation
;;   was never a real slippage floor -- effectively zero protection.
;;   min-stx-out below replaces it with an owner-set, correctly-united
;;   floor, required nonzero before any swap-mode execution.
;;
;;   The old final check (`stx-bal >= owed`) only verified the flash loan
;;   gets repaid -- it said nothing about whether THIS liquidation was
;;   itself profitable. Combined with the two gaps above, a third party
;;   could trigger the loan, move the Velar price around their own
;;   trigger, and walk away with the liquidation bonus (and any unswept
;;   profit already sitting in the contract) while the core still got
;;   repaid cleanly -- same outcome as F-10, a different route. The new
;;   final check captures this transaction's OWN starting balance first,
;;   then requires the ending balance to exceed it by at least fee +
;;   min-profit, independent of any stale leftover balance. Modes 4-5
;;   don't swap, so the price-manipulation angle doesn't apply to them,
;;   but the same profit check still does -- there's just much less to
;;   take there.
;;
;; Liquidation profit = Zest bonus (5-10%) - FlashStack fee (0.05%) - swap slippage (~0.3%, modes 1-3 only)
;; Net expected: 4-9% per liquidated position (modes 1-3); 5-10% minus the 0.05% flash fee for 4-5.
;;
;; Flow:
;;   1. Call set-target(borrower, debt-amount, mode, amount) -- amount is
;;      the EXACT flash-loan size this liquidation is sized for.
;;   2. Call set-price-feed(feed) with a freshly-fetched signed Pyth Lazer update
;;   3. Modes 1-3 only: call set-min-stx-out(min-out) with a fresh Velar quote
;;   4. Call flashstack-stx-core.flash-loan (modes 1-4) or
;;      flashstack-sbtc-core.flash-loan (mode 5) with this contract as receiver,
;;      using the EXACT amount armed in step 1
;;   5. FlashStack calls back execute-stx-flash / execute-sbtc-flash
;;   6. Receiver liquidates Zest (swapping first/after where the mode needs it), repays

(impl-trait 'SP3TGRVG7DKGFVRTTVGGS60S59R916FWB4DAB9STZ.stx-flash-receiver-trait.stx-flash-receiver-trait)
(impl-trait 'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.sbtc-flash-receiver-trait.sbtc-flash-receiver-trait)

;; =============================================
;; Constants -- all confirmed from on-chain data
;; =============================================

(define-constant BASIS-POINTS u10000)

(define-constant ERR-NOT-OWNER    (err u900))
(define-constant ERR-REPAY-FAILED (err u901))
(define-constant ERR-LIQUIDATION  (err u902))
(define-constant ERR-INSUFFICIENT (err u903))
(define-constant ERR-ZERO-AMOUNT  (err u904))
(define-constant ERR-BAD-MODE     (err u905))
(define-constant ERR-SWAP-FAILED  (err u906))
(define-constant ERR-NOT-CORE     (err u907))
(define-constant ERR-SWEEP-FAILED (err u908))
(define-constant ERR-NOT-PENDING  (err u909))
(define-constant ERR-NO-PRICE-FEED (err u910))
(define-constant ERR-REDEEM-FAILED (err u911))
(define-constant ERR-NO-PROFIT     (err u912))
(define-constant ERR-AMOUNT-MISMATCH (err u913))
(define-constant ERR-MIN-STX-OUT-UNSET (err u914))
(define-constant ERR-NO-SWAP-ROUTE (err u915))

;; FlashStack cores (hardcoded -- repayment never goes elsewhere)
(define-constant FLASH-CORE 'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-stx-core)
(define-constant FLASH-SBTC-CORE 'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-sbtc-core)

;; Zest market -- v0-8, confirmed live (v0-market-vault.get-impl() returns
;; this on all 7 vaults; v0-4-market is dead -- see header)
(define-constant ZEST-MARKET 'SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-8-market)
;; Zest V2 wSTX -- confirmed from repay transactions
(define-constant ZEST-WSTX 'SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.wstx)

;; Debt tokens (confirmed from borrow transactions on v0-4-market)
(define-constant USDCX 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx)
(define-constant USDH  'SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.usdh-token-v1)

;; Collateral tokens
(define-constant SBTC  'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)
(define-constant STSTX 'SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token)

;; Vault share tokens -- the ACTUAL collateral asset for real positions.
;; Verified empirically against v0-market-vault.get-collateral() across
;; real registered accounts, not just the registry's collateral:true/false
;; flags: raw wstx/sbtc-token (above) are structurally allowed as collateral
;; but NOT what's actually held -- v0-vault-stx / v0-vault-sbtc (the
;; ERC4626-style share tokens) are. liquidate()'s collateral-ft must match
;; whatever asset is actually registered at that position's collateral
;; slot, or collateral-remove's send-tokens call moves from an empty
;; balance. After liquidate() seizes shares, redeem() must be called to
;; convert them into real spendable underlying before swapping/repaying.
(define-constant V0-VAULT-STX  'SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-stx)
(define-constant V0-VAULT-SBTC 'SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc)

;; Velar (Uniswap v2 fork) -- for sBTC <-> STX swaps
(define-constant VELAR-ROUTER 'SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.univ2-router)
(define-constant VELAR-FEE-TO 'SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.univ2-share-fee-to)
(define-constant VELAR-WSTX   'SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.wstx)
(define-constant VELAR-POOL-SBTC-STX u70)

;; Bitflow stableswap -- for STX <-> stSTX if needed
(define-constant BITFLOW-POOL 'SPQC38PW542EQJ5M11CR25P7BS1CA6QT4TBXGB3M.stableswap-stx-ststx-v-1-2)
(define-constant BITFLOW-LP   'SPQC38PW542EQJ5M11CR25P7BS1CA6QT4TBXGB3M.stx-ststx-lp-token-v-1-2)

;; =============================================
;; State
;; =============================================

(define-data-var owner           principal tx-sender)
(define-data-var pending-owner   (optional principal) none)
(define-data-var target-borrower principal tx-sender)
(define-data-var target-debt     uint      u0)
;; Modes:
;;   u1 = USDCx debt + sBTC collateral
;;   u2 = USDH debt  + sBTC collateral
;;   u3 = wSTX debt  + sBTC collateral (needs wSTX on Velar -- see note)
;;   u4 = wSTX debt  + wSTX collateral (no swap -- execute-stx-flash)
;;   u5 = sBTC debt  + sBTC collateral (no swap -- execute-sbtc-flash)
(define-data-var target-mode     uint      u1)
;; Slippage tolerance on swaps (default 200 = 2%)
(define-data-var slippage-bp     uint      u200)
;; Real signed Pyth Lazer update, fetched off-chain immediately before each
;; flash-loan call (see header). Auto-reset to none after each use.
(define-data-var price-feed-buffer (optional (buff 8192)) none)

;; Exact flash-loan amount expected for the currently-armed target, set
;; alongside it via set-target. execute-stx-flash/execute-sbtc-flash
;; assert the REAL amount matches this exactly -- closes the gap where
;; flashstack-stx-core.flash-loan has no caller restriction at all (any
;; account can trigger it for any approved receiver, with any amount, the
;; moment set-target/set-price-feed are both visible on-chain) by making
;; an amount that doesn't match this specific liquidation simply revert.
;; Reset to u0 (along with target-mode) after use -- u0 can never match a
;; real flash-loan amount (flashstack-stx-core itself rejects amount u0),
;; so this also fails closed before set-target is ever called.
(define-data-var armed-amount uint u0)

;; Minimum sBTC->STX swap output, in microSTX (modes 1-3 only -- the ones that
;; swap). Owner-set fresh before each use, same pattern as price-feed-buffer.
;; Required nonzero for modes 1-3 (ERR-MIN-STX-OUT-UNSET otherwise).
;; Auto-reset to u0 after each use.
(define-data-var min-stx-out uint u0)

;; Minimum STX profit required above repayment (modes 1-4) / minimum sBTC
;; profit required above repayment (mode 5), measured against THIS
;; transaction's own starting balance (captured fresh at the top of each
;; callback) -- see header's SECURITY note. Standing policy floors, not
;; reset after use, same as bitflow-arb-receiver-v5's min-profit.
(define-data-var min-profit-stx uint u1)
(define-data-var min-profit-sbtc uint u1)

;; =============================================
;; STX Flash Loan Callback
;; =============================================

;; Called by flashstack-stx-core after sending 'amount' STX to this contract.
;; Pre-conditions: set-target AND set-price-feed must both have been called
;; (in that order doesn't matter, but both are required -- see headers).
;; Modes 1-3 also require set-min-stx-out.
(define-public (execute-stx-flash (amount uint) (core principal))
  (let (
    ;; Captured BEFORE anything else runs -- by the time this callback
    ;; fires, flashstack-stx-core has already sent `amount` to this
    ;; contract, so this already includes it (plus any stale unswept
    ;; leftover from an earlier liquidation). The final profit check
    ;; measures growth from this exact snapshot, not from zero.
    (balance-before (stx-get-balance (as-contract tx-sender)))
    (fee-bp  (unwrap! (contract-call? FLASH-CORE get-fee-basis-points) ERR-REPAY-FAILED))
    (raw-fee (/ (* amount fee-bp) BASIS-POINTS))
    (fee     (if (> raw-fee u0) raw-fee u1))
    (owed    (+ amount fee))
    (min-profit (var-get min-profit-stx))
    (borrower (var-get target-borrower))
    (debt-amt (var-get target-debt))
    (mode    (var-get target-mode))
    (slip    (var-get slippage-bp))
  )
    ;; Only flashstack-stx-core may call this. Checked before anything else
    ;; touches state or var-get's the price feed -- an unauthorized caller
    ;; should see ERR-NOT-CORE, not a confusing ERR-NO-PRICE-FEED that
    ;; implies the fix is "set a price feed" when it's actually "you can
    ;; never call this at all."
    (asserts! (is-eq contract-caller FLASH-CORE) ERR-NOT-CORE)
    ;; `core` accepted for trait compliance; assert matches FLASH-CORE as
    ;; defense-in-depth, same as alex-arb-receiver-v5 / bitflow-arb-receiver-v5
    (asserts! (is-eq core FLASH-CORE) ERR-NOT-CORE)
    ;; mode 5 goes through execute-sbtc-flash, not here
    (asserts! (and (>= mode u1) (<= mode u4)) ERR-BAD-MODE)
    ;; Modes 1-3 are blocked at set-target already (see its own note) --
    ;; this is defense in depth only, since target-mode should never
    ;; actually be 1/2/3 by the time this runs. Not swap-route-dependent:
    ;; mode 4 is the only mode this callback ever actually executes.
    (asserts! (is-eq mode u4) ERR-NO-SWAP-ROUTE)
    ;; flashstack-stx-core.flash-loan itself has no caller restriction --
    ;; confirmed directly against its deployed source, anyone can trigger
    ;; it for any approved receiver with any amount. This is the real
    ;; gate: the amount must match exactly what this liquidation was armed
    ;; for, or revert -- see header's SECURITY note.
    (asserts! (is-eq amount (var-get armed-amount)) ERR-AMOUNT-MISMATCH)

  (let ((feeds (some (list (unwrap! (var-get price-feed-buffer) ERR-NO-PRICE-FEED)))))

    ;; Auto-reset: forces explicit re-fetching/re-arming before the next
    ;; loan rather than silently reusing stale state. A later failure in
    ;; this same tx reverts these too, atomically -- correct, since only a
    ;; successful execution should consume them.
    (var-set price-feed-buffer none)
    (var-set armed-amount u0)
    (var-set target-mode u0)

    (if (is-eq mode u1)

      ;; Mode 1: USDCx debt + sBTC collateral
      ;; NOTE: Velar has NO STX/USDCx pool (confirmed: pools 1-14 scanned, none match).
      ;; This mode needs a different swap route before it can be used.
      ;; Options to research: ALEX AMM STX/USDCx pair, or Bitflow if available.
      ;; Until a valid swap route is identified, mode 1 will always revert here.
      ;; The primary liquidation target ($250K USDH position) uses mode 2 -- not affected.
      (let (
        (min-usdcx (/ (* debt-amt (- BASIS-POINTS slip)) BASIS-POINTS))
      )
        (unwrap! (as-contract (contract-call? VELAR-ROUTER swap-exact-tokens-for-tokens
          u2 VELAR-WSTX USDCX VELAR-WSTX USDCX VELAR-FEE-TO amount min-usdcx))
          ERR-SWAP-FAILED)

        (let ((usdcx-bal (unwrap! (as-contract (contract-call? USDCX get-balance tx-sender)) ERR-SWAP-FAILED)))
          (asserts! (> usdcx-bal u0) ERR-SWAP-FAILED)

          ;; Step 2: Liquidate -- pays usdcx-bal of USDCx debt, receives
          ;; v0-vault-sbtc SHARES as collateral (real positions hold sBTC
          ;; collateral as vault shares, not raw sbtc-token -- see the
          ;; vault-share constants note above)
          ;; Reverts with ERR-AUTHORIZATION until Zest adds authorized-liquidator whitelist
          (let ((liq-result (unwrap! (as-contract (contract-call? ZEST-MARKET liquidate
              borrower V0-VAULT-SBTC USDCX usdcx-bal u0 (some (as-contract tx-sender)) feeds))
              ERR-LIQUIDATION)))

            ;; Step 2b: Redeem the seized shares for real sBTC before swapping
            (unwrap! (as-contract (contract-call? V0-VAULT-SBTC redeem
              (get collateral liq-result) u0 (as-contract tx-sender)))
              ERR-REDEEM-FAILED)

            ;; Step 3: Swap all received sBTC -> STX on Velar. min-stx-out
            ;; is owner-set in microSTX (the output token's real units) --
            ;; required nonzero and reset after use, same reasoning as
            ;; price-feed-buffer. See header's SECURITY note for why the
            ;; old sbtc-bal-derived floor was never real protection.
            (let ((sbtc-bal (unwrap! (as-contract (contract-call? SBTC get-balance tx-sender)) ERR-SWAP-FAILED)))
              (asserts! (> sbtc-bal u0) ERR-SWAP-FAILED)
              (let ((min-stx (var-get min-stx-out)))
                (asserts! (> min-stx u0) ERR-MIN-STX-OUT-UNSET)
                (var-set min-stx-out u0)
                (unwrap! (as-contract (contract-call? VELAR-ROUTER swap-exact-tokens-for-tokens
                  VELAR-POOL-SBTC-STX VELAR-WSTX SBTC SBTC VELAR-WSTX VELAR-FEE-TO sbtc-bal min-stx))
                  ERR-SWAP-FAILED)

                ;; Step 4: Repay to hardcoded FLASH-CORE. Profit check
                ;; measures growth from balance-before, not a bare
                ;; >= owed -- see header's SECURITY note.
                (let ((stx-bal (stx-get-balance (as-contract tx-sender))))
                  (asserts! (>= stx-bal (+ balance-before fee min-profit)) ERR-NO-PROFIT)
                  (unwrap! (as-contract (stx-transfer? owed tx-sender FLASH-CORE)) ERR-REPAY-FAILED)
                  (ok true)
                )
              )
            )
          )
        )
      )

      (if (is-eq mode u2)

        ;; Mode 2: USDH debt + sBTC collateral
        ;; STX received -> swap STX->USDH via Arkadiko -> liquidate -> receive sBTC -> swap -> repay
        (let ((min-usdh (/ (* debt-amt (- BASIS-POINTS slip)) BASIS-POINTS)))
          ;; swap-x-for-y's min-dy is a bare uint, not (optional uint) --
          ;; confirmed directly against the live deployed interface. The
          ;; (some min-usdh) this carried before was a real type-mismatch
          ;; bug on this dead code path (mode 1 was the only one ever
          ;; exercised, per the file's own earlier notes) -- would have
          ;; failed to compile/type-check the moment this path was
          ;; actually used.
          (unwrap! (as-contract (contract-call?
            'SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR.arkadiko-swap-v2-1
            swap-x-for-y
            'SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR.wrapped-stx-token
            USDH amount min-usdh))
            ERR-SWAP-FAILED)

          (let ((usdh-bal (unwrap! (as-contract (contract-call? USDH get-balance tx-sender)) ERR-SWAP-FAILED)))
            (asserts! (> usdh-bal u0) ERR-SWAP-FAILED)

            ;; Liquidate -- receives v0-vault-sbtc SHARES as collateral,
            ;; same reasoning as mode 1 (see vault-share constants note)
            (let ((liq-result (unwrap! (as-contract (contract-call? ZEST-MARKET liquidate
                borrower V0-VAULT-SBTC USDH usdh-bal u0 (some (as-contract tx-sender)) feeds))
                ERR-LIQUIDATION)))

              ;; Redeem the seized shares for real sBTC before swapping
              (unwrap! (as-contract (contract-call? V0-VAULT-SBTC redeem
                (get collateral liq-result) u0 (as-contract tx-sender)))
                ERR-REDEEM-FAILED)

              ;; Swap sBTC -> STX -- min-stx-out, see mode 1's note above
              (let ((sbtc-bal (unwrap! (as-contract (contract-call? SBTC get-balance tx-sender)) ERR-SWAP-FAILED)))
                (asserts! (> sbtc-bal u0) ERR-SWAP-FAILED)
                (let ((min-stx (var-get min-stx-out)))
                  (asserts! (> min-stx u0) ERR-MIN-STX-OUT-UNSET)
                  (var-set min-stx-out u0)
                  (unwrap! (as-contract (contract-call? VELAR-ROUTER swap-exact-tokens-for-tokens
                    VELAR-POOL-SBTC-STX VELAR-WSTX SBTC SBTC VELAR-WSTX VELAR-FEE-TO sbtc-bal min-stx))
                    ERR-SWAP-FAILED)

                  (let ((stx-bal (stx-get-balance (as-contract tx-sender))))
                    (asserts! (>= stx-bal (+ balance-before fee min-profit)) ERR-NO-PROFIT)
                    (unwrap! (as-contract (stx-transfer? owed tx-sender FLASH-CORE)) ERR-REPAY-FAILED)
                    (ok true)
                  )
                )
              )
            )
          )
        )

        (if (is-eq mode u3)

        ;; Mode 3: wSTX debt + sBTC collateral
        ;; NOTE: wSTX has no public mint function. To pay wSTX debt, this contract
        ;; must already hold wSTX tokens (pre-funded via a DEX swap off-chain).
        ;; The flash loan STX is used to fund the repayment after liquidation.
        ;; Flow: receive STX flash -> liquidate using pre-held wSTX ->
        ;;        receive sBTC -> swap sBTC->STX -> repay loan + top up wSTX spent
        (let (
          (wstx-bal (unwrap! (as-contract (contract-call? ZEST-WSTX get-balance tx-sender)) ERR-SWAP-FAILED))
        )
          (asserts! (>= wstx-bal debt-amt) ERR-INSUFFICIENT)

          ;; Liquidate using pre-held wSTX -- receives v0-vault-sbtc SHARES
          ;; as collateral, same reasoning as modes 1-2
          (let ((liq-result (unwrap! (as-contract (contract-call? ZEST-MARKET liquidate
              borrower V0-VAULT-SBTC ZEST-WSTX debt-amt u0 (some (as-contract tx-sender)) feeds))
              ERR-LIQUIDATION)))

            ;; Redeem the seized shares for real sBTC before swapping
            (unwrap! (as-contract (contract-call? V0-VAULT-SBTC redeem
              (get collateral liq-result) u0 (as-contract tx-sender)))
              ERR-REDEEM-FAILED)

            ;; Swap received sBTC -> STX -- min-stx-out, see mode 1's note above
            (let ((sbtc-bal (unwrap! (as-contract (contract-call? SBTC get-balance tx-sender)) ERR-SWAP-FAILED)))
              (asserts! (> sbtc-bal u0) ERR-SWAP-FAILED)
              (let ((min-stx (var-get min-stx-out)))
                (asserts! (> min-stx u0) ERR-MIN-STX-OUT-UNSET)
                (var-set min-stx-out u0)
                (unwrap! (as-contract (contract-call? VELAR-ROUTER swap-exact-tokens-for-tokens
                  VELAR-POOL-SBTC-STX VELAR-WSTX SBTC SBTC VELAR-WSTX VELAR-FEE-TO sbtc-bal min-stx))
                  ERR-SWAP-FAILED)

                (let ((stx-bal (stx-get-balance (as-contract tx-sender))))
                  (asserts! (>= stx-bal (+ balance-before fee min-profit)) ERR-NO-PROFIT)
                  (unwrap! (as-contract (stx-transfer? owed tx-sender FLASH-CORE)) ERR-REPAY-FAILED)
                  (ok true)
                )
              )
            )
          )
        )

        ;; Mode 4: wSTX debt + wSTX-vault-share collateral -- no swap. The
        ;; flash-borrowed STX itself is the payment (Zest's wSTX is a thin
        ;; passthrough to native STX -- confirmed directly, its transfer()
        ;; just calls stx-transfer?). Collateral is seized as v0-vault-stx
        ;; SHARES (see vault-share constants note above), redeemed here for
        ;; real native STX (= STX), so repayment needs nothing else. No
        ;; swap means no price-manipulation surface, but the same profit
        ;; check below still applies -- see header's SECURITY note.
        (begin
          (let ((liq-result (unwrap! (as-contract (contract-call? ZEST-MARKET liquidate
              borrower V0-VAULT-STX ZEST-WSTX debt-amt u0 (some (as-contract tx-sender)) feeds))
              ERR-LIQUIDATION)))

            ;; Redeem the seized shares for real native STX
            (unwrap! (as-contract (contract-call? V0-VAULT-STX redeem
              (get collateral liq-result) u0 (as-contract tx-sender)))
              ERR-REDEEM-FAILED)

            (let ((stx-bal (stx-get-balance (as-contract tx-sender))))
              (asserts! (>= stx-bal (+ balance-before fee min-profit)) ERR-NO-PROFIT)
              (unwrap! (as-contract (stx-transfer? owed tx-sender FLASH-CORE)) ERR-REPAY-FAILED)
              (ok true)
            )
          )
        )
      ) ;; closes (if (is-eq mode u3) ... mode-4-block)
      )
    )
  ) ;; closes the inner (let ((feeds ...))
  )
)

;; =============================================
;; sBTC Flash Loan Callback (mode 5 only)
;; =============================================

;; Called by flashstack-sbtc-core after sending 'amount' sBTC to this
;; contract. Same pre-conditions as execute-stx-flash: set-target AND
;; set-price-feed must both have been called first.
(define-public (execute-sbtc-flash (amount uint) (core principal))
  (let (
    ;; See execute-stx-flash's balance-before for why this is captured
    ;; first, in sBTC's own units here.
    (balance-before (unwrap! (as-contract (contract-call? SBTC get-balance tx-sender)) ERR-REPAY-FAILED))
    (fee-bp  (unwrap! (contract-call? FLASH-SBTC-CORE get-fee-basis-points) ERR-REPAY-FAILED))
    (raw-fee (/ (* amount fee-bp) BASIS-POINTS))
    (fee     (if (> raw-fee u0) raw-fee u1))
    (owed    (+ amount fee))
    (min-profit (var-get min-profit-sbtc))
    (borrower (var-get target-borrower))
    (debt-amt (var-get target-debt))
    (mode    (var-get target-mode))
  )
    (asserts! (is-eq contract-caller FLASH-SBTC-CORE) ERR-NOT-CORE)
    (asserts! (is-eq core FLASH-SBTC-CORE) ERR-NOT-CORE)
    (asserts! (is-eq mode u5) ERR-BAD-MODE)
    ;; See execute-stx-flash's armed-amount note -- flashstack-sbtc-core.flash-loan
    ;; has the same no-caller-restriction shape.
    (asserts! (is-eq amount (var-get armed-amount)) ERR-AMOUNT-MISMATCH)

    (let ((feeds (some (list (unwrap! (var-get price-feed-buffer) ERR-NO-PRICE-FEED)))))
      (var-set price-feed-buffer none)
      (var-set armed-amount u0)
      (var-set target-mode u0)

      ;; Mode 5: sBTC debt + v0-vault-sbtc-share collateral -- no swap, same
      ;; reasoning as mode 4. Collateral is seized as SHARES (see
      ;; vault-share constants note above), redeemed here for real sBTC;
      ;; the flash-borrowed sBTC itself is the payment.
      (let ((liq-result (unwrap! (as-contract (contract-call? ZEST-MARKET liquidate
          borrower V0-VAULT-SBTC SBTC debt-amt u0 (some (as-contract tx-sender)) feeds))
          ERR-LIQUIDATION)))

        ;; Redeem the seized shares for real sBTC
        (unwrap! (as-contract (contract-call? V0-VAULT-SBTC redeem
          (get collateral liq-result) u0 (as-contract tx-sender)))
          ERR-REDEEM-FAILED)

        (let ((sbtc-bal (unwrap! (as-contract (contract-call? SBTC get-balance tx-sender)) ERR-REPAY-FAILED)))
          (asserts! (>= sbtc-bal (+ balance-before fee min-profit)) ERR-NO-PROFIT)
          (unwrap!
            (as-contract (contract-call? SBTC transfer owed tx-sender FLASH-SBTC-CORE none))
            ERR-REPAY-FAILED)
          (ok true)
        )
      )
    )
  )
)

;; =============================================
;; Owner Functions
;; =============================================

;; amount: the EXACT flash-loan size this liquidation is sized for.
;; execute-stx-flash/execute-sbtc-flash revert with ERR-AMOUNT-MISMATCH if
;; the real flash-loan amount doesn't match -- see header's SECURITY note.
;;
;; Modes 1-3 cannot be armed right now -- see header's SWAP ROUTE note.
;; VELAR-POOL-SBTC-STX (u70) is NOT the sBTC/STX pool (confirmed live:
;; it's an unrelated wstx/meme-coin pool), and the only wstx-paired pool
;; that even has "sbtc" in its token name (id 60) trades a different sBTC
;; contract than the one this receiver actually redeems from Zest's
;; vault. Rejected here, at config time, rather than letting the owner
;; arm a mode that execute-stx-flash would just revert on anyway.
(define-public (set-target (borrower principal) (debt uint) (mode uint) (amount uint))
  (begin
    (asserts! (is-eq tx-sender (var-get owner)) ERR-NOT-OWNER)
    (asserts! (> debt u0) ERR-ZERO-AMOUNT)
    (asserts! (> amount u0) ERR-ZERO-AMOUNT)
    (asserts! (and (>= mode u1) (<= mode u5)) ERR-BAD-MODE)
    (asserts! (not (or (is-eq mode u1) (is-eq mode u2) (is-eq mode u3))) ERR-NO-SWAP-ROUTE)
    (var-set target-borrower borrower)
    (var-set target-debt debt)
    (var-set target-mode mode)
    (var-set armed-amount amount)
    (ok true)
  )
)

(define-public (set-slippage (bp uint))
  (begin
    (asserts! (is-eq tx-sender (var-get owner)) ERR-NOT-OWNER)
    (asserts! (and (>= bp u50) (<= bp u500)) ERR-BAD-MODE)
    (ok (var-set slippage-bp bp))
  )
)

;; Set the minimum acceptable sBTC->STX swap output, in microSTX -- compute
;; off-chain via a fresh Velar quote (VELAR-ROUTER / univ2-library.get-amount-out)
;; immediately before calling flash-loan. Required for modes 1-3 only:
;; execute-stx-flash reverts with ERR-MIN-STX-OUT-UNSET for those modes if
;; this is still u0. Auto-reset to u0 after each successful use.
(define-public (set-min-stx-out (min-out uint))
  (begin
    (asserts! (is-eq tx-sender (var-get owner)) ERR-NOT-OWNER)
    (ok (var-set min-stx-out min-out))
  )
)

;; Minimum STX profit required above repayment for modes 1-4, measured
;; against this transaction's own starting balance (see header's SECURITY
;; note). Standing floor, not reset after use -- raise it if the default
;; (u1, i.e. "any nonzero profit") is too permissive for a given
;; liquidation's size.
(define-public (set-min-profit-stx (min-stx uint))
  (begin
    (asserts! (is-eq tx-sender (var-get owner)) ERR-NOT-OWNER)
    (ok (var-set min-profit-stx min-stx))
  )
)

;; Same as set-min-profit-stx, for mode 5's sBTC-denominated profit floor.
(define-public (set-min-profit-sbtc (min-sats uint))
  (begin
    (asserts! (is-eq tx-sender (var-get owner)) ERR-NOT-OWNER)
    (ok (var-set min-profit-sbtc min-sats))
  )
)

;; Set the signed Pyth Lazer update to submit on the next flash loan. Fetch
;; off-chain (@pythnetwork/pyth-lazer-sdk, "evm" format, channel
;; fixed_rate@200ms or @1000ms) immediately before calling flash-loan --
;; stale updates fail Zest's own staleness check regardless. Required:
;; execute-stx-flash reverts with ERR-NO-PRICE-FEED if this is none.
;; Auto-reset to none after each successful execution.
(define-public (set-price-feed (feed (buff 8192)))
  (begin
    (asserts! (is-eq tx-sender (var-get owner)) ERR-NOT-OWNER)
    (ok (var-set price-feed-buffer (some feed)))
  )
)

;; Two-step ownership transfer -- prevents locking out via typo
(define-public (propose-owner (new-owner principal))
  (begin
    (asserts! (is-eq tx-sender (var-get owner)) ERR-NOT-OWNER)
    (ok (var-set pending-owner (some new-owner)))
  )
)

(define-public (accept-ownership)
  (let ((pending (unwrap! (var-get pending-owner) ERR-NOT-PENDING)))
    (asserts! (is-eq tx-sender pending) ERR-NOT-PENDING)
    (var-set owner pending)
    (var-set pending-owner none)
    (ok true)
  )
)

;; Emergency sweep -- recover tokens if a tx partially fails
(define-public (sweep-stx (amount uint))
  (begin
    (asserts! (is-eq tx-sender (var-get owner)) ERR-NOT-OWNER)
    (unwrap! (as-contract (stx-transfer? amount tx-sender (var-get owner))) ERR-SWEEP-FAILED)
    (ok true)
  )
)

(define-public (sweep-sbtc (amount uint))
  (begin
    (asserts! (is-eq tx-sender (var-get owner)) ERR-NOT-OWNER)
    (unwrap! (as-contract (contract-call? SBTC transfer amount tx-sender (var-get owner) none)) ERR-SWEEP-FAILED)
    (ok true)
  )
)

;; =============================================
;; Read-only
;; =============================================

;; Pre-flight check: estimate net profit before executing.
;; bonus-bp: Zest liquidation bonus in basis points (typically 500 = 5%)
(define-read-only (simulate (debt-amount uint) (bonus-bp uint) (flash-fee-bp uint))
  (let (
    (raw-fee  (/ (* debt-amount flash-fee-bp) BASIS-POINTS))
    (fee      (if (> raw-fee u0) raw-fee u1))
    (bonus    (/ (* debt-amount bonus-bp) BASIS-POINTS))
    (profit   (if (> bonus fee) (- bonus fee) u0))
  )
    {
      debt-amount:   debt-amount,
      bonus-bp:      bonus-bp,
      bonus:         bonus,
      flash-fee:     fee,
      net-profit:    profit,
      profitable:    (> bonus fee),
      owed-to-core:  (+ debt-amount fee),
    }
  )
)

(define-read-only (get-target)
  (ok { borrower: (var-get target-borrower), debt: (var-get target-debt), mode: (var-get target-mode), amount: (var-get armed-amount) })
)

;; Does NOT return the feed bytes themselves (no reason to -- it's public
;; data anyway once submitted) -- just whether one is ready to use, so an
;; off-chain caller can check before firing flash-loan without guessing.
(define-read-only (has-price-feed)
  (is-some (var-get price-feed-buffer))
)

(define-read-only (get-owner)
  (ok { owner: (var-get owner), pending-owner: (var-get pending-owner) })
)

(define-read-only (get-swap-settings)
  (ok { min-stx-out: (var-get min-stx-out), min-profit-stx: (var-get min-profit-stx), min-profit-sbtc: (var-get min-profit-sbtc) })
)
