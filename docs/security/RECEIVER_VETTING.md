# Receiver Vetting Checklist

**Owner:** Security & Contract Lead · **Approver:** Matt · **Evidence date:** 2026-10-12 · **Repo:** `50feb2d`

Every `add-approved-receiver` call, on any core or pool, needs this checklist completed
and signed off **before** the call is made. That applies to cores and pools already live
and to the v3 successors before their first approval. It covers *how* a candidate is
vetted; [ADMIN_CUSTODY_MODEL.md](ADMIN_CUSTODY_MODEL.md) covers *who* may make the call.

**Why this exists.** The solvency invariant ([FLASH_LOAN_INVARIANT.md](FLASH_LOAN_INVARIANT.md))
protects the pool's balance. It does nothing for a receiver's own balance, and the
whitelist only controls which receivers the pool will call. Three findings show the gap:

- **F-9:** a receiver can "repay" by calling the pool's own `deposit`. `flash-loan` still
  returns `(ok true)`, so a successful loan proves nothing about honest repayment.
- **F-10:** 13 receivers were approved across both cores with no `contract-caller` check
  and a caller-supplied repay target. Anyone could call them directly and take their
  balance. **Removing a receiver from the whitelist does not stop that**, because a
  direct call never touches the core.
- **#98 review:** a correctly gated receiver can still lose money. `flash-loan` on the
  live cores lets anyone start a loan for any approved receiver. So owner settings made
  in earlier transactions (target, price feed) can be used by a stranger, at a moment
  they choose, against a slippage floor that was in the wrong units.

A receiver is approved only if every item below passes. "N/A" needs a one-line reason.

---

## A. Identity and source

1. **Exact source.** Record the contract principal, the repo file, and the commit SHA
   being reviewed. Read the whole contract, not the diff.
2. **Deployed matches reviewed.** Fetch the deployed source and compare its hash with
   the reviewed file:
   `curl -s https://api.hiro.so/v2/contracts/source/<addr>/<name> | jq -j .source | shasum -a 256`.
   Any difference means it is not approved. Add the pin to `tests/deployed-source-pins.test.ts`.
3. **Real dependencies.** Every hardcoded principal (core, pool, DEX, token, oracle) is
   the live mainnet contract, not a mock or local `.name` reference, and it does what the
   code assumes. Check pool and route IDs against chain state too: #98's `u70` was meant
   to be the Velar sBTC/STX pool and turned out to be an unrelated pool.

## B. Who can call it (the F-10 checks)

4. **Callback gate.** `execute-stx-flash` / `execute-sbtc-flash` asserts
   `(is-eq contract-caller <hardcoded core or pool>)` **before** reading or changing any
   state. A `tx-sender` check alone fails this item.
5. **Hardcoded repay target.** Repayment goes to the constant core or pool principal,
   never to the `core` argument. If `core` is accepted for trait compliance, assert it
   equals the constant.
6. **Every other public function** is either owner-gated or provably harmless when a
   stranger calls it. List them all.

## C. Third-party-triggered loans (the #98 checks)

Anyone can call `flash-loan` naming this receiver, with any amount, at any time. With
that in mind:

7. **Armed state is bound and single-use.** Any setting the owner makes before a loan
   (target, mode, price feed, minimum output) is tied to the expected loan `amount`
   (`asserts! (is-eq amount armed-amount)`) and cleared in the callback. Without a
   prepared setting, a stranger's loan reverts.
8. **Units.** Every minimum output is in the **output** token's units and is set
   explicitly by the owner, not derived from the input amount. Check against the DEX's
   deployed signature (Velar `amt-out-min`, Bitflow `min-dy`, ALEX `min-dy`).
9. **Profit is measured, not assumed.** The final check compares against the balance
   read at the start of the callback (`balance-before`, which already includes the
   borrowed amount): `ending >= balance-before + fee + min-profit`. A check of
   `balance >= owed` across the whole balance fails this item, because it lets a
   stranger's loan spend profit that hasn't been swept yet.
10. **Leftover funds.** Profit or tokens that stay in the receiver between loans are
    either swept by the owner promptly or protected by items 7–9. Record the expected
    resting balance.

## D. Repayment and the pool (the F-9 checks)

11. **Plain repayment.** Repays `amount + fee` by plain transfer (`stx-transfer?` /
    SIP-010 `transfer`) to the hardcoded target. It never repays through `deposit`, a
    swap into the pool, or any call back into the lender.
12. **Fee from the lender.** The fee comes from the lender's own `get-fee-basis-points`
    with the same `max(1, floor(...))` rounding the core uses, not a hardcoded fee.
13. **No reentry.** The callback does not call the lender's `deposit` / `withdraw` /
    `flash-loan`. On the v3 successor pools, show that an attempt fails with
    `ERR-REENTRANT` (`u411` stx-pool-v3, `u712` sbtc-pool-v3).
14. **Pause.** Describe how the receiver behaves when the lender is paused. It must not
    depend on calling a pause-gated or lock-gated function mid-callback.

## E. Assets, ownership, immutability

15. **Token principals.** Uses the real SIP-010 token (`SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token`)
    and the correct STX vs SIP-010 path for each leg.
16. **No mutable behaviour after approval.** No setter can change the core, pool, DEX,
    or repay principals. Owner settings that only adjust per-loan parameters (items 7–9)
    are fine.
17. **Rescue / sweep** functions are owner-only, send only to the owner, and reject a
    zero amount. Record who the owner is. The bitflow v3/v4 rescue during F-10 needed
    the old deployer key, which nobody expected.
18. **Owner key.** Two-step ownership transfer. An automated keeper must not hold the
    deployer or core-admin key. Hand ownership to a dedicated wallet that holds only
    gas money.

## F. Tests

19. Simnet tests against the **canonical lender source**, each one failing if its guard
    is removed:
    - an honest loan succeeds and the lender's balance grows by at least the fee;
    - a direct call to the callback is rejected (item 4);
    - a loan the owner didn't prepare, or one with the wrong amount, is rejected (item 7);
    - an under-repaying loan is rejected;
    - a reentrant `deposit` / `withdraw` in the callback is rejected (item 13);
    - an unprofitable run is rejected (item 9).

## G. Sign-off and the approval call

20. **Order:** the Security & Contract Lead reviews and records the evidence below, Matt
    approves, then the admin wallet (`SPR9PQAN…`) makes the call. Nothing is approved
    without a written record.
21. **After the call,** record the txid and read `is-approved-receiver` back from chain.
    Do not rely on the broadcast result: `map-set` / `map-delete` succeed for any
    principal, including a mistyped one with no contract deployed at it.

---

## Evidence record (one per receiver, per core or pool)

```
Receiver principal:
Lender (core/pool) principal:
Repo file + commit SHA reviewed:
Deployed source sha256 / reviewed file sha256 / match:
Deployed-source pin added (test name):
A1–A3:
B4–B6:
C7–C10:      expected resting balance:
D11–D14:
E15–E18:     owner principal:
F19:         test command + pass count:
Reviewer + date:
Approver + date:
add-approved-receiver txid:
is-approved-receiver read-back (block height):
```

## Removing a receiver

Removing a receiver is not a fix for an exploitable one (see F-10). In this order:

1. Rescue the receiver's balance (owner `rescue`/`sweep`, or the exploit path itself if
   that is the only way out).
2. Call `remove-approved-receiver` for the exact principal, on every core and pool where
   it is approved.
3. Read back both the balance and `is-approved-receiver` for that exact principal.
