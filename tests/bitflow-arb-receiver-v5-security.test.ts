import { describe, expect, it, beforeEach } from "vitest";
import { Cl } from "@stacks/transactions";

/**
 * Security regression for bitflow-arb-receiver-v5, the hardened rewrite
 * of bitflow-arb-receiver / -v2/-v3/-v4 (all four found vulnerable under
 * F-10: no contract-caller check, repaid to a caller-supplied `core`
 * instead of a hardcoded one, and removed from flashstack-stx-core's
 * approved-receiver list). v5 ports the alex-arb-receiver-v5 hardening
 * pattern onto Bitflow's actual swap mechanics.
 *
 * Every guard below runs BEFORE execute-stx-flash reaches the Bitflow pool
 * call, so these pin the guard logic directly without needing Bitflow's
 * pool mirrored in simnet (it isn't -- only the swap *mechanics*, unchanged
 * from the already-live v3/v4, are out of scope here).
 *
 * Error codes: 500 NOT-OWNER · 501 SWAP-FAILED · 502 NO-PROFIT
 * 503 REPAY-FAILED · 504 TRANSFER-FAILED · 505 NOT-CORE · 506 NOT-PENDING
 * 507 MIN-STSTX-UNSET · 508 LOAN-TOO-SMALL · 509 FEE-TOO-HIGH · 510 ZERO-AMOUNT
 */

const CORE = "flashstack-stx-core";
const RX = "bitflow-arb-receiver-v5";

const RESERVE = 1_000_000_000; // 1,000 STX seeded
const LOAN = 100_000_000; //   100 STX borrowed

describe("bitflow-arb-receiver-v5 (F-10 hardened rewrite)", () => {
  let deployer: string;
  let wallet1: string;
  let wallet2: string;

  const seedAndApprove = () => {
    simnet.callPublicFn(CORE, "deposit-reserve", [Cl.uint(RESERVE)], deployer);
    simnet.callPublicFn(CORE, "add-approved-receiver", [Cl.contractPrincipal(deployer, RX)], deployer);
  };

  beforeEach(() => {
    deployer = simnet.getAccounts().get("deployer")!;
    wallet1 = simnet.getAccounts().get("wallet_1")!;
    wallet2 = simnet.getAccounts().get("wallet_2")!;
    seedAndApprove();
  });

  // --- The actual F-10 fix: caller gate -----------------------------------
  //
  // FLASH-CORE is hardcoded to the real mainnet address
  // (SP20XD46....flashstack-stx-core), and contract-caller is unforgeable --
  // no contract deployed under any other principal, including this
  // project's own local simnet copy of flashstack-stx-core (deployed under
  // the simnet `deployer` account, not the real mainnet address -- same
  // established pattern as flashstack-stx-core-reserve.test.ts), can ever
  // produce a matching contract-caller. That is the security property doing
  // its job, but it also means the "called via the real core" path for
  // min-ststx-out/loan-amount/fee-bp guards below it is structurally
  // untestable in local simnet, not just here -- alex-arb-receiver-v5 has
  // the identical pattern and no test file at all. What IS directly
  // testable, and is the actual F-10 fix, is that a direct call -- from
  // anyone, including this project's own local core -- is rejected.

  it("rejects execute-stx-flash called directly, not through the real core", () => {
    // `core` is passed as the real FLASH-CORE literal so this isolates the
    // contract-caller check specifically -- the second, defense-in-depth
    // assert on `core` itself would otherwise also reject this call for a
    // different reason, masking whether the first check is doing anything.
    const result = simnet.callPublicFn(
      RX,
      "execute-stx-flash",
      [Cl.uint(LOAN), Cl.contractPrincipal("SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5", "flashstack-stx-core")],
      wallet1,
    ).result;
    expect(result).toBeErr(Cl.uint(505)); // ERR-NOT-CORE
  });

  it("rejects execute-stx-flash even when called through this project's own local flashstack-stx-core copy", () => {
    // Proves the gate checks the REAL mainnet address, not ".flashstack-stx-core"
    // sugar or "whatever's locally registered under that name" -- the local
    // copy's own contract-caller still doesn't match the hardcoded literal.
    simnet.callPublicFn(RX, "set-min-ststx-out", [Cl.uint(1)], deployer);
    const result = simnet.callPublicFn(CORE, "flash-loan", [Cl.uint(LOAN), Cl.contractPrincipal(deployer, RX)], wallet1).result;
    expect(result).toBeErr(Cl.uint(505));
  });

  // --- Ownership / admin gating --------------------------------------------

  it("owner-only setters reject non-owner callers", () => {
    expect(simnet.callPublicFn(RX, "set-min-ststx-out", [Cl.uint(1)], wallet1).result).toBeErr(Cl.uint(500));
    expect(simnet.callPublicFn(RX, "set-min-profit", [Cl.uint(1)], wallet1).result).toBeErr(Cl.uint(500));
    expect(simnet.callPublicFn(RX, "set-max-fee-bp", [Cl.uint(1)], wallet1).result).toBeErr(Cl.uint(500));
    expect(simnet.callPublicFn(RX, "rescue-stx", [Cl.uint(1), Cl.principal(wallet1)], wallet1).result).toBeErr(Cl.uint(500));
    expect(simnet.callPublicFn(RX, "rescue-ststx", [Cl.uint(1), Cl.principal(wallet1)], wallet1).result).toBeErr(Cl.uint(500));
    expect(simnet.callPublicFn(RX, "propose-owner", [Cl.principal(wallet1)], wallet1).result).toBeErr(Cl.uint(500));
  });

  it("rescue functions reject a zero amount even from the real owner", () => {
    expect(simnet.callPublicFn(RX, "rescue-stx", [Cl.uint(0), Cl.principal(wallet1)], deployer).result).toBeErr(Cl.uint(510));
    expect(simnet.callPublicFn(RX, "rescue-ststx", [Cl.uint(0), Cl.principal(wallet1)], deployer).result).toBeErr(Cl.uint(510));
  });

  it("two-step ownership transfer: propose then accept, old owner loses access", () => {
    expect(simnet.callPublicFn(RX, "propose-owner", [Cl.principal(wallet1)], deployer).result).toBeOk(Cl.bool(true));
    // wrong account accepting fails
    expect(simnet.callPublicFn(RX, "accept-ownership", [], wallet2).result).toBeErr(Cl.uint(506));
    // the proposed owner accepts
    expect(simnet.callPublicFn(RX, "accept-ownership", [], wallet1).result).toBeOk(Cl.bool(true));
    // old owner can no longer call owner-gated functions
    expect(simnet.callPublicFn(RX, "set-min-profit", [Cl.uint(1)], deployer).result).toBeErr(Cl.uint(500));
    expect(simnet.callPublicFn(RX, "set-min-profit", [Cl.uint(1)], wallet1).result).toBeOk(Cl.bool(true));
  });

  it("get-settings reflects live state", () => {
    const settings = simnet.callReadOnlyFn(RX, "get-settings", [], deployer).result;
    // Clarity tuples serialize with keys in alphabetical order on-chain,
    // regardless of the contract source's declaration order -- match that
    // here or the comparison fails on key order, not value.
    expect(settings).toBeOk(
      Cl.tuple({
        "contract-owner": Cl.principal(deployer),
        "max-fee-bp": Cl.uint(10),
        "min-profit": Cl.uint(1),
        "min-ststx-out": Cl.uint(0),
        "pending-owner": Cl.none(),
      }),
    );
  });
});
