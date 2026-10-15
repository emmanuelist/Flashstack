import { describe, expect, it, beforeEach } from "vitest";
import { Cl, ClarityType, cvToValue, type ClarityValue } from "@stacks/transactions";

/**
 * hk-sbtc-real-receiver-v2 against the REAL lender at its mainnet principal
 * (Clarinet requirement SP20XD46...flashstack-sbtc-core, not the local
 * contracts/test/ copy). Because the core here IS the hardcoded FLASH-CORE,
 * contract-caller matches on the honest path, so every receiver guard runs
 * for real, in both directions. bitflow-arb-receiver-v5 could only test the
 * reject side, because it used the local core copy.
 *
 * sBTC is the real SM3VDXK...sbtc-token, minted via sbtc-deposit while signing
 * as the registry's signer principal (simnet can sign as any standard principal).
 *
 * WHAT SIMNET CANNOT DO: run the Bitflow legs. Simnet is a testnet chain, so
 * `is-standard` is false for every SP/SM principal. xyk-core-v-1-2 asserts it
 * on the tokens in create-pool and pool-transfer, and token-stx-v-1-2 asserts it
 * on sender/recipient. Pool 21 can't be recreated here (create-pool fails with
 * u1003 ERR_INVALID_PRINCIPAL). In this suite the honest path therefore stops
 * at leg 1 with ERR-SWAP-LEG1, which proves every guard before the swap let it
 * through. The swap legs, min-out enforcement and under-repayment have to be
 * proven by a small mainnet smoke loan after deploy, the same way
 * hk-sbtc-real-receiver-v1 and hk-stx-bitflow-receiver-v1 were.
 *
 * Errors: 600 NOT-OWNER, 601 NOT-CORE, 602 NOT-ARMED, 603 WRONG-AMOUNT,
 * 605 SWAP-LEG1, 609 ZERO-AMOUNT, 610 NOT-PENDING. Core: 306 NOT-APPROVED.
 */

const SBTC_DEPLOYER = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";
const SBTC = `${SBTC_DEPLOYER}.sbtc-token`;
const CORE_ADDR = "SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5";
const CORE = `${CORE_ADDR}.flashstack-sbtc-core`;
const RX = "hk-sbtc-real-receiver-v2";

const RESERVE = 5_000_000; // core reserve, sats
const LOAN = 100_000; // 0.001 sBTC
const SEED = 10_000;

let deployer: string;
let wallet1: string;
let wallet2: string;
let rx: string;
let txSeq = 0;

const ok = (r: { result: ClarityValue }) => {
  if (r.result.type !== ClarityType.ResponseOk) throw new Error(`expected ok, got ${JSON.stringify(cvToValue(r.result))}`);
  return r;
};

const mintSbtc = (amount: number, recipient: string) => {
  const signer = cvToValue(simnet.callReadOnlyFn(`${SBTC_DEPLOYER}.sbtc-registry`, "get-current-signer-principal", [], deployer).result);
  const h = simnet.burnBlockHeight - 1;
  const hash = Cl.deserialize(simnet.runSnippet(`(unwrap-panic (get-burn-block-info? header-hash u${h}))`) as unknown as string);
  const txid = new Uint8Array(32);
  txid[0] = ++txSeq;
  ok(simnet.callPublicFn(`${SBTC_DEPLOYER}.sbtc-deposit`, "complete-deposit-wrapper",
    [Cl.buffer(txid), Cl.uint(0), Cl.uint(amount), Cl.principal(recipient), hash, Cl.uint(h), Cl.buffer(new Uint8Array(32))], signer));
};

const sbtcBal = (who: string) =>
  Number(cvToValue(simnet.callReadOnlyFn(SBTC, "get-balance", [Cl.principal(who)], deployer).result).value);

const flash = (amount: number, caller = wallet1) =>
  simnet.callPublicFn(CORE, "flash-loan", [Cl.uint(amount), Cl.principal(rx)], caller);

const arm = (amount: number, minStx = 1, minSbtc = 1, caller = deployer) =>
  simnet.callPublicFn(RX, "arm-loan", [Cl.uint(amount), Cl.uint(minStx), Cl.uint(minSbtc)], caller);

