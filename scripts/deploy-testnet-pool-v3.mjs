/**
 * FlashStack — Testnet Deployment + Flash Loan Evidence (pool-v3, the generic
 * multi-asset line)
 *
 * Follow-up to scripts/deploy-testnet.mjs, which deliberately did NOT cover
 * this line (see its own header: "pool-v3 / sbtc-core-v2 ... a materially
 * bigger deploy: multiple assets, add-asset calibration, its own receiver.
 * Both are natural follow-ups once this simpler line is proven, not folded
 * in blind here.") and docs/TESTNET_STAGING.md section 4/8, which listed
 * flashstack-pool-v3 as "not covered by this plan". This is that follow-up.
 *
 * All three real blockers that used to stand in the way (testnet epoch 4.0
 * support, a byte-identical sBTC testnet equivalent, the address patcher)
 * were resolved 2026-09-17 -- see docs/TESTNET_STAGING.md section 5. What
 * was missing was this script and a receiver (pool-v3-test-receiver.clar),
 * not any further unknown.
 *
 * Deploys in order:
 *   1. flashstack-v3-receiver-trait — generic receiver interface (fresh;
 *      not yet deployed anywhere, mainnet or testnet)
 *   2. flashstack-pool-v3           — the generic multi-asset core
 *   3. pool-v3-test-receiver        — minimal happy-path receiver, computes
 *                                     its own repayment from the pool's
 *                                     live fee-bp rather than assuming it
 *   Then: list sBTC as an asset -> whitelist the receiver -> deposit a
 *   small sBTC reserve (also mints the deployer LP shares -- pool-v3 has no
 *   separate admin-only reserve function, deposit IS how reserve gets
 *   funded) -> seed the receiver's fee buffer -> execute a real flash loan.
 *
 * The listed asset is the testnet sBTC equivalent
 * (ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.sbtc-token, verified
 * byte-identical to mainnet's SM3VDXK3…, docs/TESTNET_STAGING.md section
 * 5.2) -- NOT a mock, so pool-v3's real get-decimals()/get-balance() calls
 * and share-scale calibration (pv3-F2) run against the genuine dependency.
 *
 * This does NOT also deploy flashstack-sbtc-core-v2 or
 * flashstack-stx-pool-v3. Both are separate contracts with their own
 * receivers (flashstack-stx-pool-v3 needs one targeting it specifically,
 * same static-contract-call? constraint documented in
 * stx-test-receiver-v2.clar) — natural follow-ups once this line is
 * proven, not folded in here.
 *
 * Setup:
 *   1. Same testnet wallet as deploy-testnet.mjs (docs/TESTNET_STAGING.md
 *      section 3). Reusing the SAME deployer as the stx-core-v2 line is
 *      fine and arguably preferable -- one funded testnet identity, not two
 *      to track.
 *   2. Fund it with testnet STX: https://explorer.hiro.so/sandbox/faucet?chain=testnet
 *   3. Fund it with testnet sBTC. The deployer's own key does not hold any
 *      and cannot mint it -- it has to come via a SIP-010 transfer from
 *      ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM, the same byte-identical
 *      sBTC deployment, which holds a real balance (confirmed live,
 *      docs/TESTNET_STAGING.md action 5). That address's key is the
 *      well-known PUBLIC Clarinet default -- this script deliberately does
 *      NOT embed it or sign as it; obtaining the transfer is a manual,
 *      operator-performed step, same boundary deploy-testnet.mjs's own
 *      proveBC1 draws around "OTHER", a principal the signing key does not
 *      control. This script only checks the resulting balance and tells you
 *      plainly if it's not enough yet.
 *   4. Run:
 *      TESTNET_MNEMONIC="word1 ... word24" node scripts/deploy-testnet-pool-v3.mjs
 */

import {
  makeContractDeploy,
  makeContractCall,
  PostConditionMode,
  ClarityVersion,
  Cl,
  getAddressFromPrivateKey,
} from "@stacks/transactions";
import networkPkg from "@stacks/network";
const { STACKS_TESTNET } = networkPkg;
import walletPkg from "@stacks/wallet-sdk";
const { generateWallet } = walletPkg;
import { readFileSync } from "fs";
import { localize, assertFullyLocalized } from "./lib/testnet-localize.mjs";
import { callReadOnly as callReadOnlyRaw, assertEqual } from "./lib/testnet-readonly.mjs";

const callReadOnly = (sender, contractAddress, contractName, fn, args = []) =>
  callReadOnlyRaw(API, sender, contractAddress, contractName, fn, args);

