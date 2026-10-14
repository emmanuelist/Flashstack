import { describe, expect, it, beforeEach } from "vitest";
import { Cl } from "@stacks/transactions";

/**
 * Solvency invariant for flashstack-stx-core-v2 (route A successor, undeployed on
 * mainnet): a receiver that repays 1 uSTX short of principal + fee is rejected
 * with ERR-REPAY-FAILED, and the reserve is untouched, asserted by reading it
 * back rather than inferred from the abort.
 *
 * The control (stx-test-receiver-v2, exact repayment) runs through the same
 * harness, so the under-pay failure can't be a setup artifact.
 *
 * This is the simnet half of docs/TESTNET_STAGING.md §6's "non-repaying receiver
 * reverts, reserve untouched". The testnet half publishes the same receiver.
 */

const CORE = "flashstack-stx-core-v2";
const GOOD = "stx-test-receiver-v2";
const UNDERPAY = "stx-underpay-receiver-v2";

const RESERVE = 1_000_000_000; // 1,000 STX seeded
const LOAN = 100_000_000; //   100 STX borrowed
const FEE = 50_000; //   0.05% of 100 STX
const BUFFER = 1_000_000; //   1 STX, covers the fee so the repay transfer itself succeeds

describe("flashstack-stx-core-v2: under-paying receiver", () => {
  let deployer: string;

  const reserveBalance = () =>
    Number(simnet.callReadOnlyFn(CORE, "get-reserve-balance", [], deployer).result.value);
  const stxOf = (contract: string) =>
    Number(simnet.getAssetsMap().get("STX")?.get(`${deployer}.${contract}`) ?? 0);

  const seedApproveAndFund = (receiver: string) => {
    simnet.callPublicFn(CORE, "deposit-reserve", [Cl.uint(RESERVE)], deployer);
    simnet.callPublicFn(CORE, "add-approved-receiver", [Cl.contractPrincipal(deployer, receiver)], deployer);
    simnet.transferSTX(BUFFER, `${deployer}.${receiver}`, deployer);
  };

  beforeEach(() => {
    deployer = simnet.getAccounts().get("deployer")!;
  });

  it("control: exact repayment succeeds and the reserve grows by exactly the fee", () => {
    seedApproveAndFund(GOOD);
    const before = reserveBalance();

    const { result } = simnet.callPublicFn(CORE, "flash-loan", [Cl.uint(LOAN), Cl.contractPrincipal(deployer, GOOD)], deployer);

    expect(result).toBeOk(Cl.bool(true));
    expect(reserveBalance()).toBe(before + FEE);
  });

  it("repaying 1 uSTX short reverts with ERR-REPAY-FAILED and leaves the reserve untouched", () => {
    seedApproveAndFund(UNDERPAY);
    const before = reserveBalance();
    const receiverBefore = stxOf(UNDERPAY);

    const { result } = simnet.callPublicFn(CORE, "flash-loan", [Cl.uint(LOAN), Cl.contractPrincipal(deployer, UNDERPAY)], deployer);

    expect(result).toBeErr(Cl.uint(302)); // the core's own reserve check, not the receiver's u500
    expect(reserveBalance()).toBe(before);
    expect(stxOf(UNDERPAY)).toBe(receiverBefore); // buffer intact: the repay transfer rolled back too
    const stats = simnet.callReadOnlyFn(CORE, "get-stats", [], deployer).result as any;
    expect(Number(stats.value.value["total-loans"].value)).toBe(0);
  });
});
