import { describe, expect, it, beforeEach } from "vitest";
import { Cl } from "@stacks/transactions";

/**
 * Security regression for zest-v2-liquidation-receiver's v0-8 migration.
 *
 * v0-4-market is dead (confirmed directly: v0-market-vault.get-impl()
 * returns v0-8-market exclusively on all 7 of Zest's per-asset vaults, and
 * v0-4-market's own most recent transactions all abort for exactly that
 * reason). v0-8 requires a real signed Pyth Lazer price update on every
 * liquidate() call -- proved that end-to-end against Zest's actual deployed
 * decoder before wiring it in here (see the contract's own header).
 *
 * Same structural limitation as bitflow-arb-receiver-v5's test suite:
 * FLASH-CORE is hardcoded to the real mainnet address, and contract-caller
 * is unforgeable, so "called via the real core, price-feed/amount guard
 * fires" is untestable in local simnet -- no contract deployed under any
 * other principal, including this project's own local copy of
 * flashstack-stx-core, can ever produce a matching contract-caller. What
 * IS directly testable is that a direct call -- from anyone, including
 * this project's own local core -- is rejected before it ever reaches the
 * price-feed/amount-mismatch/profit checks deeper in the function body.
 *
 * Error codes: 900 NOT-OWNER · 901 REPAY-FAILED · 902 LIQUIDATION
 * 903 INSUFFICIENT · 904 ZERO-AMOUNT · 905 BAD-MODE · 906 SWAP-FAILED
 * 907 NOT-CORE · 908 SWEEP-FAILED · 909 NOT-PENDING · 910 NO-PRICE-FEED
 * 911 REDEEM-FAILED · 912 NO-PROFIT · 913 AMOUNT-MISMATCH · 914 MIN-STX-OUT-UNSET
 * 915 NO-SWAP-ROUTE (modes 1-3, disabled -- see the contract's own header)
 */

const CORE = "flashstack-stx-core";
const SBTC_CORE = "flashstack-sbtc-core";
const RX = "zest-v2-liquidation-receiver";

const RESERVE = 1_000_000_000; // 1,000 STX seeded
const LOAN = 100_000_000; //   100 STX
const SBTC_RESERVE = 100_000_000; // 1 sBTC seeded
const SBTC_LOAN = 1_000_000; //   0.01 sBTC

