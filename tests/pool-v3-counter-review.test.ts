import { describe, expect, it, beforeEach } from "vitest";
import { Cl } from "@stacks/transactions";

/**
 * Counter-review of docs/security/CLARITY_AUDIT_CORE_AND_V3_POOLS.md:
 * findings that audit and the earlier pool-v3 reviews did not cover. Each
 * test pins CURRENT behaviour, so it should be flipped when the fix lands
 * (CR-1 has been flipped: MAX-DECIMALS is now u8).
 * See docs/security/POOL_V3_AUDIT_COUNTER_REVIEW.md.
 *
 * CR-1: share math overflows uint128 for high-decimal assets.
 *   share-scale = 10^decimals (F2), and add-asset accepted up to 24 decimals.
 *   The first LP gets shares ~= amount * 10^d, so withdraw computes
 *   shares * (balance + 1) ~= a^2 * 10^d. That exceeds 2^128 (~3.4e38) once
 *   a > sqrt(3.4e38 / 10^d): ~1.8e15 base units at 8 decimals (fine for
 *   sBTC), ~18 tokens at 12 decimals, ~1.8e-8 tokens at 18 decimals. Past
 *   that point the LP can't exit in one call, new deposits abort, and the
 *   get-lp-value oracle read aborts.
 *
 *   Test tokens are deployed at runtime with simnet.deployContract, not
 *   registered in Clarinet.toml, so they never reach the computed mainnet
 *   plan (tests/mainnet-plan-guard.test.ts).
 *
 * CR-2: the receiver allowlist is global, not per asset. A receiver approved
 *   for one asset can be named by anyone, in any listed asset, at any amount.
 *   A receiver that pays the fee from its own buffer then bleeds that buffer
 *   to the pool's LPs, one fee per stranger-initiated loan.
 */

const POOL = "flashstack-pool-v3";
const SBTC = "sbtc-token"; // 8 decimals, deployer can mint
const USDC = "mock-usdcx"; // 6 decimals, freely mintable
const GOOD_RX = "test-pool-v3-receiver-good"; // repays amount + fee from its own balance

const tokenSource = (decimals: number) => `(impl-trait .sip-010-trait-ft-standard.sip-010-trait)
(define-fungible-token t)
(define-public (transfer (amount uint) (sender principal) (recipient principal) (memo (optional (buff 34))))
  (begin
    (asserts! (or (is-eq tx-sender sender) (is-eq contract-caller sender)) (err u4))
    (ft-transfer? t amount sender recipient)))
(define-read-only (get-name) (ok "Test"))
(define-read-only (get-symbol) (ok "TST"))
(define-read-only (get-decimals) (ok u${decimals}))
(define-read-only (get-balance (who principal)) (ok (ft-get-balance t who)))
(define-read-only (get-total-supply) (ok (ft-get-supply t)))
(define-read-only (get-token-uri) (ok none))
(define-public (mint (amount uint) (to principal)) (ft-mint? t amount to))`;

let deployer: string;
let lp1: string;
let lp2: string;
let stranger: string;

const tokenArg = (name: string) => Cl.contractPrincipal(deployer, name);

const listToken = (name: string, decimals: number) => {
  expect(simnet.deployContract(name, tokenSource(decimals), null, deployer).result).toBeBool(true);
  return simnet.callPublicFn(POOL, "add-asset", [tokenArg(name), Cl.uint(5), Cl.uint(1_000_000_000)], deployer);
};

const mint = (name: string, amount: bigint, to: string) =>
  expect(simnet.callPublicFn(name, "mint", [Cl.uint(amount), Cl.principal(to)], deployer).result).toBeOk(Cl.bool(true));

const deposit = (name: string, amount: bigint, who: string) =>
  simnet.callPublicFn(POOL, "deposit", [tokenArg(name), Cl.uint(amount)], who);

const withdraw = (name: string, shares: bigint, who: string) =>
  simnet.callPublicFn(POOL, "withdraw", [tokenArg(name), Cl.uint(shares)], who);

