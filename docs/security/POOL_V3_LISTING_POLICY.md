# flashstack-pool-v3 asset listing policy

`add-asset` is load-bearing for solvency (`flashstack-pool-v3.clar` header): the pool trusts every listed
token's `transfer`, `get-balance` and `get-decimals`. The contract can't tell a well-behaved SIP-010 from
one that isn't, so this list is enforced by the admin before calling `add-asset`, not by code.

Launch assets are sBTC (8 decimals) and USDCx (6). Both pass every rule below.

## Never list

| Token class | Why | Evidence |
|---|---|---|
| **Fee-on-transfer, recipient pays** (recipient gets less than `amount`) | `deposit` mints shares on the requested `amount` and caches `reserve = balance + amount` (`:274`, `:306`) before the transfer. Each depositor is credited for tax the pool never received, paid by earlier LPs. With a 10% tax, two LPs paying 1,000,000 each exit with 852,632 and 947,368. Flash loans revert, because the repay check reads the live balance. | `tests/pool-v3-fee-on-transfer.test.ts`, "recipient-pays" |
| **Fee-on-transfer, sender pays** (sender loses more than `amount`) | Every outbound transfer burns extra from the pool, which exceeds the `as-contract?` `with-ft` allowance of exactly `amount-out` / `amount`. `withdraw` and `flash-loan` abort with `ERR-TRANSFER-FAILED`, so **LP funds are locked**. Only withdrawals that pay zero tax get out, and deposits are still accepted. | `tests/pool-v3-fee-on-transfer.test.ts`, "sender-pays" |
| **Rebasing** (balances change without a transfer) | Deposits and withdrawals price against the live balance, so a positive rebase stays with the LPs who held through it; the next depositor doesn't capture it. But `get-share-price` and `get-lp-value` read the cached `reserve`, so collateral readers see a stale number until the next state change (+10% leaves `get-lp-value` at 1,000,000 against a real 1,100,000). **A negative rebase locks LP funds if the token's units are a `define-fungible-token`:** each outbound transfer moves more units than `amount`, which exceeds the `as-contract?` `with-ft` allowance, so `withdraw` and `flash-loan` abort with `ERR-TRANSFER-FAILED` (same shape as sender-pays tax). A map-backed token moves no ft, so LPs exit pro rata at the loss. | `tests/pool-v3-rebasing-and-balance.test.ts`, "rebasing token". CR-3 in `POOL_V3_AUDIT_COUNTER_REVIEW.md` |
| **Mutable decimals** (upgradeable or proxy tokens) | `share-scale` is `10^decimals`, read live at `add-asset`. A relist re-reads it (CR-5), and existing shares would re-price. | No test. CR-5 in `POOL_V3_AUDIT_COUNTER_REVIEW.md` |
| **More than 8 decimals** | Share math overflows uint128 at small balances, and LPs can't withdraw (CR-1). Enforced in code once PR #121 merges (`MAX-DECIMALS u8`). | `tests/pool-v3-counter-review.test.ts`, CR-1 block |
| **Non-standard `get-balance`** (doesn't report what `transfer` can move) | `deposit`, `withdraw` and the flash-loan repay check (`reserve-after >= reserve-before + fee`) all trust `get-balance`. **If the reported balance can be raised during the loan transaction, the repay check is satisfied short:** the receiver keeps the whole loan, the pool's real balance goes to 0, LPs are locked out (`ERR-TRANSFER-FAILED`), and new deposits are still accepted. A fixed over-report cancels out of the check (both reads include it), and one present before any deposit is absorbed by the virtual shares. The risk is the balance being *movable*, not merely wrong. | `tests/pool-v3-rebasing-and-balance.test.ts`, "non-standard get-balance". The repay invariant is in `FLASH_LOAN_INVARIANT.md` |

## Before every `add-asset`

1. Read the token's deployed source. Confirm `transfer` moves exactly `amount` from `sender` to `recipient`,
   with no hooks, tax or burn, and that `get-balance` returns `ft-get-balance` (or equivalent).
2. Confirm `get-decimals` is a constant of 8 or less.
3. Confirm the token has no upgrade path or admin that can change the two points above.
4. Record the principal, source hash and decimals in `CONTRACT_INVENTORY.md` in the same PR as the
   listing transaction.
