#!/usr/bin/env node
// Wraps `npm audit --json` and fails only on a finding at or above
// --audit-level whose advisory ID is NOT in ALLOWLIST. A red run then means
// something NEW, not "the same accepted finding, forever" -- see
// docs/security/FINDINGS_REGISTER.md for the human-readable record of why
// each ID below is accepted. Matched on advisory ID, never a package name:
// a different advisory on an already-allowlisted package still fails.
//
// Every ID here must also appear in FINDINGS_REGISTER.md, checked below, not
// assumed -- an allowlisted finding has to be a documented, accepted-risk
// row, the same discipline KNOWN_TEST_PATHS already applies in
// tests/mainnet-plan-guard.test.ts. Removing an ID here without removing its
// register entry (or vice versa) fails the run until they're reconciled.
//
// Usage: run from the directory whose package.json is being audited (same
// convention as `npm audit` itself) -- matches the two call sites in
// .github/workflows/security.yml:
//   node scripts/audit-allowlist.mjs                      (from root)
//   node ../scripts/audit-allowlist.mjs                   (from web/)
// Optional: --audit-level=<critical|high|moderate|low>, default "high".

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");
const FINDINGS_REGISTER = join(REPO_ROOT, "docs/security/FINDINGS_REGISTER.md");

// DEP-1 (braces, docs/security/FINDINGS_REGISTER.md): no upstream fix exists
// -- braces' latest-ever release is still inside the vulnerable range. This
// is the only ID that currently matters at --audit-level=high: elliptic
// (DEP-2 sub-issue 2) is `low` severity, so it never reaches this threshold
// on its own -- verified directly against both package.json trees on
// 2026-10-07, not assumed. Listed anyway so a future lower --audit-level
// doesn't silently start failing on an already-accepted finding.
const ALLOWLIST = ["GHSA-vfj7-8cjw-p6xm", "GHSA-848j-6mx2-7j84"];

const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const auditLevel = (process.argv.find((a) => a.startsWith("--audit-level=")) ?? "--audit-level=high").split("=")[1];
const threshold = SEVERITY_RANK[auditLevel];
if (threshold === undefined) {
  console.error(`Unknown --audit-level value: ${auditLevel}`);
  process.exit(2);
}

function assertDocumented(id) {
  const register = readFileSync(FINDINGS_REGISTER, "utf-8");
  if (!register.includes(id)) {
    throw new Error(
      `${id} is in ALLOWLIST (scripts/audit-allowlist.mjs) but does not appear in ` +
        `docs/security/FINDINGS_REGISTER.md. An allowlisted finding must be a documented, ` +
        `accepted-risk row -- add one, or remove this ID if it's no longer accepted.`,
    );
  }
}
ALLOWLIST.forEach(assertDocumented);

let report;
try {
  report = JSON.parse(execFileSync("npm", ["audit", "--json"], { encoding: "utf-8" }));
} catch (err) {
  // `npm audit` exits non-zero as soon as it finds anything at its own
  // (lower) default threshold; the JSON report is still on stdout either way.
  if (!err.stdout) throw err;
  report = JSON.parse(err.stdout);
}

// Fail CLOSED, not open: npm audit itself can fail for reasons that have
// nothing to do with vulnerabilities (registry unreachable, rate limited,
// auth error) and still print valid JSON -- just without a `vulnerabilities`
// key. Treating that as "nothing found" would report a green audit on an
// audit that never actually ran. Found by Hillary Kibet's review on #94,
// reproduced with npm_config_registry pointed at an unreachable host.
if (report.error || !report.vulnerabilities) {
  console.error(`npm audit did not return results: ${report.message ?? JSON.stringify(report.error)}`);
  process.exit(2);
}

// npm reports every package in a vulnerable chain as its own top-level
// entry. Only the actual advisory-bearing package carries a real GHSA
// `via` object with a `url`; the chain-link packages above it (e.g.
// chokidar, @clarigen/cli depending on braces) list that package's NAME as
// a plain string in their own `via` instead. Packages with no extractable
// ID here are always a restatement of an ID found on another entry in the
// same report -- the real check happens there, so these are skipped rather
// than treated as separately "clear".
const unallowed = [];
for (const [pkg, vuln] of Object.entries(report.vulnerabilities ?? {})) {
  if ((SEVERITY_RANK[vuln.severity] ?? 0) < threshold) continue;
  const ids = (vuln.via ?? [])
    .filter((v) => typeof v === "object" && v.url)
    .map((v) => v.url.split("/").pop());
  const newIds = ids.filter((id) => !ALLOWLIST.includes(id));
  if (newIds.length > 0) unallowed.push({ pkg, severity: vuln.severity, ids: newIds });
}

if (unallowed.length > 0) {
  console.error(`${unallowed.length} finding(s) at or above "${auditLevel}" are not on the allowlist:\n`);
  for (const { pkg, severity, ids } of unallowed) {
    console.error(`  ${pkg} (${severity}): ${ids.join(", ")}`);
  }
  console.error(
    `\nIf this is a genuinely new finding, fix it or triage it like DEP-1/DEP-2 in FINDINGS_REGISTER.md.\n` +
      `If it's a new instance of an already-accepted advisory, add its ID to ALLOWLIST in this script.`,
  );
  process.exit(1);
}

console.log(`npm audit: every finding at or above "${auditLevel}" is on the allowlist (or there are none).`);
