import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every .clar under contracts/ is either registered in Clarinet.toml (so
 * `clarinet check` and the simnet suite compile it) or listed below with the
 * reason it isn't (Flashstack-ajv.2.3).
 *
 * Without this, a contract can be added, or a script can deploy one, that
 * nothing in CI ever compiles. That is how the gap in ajv.2.3 arose: on
 * 2026-09-15, 32 of 70 files were outside the registry, including the
 * canonical sources of audit targets.
 *
 * Fixing a failure here does NOT mean registering the file. Registering a
 * top-level contracts/ file adds it to what `clarinet deployments apply
 * --mainnet` would publish (tests/mainnet-plan-guard.test.ts, ajv.6.6). Add
 * the file to UNREGISTERED with a one-line reason instead, unless it really
 * belongs in the simnet project.
 */

type Coverage =
  // A same-named localized copy under contracts/test/ is registered and
  // compiled, and tests/canonical-copy-drift.test.ts holds the canonical file
  // to it (address localization only).
  | "drift-checked copy"
  // Byte-identical to an immutable deployed contract; the sha256 is pinned in
  // tests/deployed-source-pins.test.ts.
  | "deployed-source pin"
  // Nothing in CI compiles or pins this file.
  | "none";

const UNREGISTERED: Record<string, { coverage: Coverage; why: string }> = {
  // Canonical sources whose localized copy is what Clarinet.toml registers.
  "contracts/flashstack-pool-oracle.clar": { coverage: "drift-checked copy", why: "live deprecated oracle, reads the v1 STX pool" },
  "contracts/flashstack-pool-oracle-v2.clar": { coverage: "drift-checked copy", why: "live oracle-v2, audit target" },
  "contracts/flashstack-pool-v3.clar": { coverage: "drift-checked copy", why: "undeployed multi-asset pool, audit target" },
  "contracts/pool-v3-test-receiver.clar": { coverage: "drift-checked copy", why: "testnet-only pool-v3 receiver (#112), never on the mainnet plan" },
  "contracts/flashstack-sbtc-core.clar": { coverage: "drift-checked copy", why: "live sBTC core" },
  "contracts/flashstack-sbtc-core-v2.clar": { coverage: "drift-checked copy", why: "undeployed sBTC core successor, audit target" },
  "contracts/flashstack-sbtc-pool.clar": { coverage: "drift-checked copy", why: "live deprecated v1 sBTC pool" },
  "contracts/flashstack-sbtc-pool-v2.clar": { coverage: "drift-checked copy", why: "live paused v2 sBTC pool (F-9)" },
  "contracts/flashstack-sbtc-pool-v3.clar": { coverage: "drift-checked copy", why: "undeployed sBTC pool successor, audit target" },
  "contracts/flashstack-stx-core.clar": { coverage: "drift-checked copy", why: "live STX core" },
  "contracts/flashstack-stx-core-v2.clar": { coverage: "drift-checked copy", why: "STX core successor (testnet only), audit target" },
  "contracts/flashstack-stx-pool.clar": { coverage: "drift-checked copy", why: "live deprecated v1 STX pool" },
  "contracts/flashstack-stx-pool-v2.clar": { coverage: "drift-checked copy", why: "live paused v2 STX pool (F-9)" },
  "contracts/flashstack-stx-pool-v3.clar": { coverage: "drift-checked copy", why: "undeployed STX pool successor, audit target" },
  "contracts/flashstack-v3-receiver-trait.clar": { coverage: "drift-checked copy", why: "pool-v3 receiver trait" },

  // Gen-1 receivers kept verbatim for the record (CONTRACT_INVENTORY D7).
  "contracts/snp-flashstack-receiver.clar": { coverage: "deployed-source pin", why: "live gen-1 receiver, immutable, out of audit scope" },
  "contracts/snp-flashstack-receiver-v3.clar": { coverage: "deployed-source pin", why: "live gen-1 receiver, immutable, out of audit scope" },

  // Uncovered. Neither is deployed (only aborted publishes, CONTRACT_INVENTORY
  // "deployment scars"), so a broken file here can't affect anything live, but
  // a script could publish it without CI ever having compiled it.
  "contracts/arkadiko-liquidation-receiver.clar": { coverage: "none", why: "script-deployed receiver, not deployed; Arkadiko deps are mainnet-only" },
  "contracts/usda-vault-rescue-receiver.clar": { coverage: "none", why: "script-deployed receiver, not deployed; Arkadiko deps are mainnet-only" },
};

function clarFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return clarFiles(p);
    return e.name.endsWith(".clar") ? [p] : [];
  });
}

const REGISTERED = new Set(
  [...readFileSync("Clarinet.toml", "utf-8").matchAll(/^path\s*=\s*"([^"]+)"/gm)].map((m) => m[1]),
);
const ALL = clarFiles("contracts").sort();
const unregistered = ALL.filter((f) => !REGISTERED.has(f));

describe("contract registry: every contracts/ .clar is compiled or explained", () => {
  it("no .clar file is outside Clarinet.toml without an UNREGISTERED entry", () => {
    const missing = unregistered.filter((f) => !(f in UNREGISTERED));
    expect(
      missing,
      `Not registered in Clarinet.toml and not in UNREGISTERED: ${missing.join(", ")}. ` +
        `Add each to UNREGISTERED with its coverage and a reason (don't register a top-level ` +
        `contracts/ file without checking tests/mainnet-plan-guard.test.ts first).`,
    ).toEqual([]);
  });

  it("every UNREGISTERED entry still exists and is still unregistered", () => {
    const stale = Object.keys(UNREGISTERED).filter((f) => !existsSync(f) || REGISTERED.has(f));
    expect(stale, `Remove these from UNREGISTERED: ${stale.join(", ")}`).toEqual([]);
  });

  it("every 'drift-checked copy' entry has a registered contracts/test/ copy", () => {
    const bad = Object.entries(UNREGISTERED)
      .filter(([, v]) => v.coverage === "drift-checked copy")
      .map(([f]) => f.replace(/^contracts\//, "contracts/test/"))
      .filter((copy) => !REGISTERED.has(copy));
    expect(bad, `No registered localized copy for: ${bad.join(", ")}`).toEqual([]);
  });

  it("every 'deployed-source pin' entry is pinned in deployed-source-pins.test.ts", () => {
    const pins = readFileSync(join("tests", "deployed-source-pins.test.ts"), "utf-8");
    const bad = Object.entries(UNREGISTERED)
      .filter(([, v]) => v.coverage === "deployed-source pin")
      .map(([f]) => f)
      .filter((f) => !pins.includes(`"${f}"`));
    expect(bad, `Not pinned: ${bad.join(", ")}`).toEqual([]);
  });
});