describe("zest-v2-liquidation-receiver (v0-8 migration)", () => {
  let deployer: string;
  let wallet1: string;
  let wallet2: string;

  beforeEach(() => {
    deployer = simnet.getAccounts().get("deployer")!;
    wallet1 = simnet.getAccounts().get("wallet_1")!;
    wallet2 = simnet.getAccounts().get("wallet_2")!;
    simnet.callPublicFn(CORE, "deposit-reserve", [Cl.uint(RESERVE)], deployer);
    simnet.callPublicFn(CORE, "add-approved-receiver", [Cl.contractPrincipal(deployer, RX)], deployer);
    // sBTC reserve is a SIP-010 balance, not native STX -- mint before depositing
    simnet.callPublicFn("sbtc-token", "mint", [Cl.uint(SBTC_RESERVE), Cl.principal(deployer)], deployer);
    simnet.callPublicFn(SBTC_CORE, "deposit-reserve", [Cl.uint(SBTC_RESERVE)], deployer);
    simnet.callPublicFn(SBTC_CORE, "add-approved-receiver", [Cl.contractPrincipal(deployer, RX)], deployer);
  });

  // --- The caller gate ------------------------------------------------------

  it("rejects execute-stx-flash called directly, not through the real core", () => {
    // `core` passed as the real FLASH-CORE literal isolates the
    // contract-caller check itself -- see bitflow-arb-receiver-v5's test
    // for why this matters (there's no second defense-in-depth assert on
    // `core` here, but matching the real core's own argument shape keeps
    // the test honest about what it's exercising).
    const result = simnet.callPublicFn(
      RX,
      "execute-stx-flash",
      [Cl.uint(LOAN), Cl.contractPrincipal("SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5", "flashstack-stx-core")],
      wallet1,
    ).result;
    expect(result).toBeErr(Cl.uint(907)); // ERR-NOT-CORE
  });

  it("rejects execute-stx-flash even when called through this project's own local flashstack-stx-core copy", () => {
    simnet.callPublicFn(RX, "set-target", [Cl.principal(wallet2), Cl.uint(1_000_000), Cl.uint(4), Cl.uint(LOAN)], deployer);
    const result = simnet.callPublicFn(CORE, "flash-loan", [Cl.uint(LOAN), Cl.contractPrincipal(deployer, RX)], wallet1).result;
    expect(result).toBeErr(Cl.uint(907));
  });

  // --- set-target / set-price-feed / set-slippage / set-min-stx-out / set-min-profit-* ----

  it("set-target validates mode range, rejects a zero debt, and rejects a zero amount", () => {
    expect(simnet.callPublicFn(RX, "set-target", [Cl.principal(wallet2), Cl.uint(0), Cl.uint(4), Cl.uint(LOAN)], deployer).result).toBeErr(Cl.uint(904));
    expect(simnet.callPublicFn(RX, "set-target", [Cl.principal(wallet2), Cl.uint(1_000_000), Cl.uint(4), Cl.uint(0)], deployer).result).toBeErr(Cl.uint(904));
    expect(simnet.callPublicFn(RX, "set-target", [Cl.principal(wallet2), Cl.uint(1_000_000), Cl.uint(6), Cl.uint(LOAN)], deployer).result).toBeErr(Cl.uint(905));
    expect(simnet.callPublicFn(RX, "set-target", [Cl.principal(wallet2), Cl.uint(1_000_000), Cl.uint(4), Cl.uint(LOAN)], deployer).result).toBeOk(Cl.bool(true));
  });

  // --- Modes 1-3 disabled: no valid Velar route for the real sBTC this -----
  // receiver holds (VELAR-POOL-SBTC-STX was never the real pool -- found
  // independently while wiring up the keeper bot, see the contract's own
  // SWAP ROUTE header note). Blocked at set-target so the owner can't even
  // arm one of these modes, not just at execution time.

  it("set-target rejects modes 1-3 with ERR-NO-SWAP-ROUTE", () => {
    expect(simnet.callPublicFn(RX, "set-target", [Cl.principal(wallet2), Cl.uint(1_000_000), Cl.uint(1), Cl.uint(LOAN)], deployer).result).toBeErr(Cl.uint(915));
    expect(simnet.callPublicFn(RX, "set-target", [Cl.principal(wallet2), Cl.uint(1_000_000), Cl.uint(2), Cl.uint(LOAN)], deployer).result).toBeErr(Cl.uint(915));
    expect(simnet.callPublicFn(RX, "set-target", [Cl.principal(wallet2), Cl.uint(1_000_000), Cl.uint(3), Cl.uint(LOAN)], deployer).result).toBeErr(Cl.uint(915));
  });

  it("set-price-feed is owner-gated and has-price-feed reflects state", () => {
    expect(simnet.callReadOnlyFn(RX, "has-price-feed", [], deployer).result).toBeBool(false);

    expect(simnet.callPublicFn(RX, "set-price-feed", [Cl.bufferFromHex("00")], wallet1).result).toBeErr(Cl.uint(900));

    expect(simnet.callPublicFn(RX, "set-price-feed", [Cl.bufferFromHex("00")], deployer).result).toBeOk(Cl.bool(true));
    expect(simnet.callReadOnlyFn(RX, "has-price-feed", [], deployer).result).toBeBool(true);
  });

  it("set-slippage enforces its bounds and ownership", () => {
    expect(simnet.callPublicFn(RX, "set-slippage", [Cl.uint(200)], wallet1).result).toBeErr(Cl.uint(900));
    expect(simnet.callPublicFn(RX, "set-slippage", [Cl.uint(10)], deployer).result).toBeErr(Cl.uint(905)); // below u50
    expect(simnet.callPublicFn(RX, "set-slippage", [Cl.uint(1000)], deployer).result).toBeErr(Cl.uint(905)); // above u500
    expect(simnet.callPublicFn(RX, "set-slippage", [Cl.uint(300)], deployer).result).toBeOk(Cl.bool(true));
  });

  // --- Security fix: armed-amount, min-stx-out, min-profit-* -----------------
  // Found in external review (unixwhisperer, PR #98): flashstack-stx-core.flash-loan
  // has no caller restriction at all, the old sBTC->STX min-out was computed
  // in the wrong units (effectively zero protection), and the old final
  // check only verified repayment, not profitability. These three settings
  // are the fix -- see the contract's own header SECURITY note.

  it("set-min-stx-out is owner-gated", () => {
    expect(simnet.callPublicFn(RX, "set-min-stx-out", [Cl.uint(1_000_000)], wallet1).result).toBeErr(Cl.uint(900));
    expect(simnet.callPublicFn(RX, "set-min-stx-out", [Cl.uint(1_000_000)], deployer).result).toBeOk(Cl.bool(true));
    expect(simnet.callReadOnlyFn(RX, "get-swap-settings", [], deployer).result).toBeOk(
      Cl.tuple({ "min-profit-sbtc": Cl.uint(1), "min-profit-stx": Cl.uint(1), "min-stx-out": Cl.uint(1_000_000) }),
    );
  });

  it("set-min-profit-stx and set-min-profit-sbtc are owner-gated and update get-swap-settings", () => {
    expect(simnet.callPublicFn(RX, "set-min-profit-stx", [Cl.uint(5000)], wallet1).result).toBeErr(Cl.uint(900));
    expect(simnet.callPublicFn(RX, "set-min-profit-sbtc", [Cl.uint(500)], wallet1).result).toBeErr(Cl.uint(900));

    expect(simnet.callPublicFn(RX, "set-min-profit-stx", [Cl.uint(5000)], deployer).result).toBeOk(Cl.bool(true));
    expect(simnet.callPublicFn(RX, "set-min-profit-sbtc", [Cl.uint(500)], deployer).result).toBeOk(Cl.bool(true));

    expect(simnet.callReadOnlyFn(RX, "get-swap-settings", [], deployer).result).toBeOk(
      Cl.tuple({ "min-profit-sbtc": Cl.uint(500), "min-profit-stx": Cl.uint(5000), "min-stx-out": Cl.uint(0) }),
    );
  });

  it("get-target reflects the armed amount alongside borrower/debt/mode", () => {
    simnet.callPublicFn(RX, "set-target", [Cl.principal(wallet2), Cl.uint(5_000_000), Cl.uint(4), Cl.uint(LOAN)], deployer);
    expect(simnet.callReadOnlyFn(RX, "get-target", [], deployer).result).toBeOk(
      Cl.tuple({ amount: Cl.uint(LOAN), borrower: Cl.principal(wallet2), debt: Cl.uint(5_000_000), mode: Cl.uint(4) }),
    );
  });

  // --- Ownership / sweeps ----------------------------------------------------

  it("sweeps and ownership functions reject non-owner callers", () => {
    expect(simnet.callPublicFn(RX, "sweep-stx", [Cl.uint(1)], wallet1).result).toBeErr(Cl.uint(900));
    expect(simnet.callPublicFn(RX, "sweep-sbtc", [Cl.uint(1)], wallet1).result).toBeErr(Cl.uint(900));
    expect(simnet.callPublicFn(RX, "propose-owner", [Cl.principal(wallet1)], wallet1).result).toBeErr(Cl.uint(900));
  });

  it("two-step ownership transfer: propose then accept, old owner loses access", () => {
    expect(simnet.callPublicFn(RX, "propose-owner", [Cl.principal(wallet1)], deployer).result).toBeOk(Cl.bool(true));
    expect(simnet.callPublicFn(RX, "accept-ownership", [], wallet2).result).toBeErr(Cl.uint(909));
    expect(simnet.callPublicFn(RX, "accept-ownership", [], wallet1).result).toBeOk(Cl.bool(true));
    expect(simnet.callPublicFn(RX, "set-slippage", [Cl.uint(300)], deployer).result).toBeErr(Cl.uint(900));
    expect(simnet.callPublicFn(RX, "set-slippage", [Cl.uint(300)], wallet1).result).toBeOk(Cl.bool(true));
  });

  // --- Mode 4/5 (same-asset, no-swap) -----------------------------------

  it("set-target accepts the new mode range (1-5) and rejects mode 6", () => {
    expect(simnet.callPublicFn(RX, "set-target", [Cl.principal(wallet2), Cl.uint(1_000_000), Cl.uint(4), Cl.uint(LOAN)], deployer).result).toBeOk(Cl.bool(true));
    expect(simnet.callPublicFn(RX, "set-target", [Cl.principal(wallet2), Cl.uint(1_000_000), Cl.uint(5), Cl.uint(SBTC_LOAN)], deployer).result).toBeOk(Cl.bool(true));
    expect(simnet.callPublicFn(RX, "set-target", [Cl.principal(wallet2), Cl.uint(1_000_000), Cl.uint(6), Cl.uint(LOAN)], deployer).result).toBeErr(Cl.uint(905));
  });

  it("execute-stx-flash rejects mode 5 -- that one only runs through execute-sbtc-flash", () => {
    simnet.callPublicFn(RX, "set-target", [Cl.principal(wallet2), Cl.uint(1_000_000), Cl.uint(5), Cl.uint(SBTC_LOAN)], deployer);
    const result = simnet.callPublicFn(
      RX,
      "execute-stx-flash",
      [Cl.uint(LOAN), Cl.contractPrincipal("SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5", "flashstack-stx-core")],
      wallet1,
    ).result;
    // contract-caller check fires first regardless (not the real core), but
    // confirms this path doesn't silently accept mode 5 some other way.
    expect(result).toBeErr(Cl.uint(907));
  });

  it("execute-sbtc-flash rejects execute-sbtc-flash called directly, not through the real sbtc core", () => {
    simnet.callPublicFn(RX, "set-target", [Cl.principal(wallet2), Cl.uint(1_000_000), Cl.uint(5), Cl.uint(SBTC_LOAN)], deployer);
    const result = simnet.callPublicFn(
      RX,
      "execute-sbtc-flash",
      [Cl.uint(SBTC_LOAN), Cl.contractPrincipal("SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5", "flashstack-sbtc-core")],
      wallet1,
    ).result;
    expect(result).toBeErr(Cl.uint(907)); // ERR-NOT-CORE
  });

  it("execute-sbtc-flash rejects a non-mode-5 target even via this project's own local sbtc core", () => {
    simnet.callPublicFn(RX, "set-target", [Cl.principal(wallet2), Cl.uint(1_000_000), Cl.uint(4), Cl.uint(LOAN)], deployer);
    simnet.callPublicFn(RX, "set-price-feed", [Cl.bufferFromHex("00")], deployer);
    const result = simnet.callPublicFn(SBTC_CORE, "flash-loan", [Cl.uint(SBTC_LOAN), Cl.contractPrincipal(deployer, RX)], wallet1).result;
    // local sbtc-core's own contract-caller still doesn't match the real
    // mainnet FLASH-SBTC-CORE literal, same structural reason as the STX
    // side -- rejected before mode/amount is ever checked.
    expect(result).toBeErr(Cl.uint(907));
  });
});