// ── Config ────────────────────────────────────────────────────────────────────

const MNEMONIC  = process.env.TESTNET_MNEMONIC;
const API       = "https://api.testnet.hiro.so";
const EXPLORER  = "https://explorer.hiro.so/txid";
const network   = STACKS_TESTNET;

// Verified byte-identical to mainnet's canonical sBTC (SM3VDXK3…), see
// scripts/lib/testnet-localize.mjs's TESTNET_EQUIVALENT table and
// docs/TESTNET_STAGING.md section 5.2.
const SBTC_TESTNET_ADDRESS = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";
const SBTC_TESTNET_NAME    = "sbtc-token";

// Asset listing: 0.05% fee, matching the single-asset cores' convention
// (flashstack-stx-core-v2/flashstack-sbtc-core-v2), well under MAX-FEE-BP
// (u100 = 1%). 100,000 sats (0.001 sBTC) max-loan is a conservative testnet
// cap -- there is no reason to list a larger ceiling than this run needs.
const FEE_BP    = 5;
const MAX_LOAN  = 100_000;

// Deposit funds BOTH the pool's reserve and the deployer's own LP shares in
// one call -- pool-v3 has no separate admin-only "fund the reserve" function
// the way the single-asset cores do. 10,000 sats covers the loan below with
// headroom; kept small because testnet sBTC is a genuinely scarce resource
// here (obtained by manual transfer, not a faucet).
const DEPOSIT_AMOUNT = 10_000;

// stx-test-receiver-v2's problem, same fix: a freshly deployed receiver
// holds 0 of the asset and cannot cover the fee on its own, so the flash
// loan would revert with ERR-REPAY (u902, this receiver's own error, not
// the pool's u810) before the pool's invariant is even reached. 100 sats
// comfortably covers the 1-sat fee on the loan below.
const RECEIVER_SEED_AMOUNT = 100;

// Small loan: raw-fee = (2000 * 5) / 10000 = 1 (exactly), so fee = 1 sat
// (pool-v3.clar:358's floor applies to a raw-fee of 0, not reached here).
const LOAN_AMOUNT = 2_000;

if (!MNEMONIC) {
  console.error("ERROR: Set TESTNET_MNEMONIC");
  console.error("");
  console.error('  TESTNET_MNEMONIC="word1 ... word24" node scripts/deploy-testnet-pool-v3.mjs');
  console.error("");
  console.error("  Fund your testnet address first:");
  console.error("  https://explorer.hiro.so/sandbox/faucet?chain=testnet");
  process.exit(1);
}

// ── Helpers (same implementation as deploy-testnet.mjs -- not imported, that
// script has none to import; see its own header for why this project
// duplicates rather than shares these across deploy scripts) ────────────────

async function getPrivateKey() {
  const wallet = await generateWallet({ secretKey: MNEMONIC, password: "" });
  return wallet.accounts[0].stxPrivateKey;
}

function deriveTestnetAddress(privateKey) {
  return getAddressFromPrivateKey(privateKey, STACKS_TESTNET);
}

function patchSource(source, deployerAddress, label = "contract") {
  const patched = localize(source, deployerAddress);
  assertFullyLocalized(patched, label);
  return patched;
}

async function getNonce(deployer) {
  const res  = await fetch(`${API}/v2/accounts/${deployer}?proof=0`);
  const data = await res.json();
  if (!data.nonce && data.nonce !== 0) {
    throw new Error(`Could not fetch nonce for ${deployer}. Is the address funded?\n  Fund at: https://explorer.hiro.so/sandbox/faucet?chain=testnet`);
  }
  return data.nonce;
}

async function getStxBalance(deployer) {
  const res  = await fetch(`${API}/v2/accounts/${deployer}?proof=0`);
  const data = await res.json();
  return BigInt(data.balance ?? "0x0");
}

async function getSbtcBalance(deployer) {
  const res  = await fetch(`${API}/extended/v1/address/${deployer}/balances`);
  const data = await res.json();
  const key  = `${SBTC_TESTNET_ADDRESS}.${SBTC_TESTNET_NAME}::sbtc-token`;
  return BigInt(data.fungible_tokens?.[key]?.balance ?? "0");
}

async function waitForConfirm(txid, label) {
  process.stdout.write(`  Waiting for "${label}"`);
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 8000));
    const res  = await fetch(`${API}/extended/v1/tx/0x${txid}`);
    const data = await res.json();
    if (data.tx_status === "success") {
      console.log(" confirmed.");
      return data;
    }
    if (data.tx_status?.startsWith("abort")) {
      const reason = data.tx_result?.repr ?? "unknown";
      console.log(`\n  FAILED: ${reason}`);
      console.log(`  Tx: ${EXPLORER}/${txid}?chain=testnet`);
      throw new Error(`"${label}" failed: ${reason}`);
    }
    process.stdout.write(".");
  }
  throw new Error(`Timeout waiting for "${label}"`);
}