describe("hk-sbtc-real-receiver-v2", () => {
  beforeEach(() => {
    const accts = simnet.getAccounts();
    deployer = accts.get("deployer")!;
    wallet1 = accts.get("wallet_1")!;
    wallet2 = accts.get("wallet_2")!;
    rx = `${deployer}.${RX}`;

    // The live core's admin is its deployer principal.
    mintSbtc(RESERVE, CORE_ADDR);
    ok(simnet.callPublicFn(CORE, "deposit-reserve", [Cl.uint(RESERVE)], CORE_ADDR));
    ok(simnet.callPublicFn(CORE, "add-approved-receiver", [Cl.principal(rx)], CORE_ADDR));
    mintSbtc(SEED, rx);
  });

  // --- Honest path, up to the DEX ----------------------------------------

  it("an armed loan through the real core passes every receiver guard and reaches Bitflow leg 1", () => {
    const coreBefore = sbtcBal(CORE);
    ok(arm(LOAN));
    expect(flash(LOAN).result).toBeErr(Cl.uint(605)); // ERR-SWAP-LEG1, see header
    expect(sbtcBal(CORE)).toBe(coreBefore);
    expect(sbtcBal(rx)).toBe(SEED);
  });

  // --- B4/B5: who can call it -------------------------------------------

  it("rejects a direct call to execute-sbtc-flash, even with the real core as argument", () => {
    ok(arm(LOAN));
    expect(simnet.callPublicFn(RX, "execute-sbtc-flash", [Cl.uint(LOAN), Cl.principal(CORE)], wallet1).result)
      .toBeErr(Cl.uint(601));
    expect(simnet.callPublicFn(RX, "execute-sbtc-flash", [Cl.uint(LOAN), Cl.principal(wallet1)], wallet1).result)
      .toBeErr(Cl.uint(601));
    expect(sbtcBal(rx)).toBe(SEED);
  });

  // --- C7: armed state is bound to the amount -----------------------------

  it("a stranger's loan with nothing armed is rejected", () => {
    expect(flash(LOAN).result).toBeErr(Cl.uint(602));
    expect(sbtcBal(rx)).toBe(SEED);
  });

  it("a loan for a different amount than armed is rejected", () => {
    ok(arm(LOAN));
    expect(flash(LOAN + 1).result).toBeErr(Cl.uint(603));
    expect(flash(LOAN - 1).result).toBeErr(Cl.uint(603));
  });

  it("disarm clears a prepared loan", () => {
    ok(arm(LOAN));
    ok(simnet.callPublicFn(RX, "disarm", [], deployer));
    expect(flash(LOAN).result).toBeErr(Cl.uint(602));
  });

  it("the core still refuses a receiver it hasn't approved", () => {
    ok(simnet.callPublicFn(CORE, "remove-approved-receiver", [Cl.principal(rx)], CORE_ADDR));
    ok(arm(LOAN));
    expect(flash(LOAN).result).toBeErr(Cl.uint(306));
  });

  // --- E17/E18: owner functions -----------------------------------------

  it("arm, disarm and rescue are owner-only", () => {
    expect(arm(LOAN, 1, 1, wallet1).result).toBeErr(Cl.uint(600));
    expect(simnet.callPublicFn(RX, "disarm", [], wallet1).result).toBeErr(Cl.uint(600));
    expect(simnet.callPublicFn(RX, "rescue-sbtc", [Cl.uint(1)], wallet1).result).toBeErr(Cl.uint(600));
    expect(simnet.callPublicFn(RX, "rescue-stx", [Cl.uint(1)], wallet1).result).toBeErr(Cl.uint(600));
  });

  it("arm-loan rejects a zero amount or zero minimums (Bitflow rejects min u0)", () => {
    expect(arm(0).result).toBeErr(Cl.uint(609));
    expect(arm(LOAN, 0, 1).result).toBeErr(Cl.uint(609));
    expect(arm(LOAN, 1, 0).result).toBeErr(Cl.uint(609));
  });

  it("rescue sends only to the owner and rejects zero", () => {
    expect(simnet.callPublicFn(RX, "rescue-sbtc", [Cl.uint(0)], deployer).result).toBeErr(Cl.uint(609));
    const before = sbtcBal(deployer);
    ok(simnet.callPublicFn(RX, "rescue-sbtc", [Cl.uint(SEED)], deployer));
    expect(sbtcBal(deployer)).toBe(before + SEED);
    expect(sbtcBal(rx)).toBe(0);
  });

  it("ownership moves only in two steps, and the new owner inherits no arm", () => {
    ok(arm(LOAN));
    expect(simnet.callPublicFn(RX, "accept-ownership", [], wallet1).result).toBeErr(Cl.uint(610));
    ok(simnet.callPublicFn(RX, "propose-owner", [Cl.principal(wallet1)], deployer));
    expect(simnet.callPublicFn(RX, "accept-ownership", [], wallet2).result).toBeErr(Cl.uint(610));
    ok(simnet.callPublicFn(RX, "accept-ownership", [], wallet1));
    expect(simnet.callReadOnlyFn(RX, "get-owner", [], deployer).result).toBeOk(Cl.principal(wallet1));
    expect(flash(LOAN).result).toBeErr(Cl.uint(602));
    expect(arm(LOAN).result).toBeErr(Cl.uint(600));
    ok(arm(LOAN, 1, 1, wallet1));
  });
});
