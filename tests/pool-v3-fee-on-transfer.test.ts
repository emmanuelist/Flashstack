import { describe, expect, it, beforeEach } from "vitest";
import { Cl } from "@stacks/transactions";

/**
 * Threat model row 14 / Flashstack-ajv.3.5: what flashstack-pool-v3 does with
 * a fee-on-transfer token. Pins CURRENT behaviour. The fix is a listing rule
 * (docs/security/POOL_V3_LISTING_POLICY.md), not a contract change.
 *
 * Two token shapes, both taking a 10% tax per transfer and burning it:
 *   - recipient-pays: the sender loses `amount`, the recipient gets 90%.
 *   - sender-pays: the recipient gets `amount`, the sender loses 110%.
 *
 * recipient-pays: deposit mints shares on the requested `amount` and caches
 *   reserve = balance + amount, but the pool only receives 90%. Each depositor
 *   is credited for the tax it didn't deliver, paid for by earlier LPs. Flash
 *   loans revert (the repay check reads the live balance, so it can't be
 *   satisfied short; an honest receiver just under-delivers).
 *
 * sender-pays: deposits work, but every outbound transfer burns extra from the
 *   pool, which exceeds the `as-contract?` with-ft allowance. withdraw and
 *   flash-loan abort with ERR-TRANSFER-FAILED, so LP funds are locked. Only
 *   withdrawals small enough to pay zero tax (< 10 base units here) get out.
 *
 * Test tokens are deployed at runtime with simnet.deployContract, not
 * registered in Clarinet.toml, so they never reach the computed mainnet plan.
 */

const POOL = "flashstack-pool-v3";
const GOOD_RX = "test-pool-v3-receiver-good"; // repays amount + fee from its own balance

const ERR_REPAY_FAILED = 810;
const ERR_TRANSFER_FAILED = 811;

const taxedToken = (mode: "recipient" | "sender") => `(impl-trait .sip-010-trait-ft-standard.sip-010-trait)
(define-fungible-token t)
(define-public (transfer (amount uint) (sender principal) (recipient principal) (memo (optional (buff 34))))
  (let ((tax (/ (* amount u1000) u10000)))
    (asserts! (or (is-eq tx-sender sender) (is-eq contract-caller sender)) (err u4))
    ${
      mode === "recipient"
        ? "(if (> tax u0) (try! (ft-burn? t tax sender)) true)\n    (ft-transfer? t (- amount tax) sender recipient)"
        : "(try! (ft-transfer? t amount sender recipient))\n    (if (> tax u0) (ft-burn? t tax sender) (ok true))"
    }))
(define-read-only (get-name) (ok "Taxed"))
(define-read-only (get-symbol) (ok "TAX"))
(define-read-only (get-decimals) (ok u6))
(define-read-only (get-balance (who principal)) (ok (ft-get-balance t who)))
(define-read-only (get-total-supply) (ok (ft-get-supply t)))
(define-read-only (get-token-uri) (ok none))
(define-public (mint (amount uint) (to principal)) (ft-mint? t amount to))`;

let deployer: string;
let lp1: string;
let lp2: string;
let stranger: string;

const uintOf = (cv: any) => BigInt(cv.value);
const okUint = (cv: any) => BigInt(cv.value.value);

const setup = (name: string, mode: "recipient" | "sender") => {
  expect(simnet.deployContract(name, taxedToken(mode), null, deployer).result).toBeBool(true);
  const token = Cl.contractPrincipal(deployer, name);
  const asset = Cl.principal(`${deployer}.${name}`);
  expect(simnet.callPublicFn(POOL, "add-asset", [token, Cl.uint(5), Cl.uint(1_000_000_000)], deployer).result).toBeOk(Cl.bool(true));
  const mint = (amount: bigint, to: string) =>
    expect(simnet.callPublicFn(name, "mint", [Cl.uint(amount), Cl.principal(to)], deployer).result).toBeOk(Cl.bool(true));
  const balance = (who: string) => okUint(simnet.callReadOnlyFn(name, "get-balance", [Cl.principal(who)], deployer).result);
  const poolBalance = () => balance(`${deployer}.${POOL}`);
  const deposit = (amount: bigint, who: string) => simnet.callPublicFn(POOL, "deposit", [token, Cl.uint(amount)], who).result;
  const withdraw = (shares: bigint, who: string) => simnet.callPublicFn(POOL, "withdraw", [token, Cl.uint(shares)], who).result;
  const shares = (who: string) => uintOf(simnet.callReadOnlyFn(POOL, "get-shares", [asset, Cl.principal(who)], deployer).result);
  const reserve = () => okUint(simnet.callReadOnlyFn(POOL, "get-reserve", [asset], deployer).result);
  const lpValue = (who: string) => okUint(simnet.callReadOnlyFn(POOL, "get-lp-value", [asset, Cl.principal(who)], deployer).result);
  return { token, mint, balance, poolBalance, deposit, withdraw, shares, reserve, lpValue };
};