const sharesOf = (name: string, who: string) =>
  BigInt((simnet.callReadOnlyFn(POOL, "get-shares", [Cl.principal(`${deployer}.${name}`), Cl.principal(who)], deployer).result as any).value);

describe("pool-v3 counter-review", () => {
  beforeEach(() => {
    const a = simnet.getAccounts();
    deployer = a.get("deployer")!;
    lp1 = a.get("wallet_1")!;
    lp2 = a.get("wallet_2")!;
    stranger = a.get("wallet_3")!;
  });

  describe("CR-1: share math overflows for high-decimal assets (fixed: MAX-DECIMALS u8)", () => {
    // Before the fix MAX-DECIMALS was u24: an 18-decimal LP holding 1e-7 of a
    // token could not withdraw, and 12 decimals failed at 100 tokens. Now
    // add-asset refuses anything above 8 decimals, so those pools never exist.
    for (const d of [9, 12, 18, 24]) {
      it(`add-asset rejects a ${d}-decimal token with ERR-DECIMALS-TOO-LARGE`, () => {
        expect(listToken(`tok${d}`, d).result).toBeErr(Cl.uint(817));
      });
    }

    it("8 decimals (sBTC-shaped) lists and stays safe at 1,000,000 whole tokens", () => {
      expect(listToken("tok8", 8).result).toBeOk(Cl.bool(true));
      const a = 1_000_000n * 10n ** 8n; // 1e14 base units
      mint("tok8", a, lp1);
      expect(deposit("tok8", a, lp1).result).toBeOk(Cl.uint(a * 10n ** 8n));
      expect(withdraw("tok8", sharesOf("tok8", lp1), lp1).result).toBeOk(Cl.uint(a));
    });
  });

  describe("CR-2: the receiver allowlist is global across assets", () => {
    it("a stranger can make an approved receiver pay fees in an asset it was never set up for", () => {
      // Two assets listed. The receiver is approved once; the allowlist has no asset dimension.
      expect(simnet.callPublicFn(POOL, "add-asset", [tokenArg(SBTC), Cl.uint(5), Cl.uint(1_000_000_000)], deployer).result).toBeOk(Cl.bool(true));
      expect(simnet.callPublicFn(POOL, "add-asset", [tokenArg(USDC), Cl.uint(5), Cl.uint(1_000_000_000)], deployer).result).toBeOk(Cl.bool(true));
      expect(simnet.callPublicFn(POOL, "add-approved-receiver", [tokenArg(GOOD_RX)], deployer).result).toBeOk(Cl.bool(true));

      // LP liquidity in sBTC; the receiver happens to hold an sBTC buffer.
      expect(simnet.callPublicFn(SBTC, "mint", [Cl.uint(100_000_000), Cl.principal(lp1)], deployer).result).toBeOk(Cl.bool(true));
      expect(deposit(SBTC, 100_000_000n, lp1).result).toBeOk(Cl.uint(100_000_000n * 10n ** 8n));
      const buffer = 1_000;
      expect(simnet.callPublicFn(SBTC, "mint", [Cl.uint(buffer), Cl.principal(`${deployer}.${GOOD_RX}`)], deployer).result).toBeOk(Cl.bool(true));

      const rxBal = () =>
        Number((simnet.callReadOnlyFn(SBTC, "get-balance", [Cl.principal(`${deployer}.${GOOD_RX}`)], deployer).result as any).value.value);

      // Stranger triggers 2 loans of 1,000,000 sats (fee 500 each) naming the receiver.
      for (let i = 0; i < 2; i++) {
        expect(
          simnet.callPublicFn(POOL, "flash-loan", [tokenArg(SBTC), Cl.uint(1_000_000), tokenArg(GOOD_RX)], stranger).result,
        ).toBeOk(Cl.bool(true));
      }
      expect(rxBal()).toBe(buffer - 2 * 500);
    });
  });
});