async function broadcast(tx) {
  const raw   = tx.serialize();
  const bytes = typeof raw === "string" ? Buffer.from(raw.replace(/^0x/, ""), "hex") : raw;
  const res  = await fetch(`${API}/v2/transactions`, {
    method:  "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body:    bytes,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Node response not JSON: ${text.slice(0, 200)}`); }
  if (typeof data === "object" && data.error) {
    throw new Error(`${data.error} — ${data.reason ?? ""} ${data.reason_data ? JSON.stringify(data.reason_data) : ""}`);
  }
  const txid = typeof data === "string" ? data : data.txid;
  if (!txid) throw new Error(`Unexpected response: ${text.slice(0, 200)}`);
  return txid;
}

async function deployContract(privateKey, nonce, name, sourcePath, deployer) {
  const raw    = readFileSync(sourcePath, "utf8");
  const source = patchSource(raw, deployer, name);
  const tx = await makeContractDeploy({
    contractName:      name,
    codeBody:          source,
    senderKey:         privateKey,
    network,
    clarityVersion:    ClarityVersion.Clarity3,
    postConditionMode: PostConditionMode.Allow,
    anchorMode:        1,
    fee:               500_000,
    nonce,
  });
  const txid = await broadcast(tx);
  console.log(`  Broadcast: ${txid}`);
  console.log(`  Explorer:  ${EXPLORER}/${txid}?chain=testnet`);
  return txid;
}

async function callContract(privateKey, nonce, contractAddress, contractName, fn, args, fee = 100_000) {
  const tx = await makeContractCall({
    contractAddress,
    contractName,
    functionName:      fn,
    functionArgs:      args,
    senderKey:         privateKey,
    network,
    postConditionMode: PostConditionMode.Allow,
    anchorMode:        1,
    fee,
    nonce,
  });
  const txid = await broadcast(tx);
  console.log(`  Broadcast: ${txid}`);
  console.log(`  Explorer:  ${EXPLORER}/${txid}?chain=testnet`);
  return txid;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const privateKey = await getPrivateKey();
  const DEPLOYER   = deriveTestnetAddress(privateKey);

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   FlashStack — Testnet Deployment (pool-v3 line)     ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`  Network:  testnet (https://api.testnet.hiro.so)`);
  console.log(`  Deployer: ${DEPLOYER}`);
  console.log(`  Explorer: https://explorer.hiro.so/address/${DEPLOYER}?chain=testnet`);
  console.log();

  const stxBalance = await getStxBalance(DEPLOYER);
  console.log(`  STX balance:  ${(Number(stxBalance) / 1_000_000).toFixed(2)} STX`);
  if (stxBalance < 2_000_000_000n) {
    console.warn("  WARNING: below 2000 STX. Three contract deploys plus five calls need");
    console.warn("  2.2 STX in fees total (deployments/testnet-pool-v3-plan.yaml totals:) --");
    console.warn("  this preflight threshold is conservative, not the exact cost.");
    console.warn(`  Fund at: https://explorer.hiro.so/sandbox/faucet?chain=testnet`);
    if (stxBalance < 200_000_000n) {
      console.error("  ERROR: insufficient STX to proceed.");
      process.exit(1);
    }
  }

  const sbtcBalance = await getSbtcBalance(DEPLOYER);
  console.log(`  sBTC balance: ${sbtcBalance} sats`);
  const sbtcNeeded = BigInt(DEPOSIT_AMOUNT + RECEIVER_SEED_AMOUNT);
  if (sbtcBalance < sbtcNeeded) {
    console.error(`  ERROR: need at least ${sbtcNeeded} sats of testnet sBTC (deposit + receiver`);
    console.error(`  buffer), have ${sbtcBalance}.`);
    console.error("");
    console.error("  Testnet sBTC does not come from a faucet and this key cannot mint it.");
    console.error(`  It has to arrive as a SIP-010 transfer from the known byte-identical`);
    console.error(`  sBTC deployment at ${SBTC_TESTNET_ADDRESS}`);
    console.error("  (docs/TESTNET_STAGING.md section 5.2 / action 5) -- an operator-performed");
    console.error(`  manual step, not something this script automates. Send at least`);
    console.error(`  ${sbtcNeeded} sats of ${SBTC_TESTNET_ADDRESS}.${SBTC_TESTNET_NAME} to:`);
    console.error(`    ${DEPLOYER}`);
    console.error("  then re-run this script.");
    process.exit(1);
  }
  console.log();

  let nonce = await getNonce(DEPLOYER);
  console.log(`  Starting nonce: ${nonce}\n`);

  const results = {};

  // ── Step 1: flashstack-v3-receiver-trait ─────────────────────────────────
  console.log("Step 1 — Deploy flashstack-v3-receiver-trait");
  console.log("  (Generic receiver interface -- not yet deployed anywhere, mainnet or testnet)");
  results.trait = await deployContract(
    privateKey, nonce++,
    "flashstack-v3-receiver-trait",
    "contracts/flashstack-v3-receiver-trait.clar",
    DEPLOYER,
  );
  await waitForConfirm(results.trait, "deploy flashstack-v3-receiver-trait");
  console.log();

  // ── Step 2: flashstack-pool-v3 ────────────────────────────────────────────
  console.log("Step 2 — Deploy flashstack-pool-v3");
  console.log("  (Generic multi-asset flash-loan + LP pool, Clarity 6 / epoch 4.0)");
  results.pool = await deployContract(
    privateKey, nonce++,
    "flashstack-pool-v3",
    "contracts/flashstack-pool-v3.clar",
    DEPLOYER,
  );
  await waitForConfirm(results.pool, "deploy flashstack-pool-v3");
  console.log();

  // ── Step 3: pool-v3-test-receiver ─────────────────────────────────────────
  console.log("Step 3 — Deploy pool-v3-test-receiver");
  console.log("  (Minimal happy-path receiver: repays principal + fee, fee read live)");
  results.receiver = await deployContract(
    privateKey, nonce++,
    "pool-v3-test-receiver",
    "contracts/pool-v3-test-receiver.clar",
    DEPLOYER,
  );
  await waitForConfirm(results.receiver, "deploy pool-v3-test-receiver");
  console.log();

  // ── Step 4: List sBTC as an asset ─────────────────────────────────────────
  console.log(`Step 4 — add-asset: list ${SBTC_TESTNET_ADDRESS}.${SBTC_TESTNET_NAME}`);
  console.log(`  (fee-bp ${FEE_BP} = ${(FEE_BP / 100).toFixed(2)}%, max-loan ${MAX_LOAN} sats)`);
  results.addAsset = await callContract(
    privateKey, nonce++,
    DEPLOYER, "flashstack-pool-v3", "add-asset",
    [
      Cl.contractPrincipal(SBTC_TESTNET_ADDRESS, SBTC_TESTNET_NAME),
      Cl.uint(FEE_BP),
      Cl.uint(MAX_LOAN),
    ],
    150_000,
  );
  await waitForConfirm(results.addAsset, "add-asset");

  const listed = await callReadOnly(DEPLOYER, DEPLOYER, "flashstack-pool-v3", "is-listed",
    [Cl.contractPrincipal(SBTC_TESTNET_ADDRESS, SBTC_TESTNET_NAME)]);
  assertEqual("asset listed after add-asset", listed, "true");
  console.log();

  // ── Step 5: Whitelist the receiver ────────────────────────────────────────
  console.log("Step 5 — Whitelist pool-v3-test-receiver in flashstack-pool-v3");
  results.whitelist = await callContract(
    privateKey, nonce++,
    DEPLOYER, "flashstack-pool-v3", "add-approved-receiver",
    [Cl.principal(`${DEPLOYER}.pool-v3-test-receiver`)],
  );
  await waitForConfirm(results.whitelist, "add-approved-receiver");
  console.log();

  // ── Step 6: Deposit (funds the reserve AND mints the deployer LP shares) ──
  console.log(`Step 6 — Deposit ${DEPOSIT_AMOUNT} sats of sBTC`);
  console.log("  (pool-v3 has no separate admin-only reserve function -- deposit funds");
  console.log("   the per-asset reserve and mints the depositor LP shares in one call)");
  results.deposit = await callContract(
    privateKey, nonce++,
    DEPLOYER, "flashstack-pool-v3", "deposit",
    [
      Cl.contractPrincipal(SBTC_TESTNET_ADDRESS, SBTC_TESTNET_NAME),
      Cl.uint(DEPOSIT_AMOUNT),
    ],
    150_000,
  );
  await waitForConfirm(results.deposit, "deposit");
  console.log();

  // ── Step 7: Seed the receiver's fee buffer ────────────────────────────────
  console.log(`Step 7 — Seed pool-v3-test-receiver with ${RECEIVER_SEED_AMOUNT} sats of sBTC`);
  console.log("  (receiver repays principal + fee from its own balance; without this a");
  console.log("   fresh receiver has 0 sBTC and the flash loan fails before the pool's");
  console.log("   own invariant is even reached)");
  results.seed = await callContract(
    privateKey, nonce++,
    SBTC_TESTNET_ADDRESS, SBTC_TESTNET_NAME, "transfer",
    [
      Cl.uint(RECEIVER_SEED_AMOUNT),
      Cl.principal(DEPLOYER),
      Cl.principal(`${DEPLOYER}.pool-v3-test-receiver`),
      Cl.none(),
    ],
    100_000,
  );
  await waitForConfirm(results.seed, "seed pool-v3-test-receiver");
  console.log();

  // ── Step 8: Execute test flash loan ───────────────────────────────────────
  console.log(`Step 8 — Execute flash loan: borrow ${LOAN_AMOUNT} sats of sBTC via pool-v3-test-receiver`);
  console.log("  (This is the testnet evidence txid -- atomic borrow + repay in one tx)");
  const reserveBefore = await callReadOnly(DEPLOYER, DEPLOYER, "flashstack-pool-v3", "get-reserve",
    [Cl.contractPrincipal(SBTC_TESTNET_ADDRESS, SBTC_TESTNET_NAME)]);
  results.flashLoan = await callContract(
    privateKey, nonce++,
    DEPLOYER, "flashstack-pool-v3", "flash-loan",
    [
      Cl.contractPrincipal(SBTC_TESTNET_ADDRESS, SBTC_TESTNET_NAME),
      Cl.uint(LOAN_AMOUNT),
      Cl.principal(`${DEPLOYER}.pool-v3-test-receiver`),
    ],
    200_000,
  );
  await waitForConfirm(results.flashLoan, "flash-loan (testnet evidence)");

  const reserveAfter = await callReadOnly(DEPLOYER, DEPLOYER, "flashstack-pool-v3", "get-reserve",
    [Cl.contractPrincipal(SBTC_TESTNET_ADDRESS, SBTC_TESTNET_NAME)]);
  console.log(`  reserve before: ${reserveBefore}, reserve after: ${reserveAfter} (must have grown by >= the fee)`);
  console.log();

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║      TESTNET DEPLOYMENT COMPLETE (pool-v3 line)      ║");
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log(`║  Deployer: ${DEPLOYER.padEnd(42)} ║`);
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log("║  Contracts:                                          ║");
  console.log(`  flashstack-v3-receiver-trait: ${EXPLORER}/${results.trait}?chain=testnet`);
  console.log(`  flashstack-pool-v3:           ${EXPLORER}/${results.pool}?chain=testnet`);
  console.log(`  pool-v3-test-receiver:        ${EXPLORER}/${results.receiver}?chain=testnet`);
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log("║  Actions:                                            ║");
  console.log(`  add-asset (sBTC):         ${EXPLORER}/${results.addAsset}?chain=testnet`);
  console.log(`  Whitelist receiver:       ${EXPLORER}/${results.whitelist}?chain=testnet`);
  console.log(`  Deposit (${DEPOSIT_AMOUNT} sats):     ${EXPLORER}/${results.deposit}?chain=testnet`);
  console.log(`  Seed receiver (${RECEIVER_SEED_AMOUNT} sats): ${EXPLORER}/${results.seed}?chain=testnet`);
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log("║  TESTNET FLASH LOAN EVIDENCE:                        ║");
  console.log(`  Flash loan (${LOAN_AMOUNT} sats): ${EXPLORER}/${results.flashLoan}?chain=testnet`);
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log("║  Address activity (all txids):                       ║");
  console.log(`  https://explorer.hiro.so/address/${DEPLOYER}?chain=testnet`);
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log();
  console.log("Next steps:");
  console.log("  1. Independently re-verify every txid above against the live testnet API --");
  console.log("     not this console output -- before treating any of it as evidence");
  console.log("     (docs/TESTNET_STAGING.md section 7).");
  console.log("  2. Add the evidence to docs/TESTNET_STAGING.md.");
  console.log("  3. Security & Contract Lead review of the recorded evidence (gate step 6).");
  console.log("  4. Still not covered: flashstack-stx-pool-v3 (own receiver) and");
  console.log("     flashstack-sbtc-core-v2 (own line). Natural follow-ups, not folded in here.");
}

main().catch(e => {
  console.error("\nFAILED:", e.message);
  process.exit(1);
});
