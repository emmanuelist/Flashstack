import { describe, expect, it, beforeEach } from "vitest";
import { Cl } from "@stacks/transactions";

/**
 * Flashstack-ajv.4.12: does flashstack-sbtc-pool-v2's built-in get-share-price
 * have the F-11 resolution problem? Yes. These tests pin current behaviour; the
 * pool is immutable on mainnet (SPR9PQAN..., paused since 2026-10-01).
 *
 * get-share-price = (balance + 1) * 1e8 / (shares + 1e8), but deposit mints
 * amount * (shares + 1e8) / (balance + 1) shares, i.e. 1e8 shares per sat. One
 * share is worth about 1e-8 sat, so the "price" reads 1, not the 1e8 the
 * contract header promises. It only moves in whole multiples of the launch
 * value: a +99% gain still reads 1, and any dip below launch value (only
 * reachable mid-flash-loan, F-12) reads 0. get-collateral-snapshot.share-price
 * is the same expression. get-lp-value is exact to the sat.
 *
 * LP_DEP is the live pool balance (44,990 sats), so the share count below
 * matches the live get-stats total-shares (4,499,000,000,000) exactly.
 */

const POOL = "flashstack-sbtc-pool-v2";
const SBTC = "sbtc-token";
const LP_DEP = 44_990;

describe("flashstack-sbtc-pool-v2: get-share-price resolution (F-11 shape, ajv.4.12)", () => {
  let deployer: string;
  let lp: string;
  let donor: string;

  const mint = (amount: number, to: string) =>
    expect(simnet.callPublicFn(SBTC, "mint", [Cl.uint(amount), Cl.principal(to)], deployer).result).toBeOk(Cl.bool(true));
  const price = () =>
    Number((simnet.callReadOnlyFn(POOL, "get-share-price", [], deployer).result as any).value.value);
  const snapshotPrice = () =>
    Number((simnet.callReadOnlyFn(POOL, "get-collateral-snapshot", [], deployer).result as any).value.value["share-price"].value);
  const lpValue = (who: string) =>
    Number((simnet.callReadOnlyFn(POOL, "get-lp-value", [Cl.principal(who)], deployer).result as any).value.value);
  const donate = (amount: number) => {
    mint(amount, donor);
    expect(
      simnet.callPublicFn(SBTC, "transfer", [Cl.uint(amount), Cl.principal(donor), Cl.principal(`${deployer}.${POOL}`), Cl.none()], donor).result,
    ).toBeOk(Cl.bool(true));
  };

  beforeEach(() => {
    const a = simnet.getAccounts();
    deployer = a.get("deployer")!;
    lp = a.get("wallet_1")!;
    donor = a.get("wallet_2")!;
  });

  it("reads 1 at launch, not the 1e8 the header documents", () => {
    expect(price()).toBe(1);
    expect(snapshotPrice()).toBe(1);
  });

  it("at the live balance (44,990 sats) it reads 1, and only steps to 2 when the pool value doubles", () => {
    mint(LP_DEP, lp);
    expect(simnet.callPublicFn(POOL, "deposit", [Cl.uint(LP_DEP)], lp).result).toBeOk(Cl.uint(4_499_000_000_000));
    expect(price()).toBe(1);

    // price = floor((balance + 1) / 44,991), so it reads 1 up to balance 89,980.
    donate(LP_DEP); // +100% of the LP's deposit, minus the 1 phantom sat
    expect(lpValue(lp)).toBe(89_979); // ~2x the deposit, yet the price has not moved
    expect(price()).toBe(1);
    expect(snapshotPrice()).toBe(1);

    donate(1);
    expect(price()).toBe(2);
  });

  it("read inside a flash-loan callback, share-price is 0 while lp-value drops by the loan (F-12 shape)", () => {
    mint(LP_DEP, lp);
    simnet.callPublicFn(POOL, "deposit", [Cl.uint(LP_DEP)], lp);

    const READER = "sbtc-pool-v2-midloan-reader";
    simnet.deployContract(
      READER,
      `(impl-trait .sbtc-flash-receiver-trait.sbtc-flash-receiver-trait)
(define-data-var seen-price uint u999)
(define-data-var seen-value uint u0)
(define-public (execute-sbtc-flash (amount uint) (core principal))
  (let ((fee (if (> (/ (* amount u5) u10000) u0) (/ (* amount u5) u10000) u1)))
    (var-set seen-price (unwrap-panic (contract-call? .${POOL} get-share-price)))
    (var-set seen-value (unwrap-panic (contract-call? .${POOL} get-lp-value '${lp})))
    (unwrap! (as-contract (contract-call? .${SBTC} transfer (+ amount fee) tx-sender .${POOL} none)) (err u902))
    (ok true)))
(define-read-only (seen) { price: (var-get seen-price), value: (var-get seen-value) })`,
      { clarityVersion: 3 },
      deployer,
    );
    const rx = `${deployer}.${READER}`;
    mint(100, rx); // fee buffer
    expect(simnet.callPublicFn(POOL, "add-approved-receiver", [Cl.principal(rx)], deployer).result).toBeOk(Cl.bool(true));

    const loan = 20_000;
    expect(simnet.callPublicFn(POOL, "flash-loan", [Cl.uint(loan), Cl.principal(rx)], donor).result).toBeOk(Cl.bool(true));
    const seen = simnet.callReadOnlyFn(READER, "seen", [], deployer).result as any;
    expect(Number(seen.value.price.value)).toBe(0);
    expect(Number(seen.value.value.value)).toBe(LP_DEP - loan); // LP's full position, minus the loan in flight
    expect(price()).toBe(1);
  });
});
