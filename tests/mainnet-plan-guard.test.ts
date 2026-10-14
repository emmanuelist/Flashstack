import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What `clarinet deployments apply --mainnet` would publish from this repo.
 *
 * On any machine with a `settings/Mainnet.toml`, `apply --mainnet` publishes the
 * plan clarinet computes from Clarinet.toml: after two Enters by default, or with
 * no prompt at all under `-d`. Verified 2026-09-27 against clarinet 3.23.2 in a
 * network-isolated container with a throwaway key and a mock node (see the #75
 * review). Clarinet.toml registers the funds-bearing contracts under their real
 * names but pointed at their `contracts/test/` localized copies, so that plan
 * publishes those copies, whose sBTC calls resolve to the in-plan mock
 * `contracts/sbtc-token.clar`, plus test fixtures such as `malicious-token`.
 *
 * The target is that no `contracts/test/` path is in the mainnet plan. That needs
 * D6's structural fix (docs/security/CONTRACT_INVENTORY.md §7.3), so it cannot
 * pass yet and is recorded below with `it.fails`. Until then, the known set is
 * pinned so it cannot silently grow: registering one more `contracts/test/` file
 * in Clarinet.toml puts it in what a mainnet deploy run publishes, and must fail
 * here. When D6 lands, both tests will fail: empty KNOWN_TEST_PATHS and turn the
 * `it.fails` into `it`.
 *
 * Nothing is signed or sent. `deployments generate` only writes a plan file, in a
 * temp copy of the project. The dummy Mainnet.toml uses the public Clarinet
 * devnet deployer mnemonic already committed in settings/Devnet.toml, points at
 * an RPC address nothing listens on, and `--manual-cost` skips fee estimation.
 * Requirements resolve from the vendored `.cache`, so no network is needed
 * (verified in a `--network none` container).
 *
 * Needs the same clarinet version as CI (read from .github/workflows/test.yml).
 * Required in CI; skipped locally if missing or mismatched. Set CLARINET_BIN to
 * point at a matching binary.
 */
const KNOWN_TEST_PATHS = [
  "contracts/test/flashstack-pool-oracle-v2.clar",
  "contracts/test/flashstack-pool-oracle.clar",
  "contracts/test/flashstack-pool-v3.clar",
  "contracts/test/flashstack-sbtc-core-v2.clar",
  "contracts/test/flashstack-sbtc-core.clar",
  "contracts/test/flashstack-sbtc-pool-v2.clar",
  "contracts/test/flashstack-sbtc-pool-v3.clar",
  "contracts/test/flashstack-sbtc-pool.clar",
  "contracts/test/flashstack-stx-core-v2.clar",
  "contracts/test/flashstack-stx-core.clar",
  "contracts/test/flashstack-stx-pool-v2.clar",
  "contracts/test/flashstack-stx-pool-v3.clar",
  "contracts/test/flashstack-stx-pool.clar",
  "contracts/test/flashstack-v3-receiver-trait.clar",
  "contracts/test/malicious-token.clar",
  "contracts/test/mock-usdcx.clar",
  "contracts/test/pool-v3-test-receiver.clar",
  "contracts/test/sip-010-trait-ft-standard.clar",
  "contracts/test/test-pool-receiver-good.clar",
  "contracts/test/test-pool-v2-receiver-deposit-reentrant.clar",
  "contracts/test/test-pool-v3-receiver-bad.clar",
  "contracts/test/test-pool-v3-receiver-good.clar",
  "contracts/test/test-pool-v3-receiver-reentrant.clar",
  "contracts/test/test-receiver-bad.clar",
  "contracts/test/test-receiver-good.clar",
  "contracts/test/test-sbtc-pool-receiver-good.clar",
  "contracts/test/test-sbtc-pool-v2-receiver-deposit-reentrant.clar",
  "contracts/test/test-sbtc-pool-v3-receiver-reentrant.clar",
  "contracts/test/test-sbtc-receiver-bad.clar",
  "contracts/test/test-sbtc-receiver-good.clar",
  "contracts/test/test-stx-pool-v3-receiver-reentrant.clar",
];

