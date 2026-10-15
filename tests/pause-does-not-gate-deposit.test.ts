import { describe, expect, it, beforeEach } from "vitest";
import { Cl } from "@stacks/transactions";

/**
 * Pins what `set-paused true` ACTUALLY does on the four deployed LP pools
 * (Flashstack-ajv.4.5, FINDINGS_REGISTER F-8 for the live side):
 *
 *   SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-stx-pool     (v1, deprecated)
 *   SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-sbtc-pool    (v1, deprecated)
 *   SPR9PQANV6XHSDNRAX2GNKCA5Z1KH61961KE0BYG.flashstack-stx-pool-v2  (live, paused 2026-10-01)
 *   SPR9PQANV6XHSDNRAX2GNKCA5Z1KH61961KE0BYG.flashstack-sbtc-pool-v2 (live, paused 2026-10-01)
 *
 * Deployed source read 2026-10-14 via Hiro GET /v2/contracts/source: in all four,
 * `paused` is read only inside `flash-loan`. `deposit` asserts only `amount > 0`
 * and `withdraw` does not read it. Simnet runs the contracts/test/ localized
 * copies; tests/canonical-copy-drift.test.ts ties those to the canonical files.
 *
 * So "paused" means "no new loans". It does NOT mean "closed":
 *   - deposit still succeeds and mints shares;
 *   - withdraw still succeeds (correct: LPs can always exit);
 *   - flash-loan is refused with ERR-PAUSED, even for an approved receiver.
 *
 * On the v1 pools a deposit while paused also gets the pre-F-1 share math
 * (first depositor = amount * SHARE-PRECISION, no virtual shares/assets).
 *
 * Contrast: the undeployed v3 successors DO gate deposit on pause. That is
 * pinned in tests/v3-pools-pause-gate.test.ts and not repeated here.
 */

const POOLS = [
  { name: "flashstack-stx-pool", asset: "stx", errPaused: 405, receiver: "test-pool-receiver-good", v1Precision: 1_000_000 },
  { name: "flashstack-sbtc-pool", asset: "sbtc", errPaused: 705, receiver: "test-sbtc-pool-receiver-good", v1Precision: 100_000_000 },
  { name: "flashstack-stx-pool-v2", asset: "stx", errPaused: 405, receiver: "test-pool-receiver-good", v1Precision: null },
  { name: "flashstack-sbtc-pool-v2", asset: "sbtc", errPaused: 705, receiver: "test-sbtc-pool-receiver-good", v1Precision: null },
] as const;

const AMOUNT = 1_000_000;

describe("ajv.4.5: pause on the deployed v1/v2 pools stops loans, not deposits or withdrawals", () => {
  let deployer: string;
  let lp: string;

  beforeEach(() => {
    deployer = simnet.getAccounts().get("deployer")!;
    lp = simnet.getAccounts().get("wallet_1")!;
  });

  const fund = (asset: string, who: string) => {
    if (asset === "sbtc") simnet.callPublicFn("sbtc-token", "mint", [Cl.uint(AMOUNT * 10), Cl.principal(who)], deployer);
  };
  const shares = (pool: string, who: string) =>
    Number((simnet.callReadOnlyFn(pool, "get-shares", [Cl.principal(who)], deployer).result as any).value);
  const pause = (pool: string) =>
    expect(simnet.callPublicFn(pool, "set-paused", [Cl.bool(true)], deployer).result).toBeOk(Cl.bool(true));

  for (const { name, asset, errPaused, receiver, v1Precision } of POOLS) {
    describe(name, () => {
      it("deposit SUCCEEDS while paused and mints shares", () => {
        pause(name);
        fund(asset, lp);
        const r = simnet.callPublicFn(name, "deposit", [Cl.uint(AMOUNT)], lp);
        expect(r.result.type).toBe("ok");
        expect(shares(name, lp)).toBeGreaterThan(0);
      });

      if (v1Precision !== null) {
        it("v1: a first deposit while paused gets the naive pre-F-1 share math", () => {
          pause(name);
          fund(asset, lp);
          expect(simnet.callPublicFn(name, "deposit", [Cl.uint(AMOUNT)], lp).result)
            .toBeOk(Cl.uint(AMOUNT * v1Precision));
        });
      }

      it("withdraw SUCCEEDS while paused (LPs can always exit)", () => {
        fund(asset, lp);
        expect(simnet.callPublicFn(name, "deposit", [Cl.uint(AMOUNT)], lp).result.type).toBe("ok");
        pause(name);
        const s = shares(name, lp);
        expect(simnet.callPublicFn(name, "withdraw", [Cl.uint(s)], lp).result.type).toBe("ok");
        expect(shares(name, lp)).toBe(0);
      });

      it("flash-loan is REFUSED while paused with ERR-PAUSED, even for an approved receiver", () => {
        fund(asset, lp);
        simnet.callPublicFn(name, "deposit", [Cl.uint(AMOUNT)], lp);
        simnet.callPublicFn(name, "add-approved-receiver", [Cl.principal(`${deployer}.${receiver}`)], deployer);
        pause(name);
        expect(simnet.callPublicFn(name, "flash-loan",
          [Cl.uint(AMOUNT / 10), Cl.principal(`${deployer}.${receiver}`)], lp).result).toBeErr(Cl.uint(errPaused));
      });
    });
  }
});
