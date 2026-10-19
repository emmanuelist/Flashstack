import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Invariant from docs/security/CANONICAL_SBTC_REVIEW.md (ajv.5.2): every
 * contract that lends sBTC must call the receiver OUTSIDE `as-contract`.
 *
 * Canonical sBTC's get-balance returns available + locked, and the only public
 * way to lock sBTC (sbtc-withdrawal initiate-withdrawal-request) locks
 * tx-sender's own balance. The lenders' balance-delta solvency checks are sound
 * only because, inside the callback, tx-sender is the borrower and never the
 * lender. Wrapping the receiver call in `as-contract` would make tx-sender the
 * lender, so a receiver could lock the lender's sBTC and still pass the check.
 *
 * The local mock (contracts/sbtc-token.clar) has no locked balance, so no
 * simnet test can catch this. This is a source check instead.
 */

const LENDERS = [
  "contracts/flashstack-sbtc-core.clar",
  "contracts/flashstack-sbtc-core-v2.clar",
  "contracts/flashstack-sbtc-pool-v2.clar",
  "contracts/flashstack-sbtc-pool-v3.clar",
  "contracts/flashstack-pool-v3.clar",
];

const RECEIVER_CALL = "contract-call? receiver";

/** Heads of the forms enclosing each receiver call, skipping comments and strings. */
function enclosingHeads(src: string): string[][] {
  const result: string[][] = [];
  const stack: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ";") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === "(") {
      const head = /^\(\s*([^\s()]+)/.exec(src.slice(i))?.[1] ?? "";
      if (src.startsWith(RECEIVER_CALL, i + 1)) result.push([...stack]);
      stack.push(head);
    } else if (c === ")") {
      stack.pop();
    }
    i++;
  }
  return result;
}

describe("sBTC lenders call the receiver outside as-contract (canonical sBTC locked balance)", () => {
  for (const path of LENDERS) {
    it(path, () => {
      const calls = enclosingHeads(readFileSync(path, "utf8"));
      expect(calls.length, "expected exactly one receiver call").toBe(1);
      expect(calls[0].filter((h) => h.startsWith("as-contract"))).toEqual([]);
    });
  }
});
