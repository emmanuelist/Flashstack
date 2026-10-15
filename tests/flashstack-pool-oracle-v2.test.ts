import { describe, expect, it, beforeEach } from "vitest";
import { Cl } from "@stacks/transactions";

/**
 * flashstack-pool-oracle-v2 — the external STX collateral oracle updated to the
 * pool v2 virtual-offset math. The point of v2 is CONSISTENCY: the oracle's
 * reported lp-value / share-price must equal the pool's real share<->asset
 * conversions (they drifted in v1). This suite proves that equality.
 */

const POOL = "flashstack-stx-pool-v2";
const ORACLE = "flashstack-pool-oracle-v2";
const GOOD = "test-pool-receiver-good"; // reads .flashstack-stx-pool fee; unused here (no flash loan)

const DEP = 100_000_000; // 100 STX

describe("flashstack-pool-oracle-v2 (matches pool v2 conversions)", () => {
  let deployer: string;
  let wallet1: string;

  const oracleLpValue = (who: string) =>
    Number((simnet.callReadOnlyFn(ORACLE, "get-lp-value", [Cl.principal(who)], deployer).result as any).value.value);
  const poolStxValue = (who: string) =>
    Number(simnet.callReadOnlyFn(POOL, "get-stx-value", [Cl.principal(who)], deployer).result.value);
  const oracleSharePrice = () =>
    Number((simnet.callReadOnlyFn(ORACLE, "get-share-price", [], deployer).result as any).value.value);

  beforeEach(() => {
    deployer = simnet.getAccounts().get("deployer")!;
    wallet1 = simnet.getAccounts().get("wallet_1")!;
  });

  it("oracle lp-value equals the pool's own get-stx-value (no drift)", () => {
    simnet.callPublicFn(POOL, "deposit", [Cl.uint(DEP)], deployer);
    simnet.callPublicFn(POOL, "deposit", [Cl.uint(DEP * 3)], wallet1);
    // The oracle a lending protocol reads must equal what the LP can actually withdraw.
    expect(oracleLpValue(deployer)).toBe(poolStxValue(deployer));
    expect(oracleLpValue(wallet1)).toBe(poolStxValue(wallet1));
    expect(oracleLpValue(deployer)).toBe(DEP);
  });

  it("oracle share-price is defined and consistent at launch (F-2 fixed: no scale jump)", () => {
    const launch = oracleSharePrice();
    simnet.callPublicFn(POOL, "deposit", [Cl.uint(DEP)], deployer);
    expect(oracleSharePrice()).toBe(launch); // one scale before and after the first deposit
  });

  it("oracle reports zero value for a non-LP", () => {
    simnet.callPublicFn(POOL, "deposit", [Cl.uint(DEP)], deployer);
    expect(oracleLpValue(wallet1)).toBe(0);
  });
});

/**
 * F-11 / F-12 (ajv.4.2 oracle-v2 review). These pin current behaviour; they are
 * not fixes. The oracle is immutable on mainnet.
 *
 * F-11: get-share-price = (balance + 1) * 1e6 / (shares + 1e6), but the pool
 * mints 1e6 shares per micro-STX, so one share is worth about 1e-6 micro-STX and
 * the "price" reads 1 at launch value. It moves only in whole multiples of the
 * launch value: a +99% gain still reads 1, and any loss below launch value
 * reads 0.
 *
 * F-12: every value function reads the pool's LIVE balance. Inside a flash-loan
 * callback, the borrowed amount is out of the pool, so anything that consults
 * the oracle in that same transaction sees deflated values. A receiver can
 * observe that, and so can any contract it calls.
 */
describe("flashstack-pool-oracle-v2: price resolution and intra-loan reads (F-11, F-12)", () => {
  let deployer: string;
  let wallet1: string;
  const price = () =>
    Number((simnet.callReadOnlyFn(ORACLE, "get-share-price", [], deployer).result as any).value.value);
  const lpValue = (who: string) =>
    Number((simnet.callReadOnlyFn(ORACLE, "get-lp-value", [Cl.principal(who)], deployer).result as any).value.value);

  beforeEach(() => {
    deployer = simnet.getAccounts().get("deployer")!;
    wallet1 = simnet.getAccounts().get("wallet_1")!;
    simnet.callPublicFn(POOL, "deposit", [Cl.uint(DEP)], deployer);
  });

  it("F-11: share-price stays 1 through a +99% value gain and only steps at 2x", () => {
    expect(price()).toBe(1);
    // A direct STX transfer raises the pool's live balance (real, withdrawable value).
    simnet.transferSTX(Math.floor(DEP * 0.99), `${deployer}.${POOL}`, wallet1);
    expect(lpValue(deployer)).toBeGreaterThan(DEP * 1.9);
    expect(price()).toBe(1);
    simnet.transferSTX(Math.floor(DEP * 0.02), `${deployer}.${POOL}`, wallet1);
    expect(price()).toBe(2);
  });

  it("F-11/F-12: read inside a flash-loan callback, share-price is 0 and lp-value drops by the loan", () => {
    const READER = "oracle-midloan-reader";
    simnet.deployContract(
      READER,
      `(impl-trait .stx-flash-receiver-trait.stx-flash-receiver-trait)
(define-data-var seen-price uint u999)
(define-data-var seen-value uint u0)
(define-public (execute-stx-flash (amount uint) (core principal))
  (let ((fee (if (> (/ (* amount u5) u10000) u0) (/ (* amount u5) u10000) u1)))
    (var-set seen-price (unwrap-panic (contract-call? .${ORACLE} get-share-price)))
    (var-set seen-value (unwrap-panic (contract-call? .${ORACLE} get-lp-value '${deployer})))
    (unwrap! (as-contract (stx-transfer? (+ amount fee) tx-sender core)) (err u902))
    (ok true)))
(define-read-only (seen) { price: (var-get seen-price), value: (var-get seen-value) })`,
      { clarityVersion: 3 },
      deployer,
    );
    const rx = `${deployer}.${READER}`;
    simnet.transferSTX(1_000_000, rx, wallet1); // fee buffer
    simnet.callPublicFn(POOL, "add-approved-receiver", [Cl.principal(rx)], deployer);
    const loan = DEP / 2;
    const r = simnet.callPublicFn(POOL, "flash-loan", [Cl.uint(loan), Cl.principal(rx)], wallet1);
    expect(r.result).toBeOk(Cl.bool(true));
    const seen = simnet.callReadOnlyFn(READER, "seen", [], deployer).result as any;
    expect(Number(seen.value.price.value)).toBe(0);
    expect(Number(seen.value.value.value)).toBe(DEP - loan); // LP's full position, minus the loan in flight
    // After the loan: restored (plus fee) and price back to 1.
    expect(price()).toBe(1);
    expect(lpValue(deployer)).toBeGreaterThanOrEqual(DEP);
  });
});