describe("pool-v3 with a fee-on-transfer token (threat model row 14)", () => {
  beforeEach(() => {
    const a = simnet.getAccounts();
    deployer = a.get("deployer")!;
    lp1 = a.get("wallet_1")!;
    lp2 = a.get("wallet_2")!;
    stranger = a.get("wallet_3")!;
  });

  describe("recipient-pays tax (10%)", () => {
    it("deposit credits the tax the pool never received, and the second LP takes it from the first", () => {
      const t = setup("tax-recipient", "recipient");
      t.mint(1_000_000n, lp1);
      t.mint(1_000_000n, lp2);

      // LP1 pays 1,000,000; the pool receives 900,000 but caches 1,000,000.
      expect(t.deposit(1_000_000n, lp1)).toBeOk(Cl.uint(1_000_000_000_000n));
      expect(t.poolBalance()).toBe(900_000n);
      expect(t.reserve()).toBe(1_000_000n);
      expect(t.lpValue(lp1)).toBe(1_000_000n); // reads the cached reserve, so it's overstated

      // LP2 pays the same 1,000,000 (pool again gets 900,000) but is priced
      // against the 900,000 actually held, so it gets 11% more shares.
      expect(t.deposit(1_000_000n, lp2)).toBeOk(Cl.uint(1_111_110_987_654n));
      expect(t.poolBalance()).toBe(1_800_000n);
      expect(t.reserve()).toBe(1_900_000n); // cache still 100,000 above the live balance

      // Exit. Both delivered 900,000, but LP2 takes 947,368 and LP1 852,632:
      // 47,368 moved from LP1 to LP2. The pool ends empty, so nothing is lost
      // overall; it is a transfer between LPs.
      expect(t.withdraw(1_111_110_987_654n, lp2)).toBeOk(Cl.uint(947_368n));
      expect(t.withdraw(1_000_000_000_000n, lp1)).toBeOk(Cl.uint(852_632n));
      expect(t.poolBalance()).toBe(0n);

      // The withdrawer pays the outbound tax itself; the pool sends exactly amount-out.
      expect(t.balance(lp2)).toBe(852_632n); // 947,368 - 10%
      expect(t.balance(lp1)).toBe(767_369n); // 852,632 - 10%
    });

    it("an honest flash loan reverts with ERR-REPAY-FAILED; the repay check can't be met short", () => {
      const t = setup("tax-recipient-fl", "recipient");
      t.mint(1_000_000n, lp1);
      expect(t.deposit(1_000_000n, lp1)).toBeOk(Cl.uint(1_000_000_000_000n));
      expect(simnet.callPublicFn(POOL, "add-approved-receiver", [Cl.contractPrincipal(deployer, GOOD_RX)], deployer).result).toBeOk(Cl.bool(true));
      t.mint(500_000n, `${deployer}.${GOOD_RX}`);

      // The receiver gets 90,000 of a 100,000 loan and sends back 100,050; the
      // pool receives 90,045. reserve-after is read live, so the check fails.
      expect(
        simnet.callPublicFn(POOL, "flash-loan", [t.token, Cl.uint(100_000), Cl.contractPrincipal(deployer, GOOD_RX)], stranger).result,
      ).toBeErr(Cl.uint(ERR_REPAY_FAILED));
      expect(t.poolBalance()).toBe(900_000n);
      expect(t.balance(`${deployer}.${GOOD_RX}`)).toBe(500_000n);
    });
  });

  describe("sender-pays tax (10%)", () => {
    it("deposits work, but withdraw aborts on the as-contract? allowance and LP funds are locked", () => {
      const t = setup("tax-sender", "sender");
      t.mint(2_000_000n, lp1);
      t.mint(2_000_000n, lp2);

      // Inbound: the depositor pays the tax, the pool gets the full amount.
      expect(t.deposit(1_000_000n, lp1)).toBeOk(Cl.uint(1_000_000_000_000n));
      expect(t.deposit(1_000_000n, lp2)).toBeOk(Cl.uint(1_000_000_000_000n));
      expect(t.poolBalance()).toBe(2_000_000n);
      expect(t.balance(lp1)).toBe(900_000n);

      // Outbound: the pool would have to burn 10% on top of amount-out, which
      // its with-ft allowance (exactly amount-out) doesn't cover.
      expect(t.withdraw(t.shares(lp1), lp1)).toBeErr(Cl.uint(ERR_TRANSFER_FAILED));
      expect(t.withdraw(10_000_000n, lp1)).toBeErr(Cl.uint(ERR_TRANSFER_FAILED)); // amount-out 10, tax 1

      // Only a withdrawal that pays zero tax gets out: 9 base units per call.
      expect(t.withdraw(9_000_000n, lp1)).toBeOk(Cl.uint(9n));
      expect(t.poolBalance()).toBe(1_999_991n);

      // New deposits are still accepted into the locked pool.
      expect(t.deposit(100_000n, lp2)).toBeOk(Cl.uint(100_000_000_000n));
    });

    it("flash-loan aborts on the outbound transfer with ERR-TRANSFER-FAILED", () => {
      const t = setup("tax-sender-fl", "sender");
      t.mint(1_100_000n, lp1); // 1,000,000 deposit + 100,000 tax
      expect(t.deposit(1_000_000n, lp1)).toBeOk(Cl.uint(1_000_000_000_000n));
      expect(simnet.callPublicFn(POOL, "add-approved-receiver", [Cl.contractPrincipal(deployer, GOOD_RX)], deployer).result).toBeOk(Cl.bool(true));
      t.mint(500_000n, `${deployer}.${GOOD_RX}`);

      expect(
        simnet.callPublicFn(POOL, "flash-loan", [t.token, Cl.uint(100_000), Cl.contractPrincipal(deployer, GOOD_RX)], stranger).result,
      ).toBeErr(Cl.uint(ERR_TRANSFER_FAILED));
      expect(t.poolBalance()).toBe(1_000_000n);
    });
  });
});