const CLARINET = process.env.CLARINET_BIN || "clarinet";
const CI_VERSION = readFileSync(".github/workflows/test.yml", "utf-8").match(
  /clarinet\/releases\/download\/v(\d+\.\d+\.\d+)\//,
)?.[1];
const probe = spawnSync(CLARINET, ["--version"], { encoding: "utf-8" });
const localVersion = probe.stdout?.match(/clarinet (\d+\.\d+\.\d+)/)?.[1];
const usable = CI_VERSION !== undefined && localVersion === CI_VERSION;

if (process.env.CI && !usable) {
  throw new Error(
    `mainnet-plan-guard needs clarinet ${CI_VERSION} in CI, found ${localVersion ?? "none"} (${CLARINET})`,
  );
}

type Publish = { name: string; path: string };

// Line-based on purpose: clarinet writes one `key: value` per line, and this
// avoids depending on a YAML parser that is only a transitive dependency.
function publishesOf(planYaml: string): Publish[] {
  const out: Publish[] = [];
  let cur: Partial<Publish> & { type?: string } = {};
  const flush = () => {
    if (cur.type === "contract-publish" && cur.name && cur.path) {
      out.push({ name: cur.name, path: cur.path });
    }
  };
  for (const line of planYaml.split("\n")) {
    const tx = line.match(/^\s*- transaction-type: (\S+)/);
    if (tx) {
      flush();
      cur = { type: tx[1] };
      continue;
    }
    const kv = line.match(/^\s*(contract-name|path): (\S+)/);
    if (kv) cur[kv[1] === "contract-name" ? "name" : "path"] = kv[2];
  }
  flush();
  return out;
}

describe.skipIf(!usable)("clarinet's computed mainnet plan (apply --mainnet)", () => {
  let dir: string;
  let publishes: Publish[];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mainnet-plan-guard-"));
    for (const p of ["Clarinet.toml", "contracts", ".cache"]) {
      cpSync(p, join(dir, p), { recursive: true });
    }
    mkdirSync(join(dir, "settings"));
    cpSync("settings/Devnet.toml", join(dir, "settings/Devnet.toml"));
    const devnet = readFileSync("settings/Devnet.toml", "utf-8");
    const mnemonic = devnet.match(/\[accounts\.deployer\]\s*\nmnemonic = "([^"]+)"/)?.[1];
    if (!mnemonic) throw new Error("public devnet deployer mnemonic not found in settings/Devnet.toml");
    writeFileSync(
      join(dir, "settings/Mainnet.toml"),
      `[network]\nname = "mainnet"\nstacks_node_rpc_address = "http://127.0.0.1:1"\n\n` +
        `[accounts.deployer]\nmnemonic = "${mnemonic}"\n`,
    );

    const gen = spawnSync(CLARINET, ["deployments", "generate", "--mainnet", "--manual-cost"], {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
    });
    if (gen.status !== 0) {
      throw new Error(`clarinet deployments generate --mainnet failed:\n${gen.stdout}\n${gen.stderr}`);
    }
    publishes = publishesOf(readFileSync(join(dir, "deployments/default.mainnet-plan.yaml"), "utf-8"));
  }, 300_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const testPaths = () =>
    publishes
      .map((p) => p.path)
      .filter((p) => p.startsWith("contracts/test/"))
      .sort();

  it("parses a real plan (guards against a vacuous pass)", () => {
    const paths = publishes.map((p) => p.path);
    expect(paths).toContain("contracts/flashstack-core.clar");
    expect(paths.length).toBeGreaterThan(KNOWN_TEST_PATHS.length);
  });

  it("publishes no contracts/test/ file beyond the known set", () => {
    expect(
      testPaths(),
      "the contracts/test/ files `apply --mainnet` would publish changed. An added entry is a test build headed " +
        "for mainnet; update KNOWN_TEST_PATHS only for a reviewed removal",
    ).toEqual(KNOWN_TEST_PATHS);
  });

  it.fails("TARGET (needs D6): publishes no contracts/test/ file at all", () => {
    expect(testPaths()).toEqual([]);
  });
});
