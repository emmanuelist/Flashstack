/**
 * Phase 2 of F-10: remove the remaining receivers across BOTH cores that
 * share the same unrestricted-callback / untrusted-repay-destination flaw
 * #95 fixed for three stx-core receivers. Found by the Security & Contract
 * Lead, 2026-10-09, re-auditing every receiver ever approved on EITHER core
 * (not just the three #95 covers) against its live deployed source and
 * current balance.
 *
 * Both cores currently share the same admin (confirmed live via get-admin
 * on each, 2026-10-09: identical principal on flashstack-stx-core and
 * flashstack-sbtc-core), so one signer covers every removal below.
 *
 * IMPORTANT: removing a receiver from approved-receivers does NOT protect
 * any balance already sitting inside it -- execute-*-flash has no caller
 * gate, so a direct call bypasses the core (and its whitelist) entirely.
 * Run scripts/rescue-vulnerable-receiver-funds.mjs FIRST for any receiver
 * with a nonzero balance below; this script only removes the whitelist
 * entry.
 *
 * STX-core (6): stx-test-receiver (~820,000 uSTX -- rescue first),
 *   bitflow-arb-receiver-v3 (~200,000 -- rescue first), bitflow-arb-receiver-v4
 *   (~184,863 -- rescue first), bitflow-arb-receiver-v2 (0), alex-arb-receiver-v2
 *   (0), hk-stx-real-receiver-v1 (0).
 * SBTC-core (3): zest-liquidation-receiver (0 -- #95 only removed it from
 *   stx-core, it is SEPARATELY approved here), velar-sbtc-arb-receiver (0),
 *   sbtc-test-receiver (~95 sats -- rescue first).
 *
 * NOT included: seyi-flash-receiver-v1 (~999,000 uSTX). Deployed under a
 * third party's wallet (not SP20XD46...), so FlashStack cannot rescue or
 * remove it -- the owner needs to be told directly. Confirm the exact
 * contract principal before doing anything with it.
 *
 * DRY-RUN BY DEFAULT. To broadcast, pass BOTH: EXECUTE=true and --yes-mainnet
 *
 * Usage:
 *   ADMIN_MNEMONIC="...24 words..." node scripts/remove-vulnerable-receivers-phase2.mjs
 *   ADMIN_MNEMONIC="..." EXECUTE=true node scripts/remove-vulnerable-receivers-phase2.mjs --yes-mainnet
 */

import { makeContractCall, broadcastTransaction, Cl, PostConditionMode, privateKeyToAddress } from "@stacks/transactions";
import networkPkg from "@stacks/network";
const { STACKS_MAINNET } = networkPkg;
import walletPkg from "@stacks/wallet-sdk";
const { generateWallet } = walletPkg;

const API      = "https://api.hiro.so";
const EXPLORER = "https://explorer.hiro.so/txid";
const ADMIN    = "SPR9PQANV6XHSDNRAX2GNKCA5Z1KH61961KE0BYG"; // expected signer, both cores
const DEPLOYER = "SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5";

const STX_CORE  = { address: DEPLOYER, name: "flashstack-stx-core" };
const SBTC_CORE = { address: DEPLOYER, name: "flashstack-sbtc-core" };

const TARGETS = [
  { core: STX_CORE,  name: "stx-test-receiver" },
  { core: STX_CORE,  name: "bitflow-arb-receiver-v3" },
  { core: STX_CORE,  name: "bitflow-arb-receiver-v4" },
  { core: STX_CORE,  name: "bitflow-arb-receiver-v2" },
  { core: STX_CORE,  name: "alex-arb-receiver-v2" },
  { core: STX_CORE,  name: "hk-stx-real-receiver-v1" },
  { core: SBTC_CORE, name: "zest-liquidation-receiver" },
  { core: SBTC_CORE, name: "velar-sbtc-arb-receiver" },
  { core: SBTC_CORE, name: "sbtc-test-receiver" },
];

const SBTC_CONTRACT = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

const MNEMONIC = process.env.ADMIN_MNEMONIC;
const EXECUTE  = process.env.EXECUTE === "true" && process.argv.includes("--yes-mainnet");
const FEE      = BigInt(process.env.FEE ?? "50000"); // 0.05 STX default; override with FEE=...

if (!MNEMONIC) {
  console.error("ERROR: set ADMIN_MNEMONIC (the shared core admin wallet, SPR9PQAN...)");
  process.exit(1);
}

async function getBalances(address, name) {
  const res = await fetch(`${API}/extended/v1/address/${address}.${name}/balances`).then((r) => r.json());
  const stx = BigInt(res.stx?.balance ?? "0");
  const sbtc = BigInt(res.fungible_tokens?.[`${SBTC_CONTRACT}::sbtc-token`]?.balance ?? "0");
  return { stx, sbtc };
}

async function main() {
  const wallet = await generateWallet({ secretKey: MNEMONIC, password: "" });
  const pk     = wallet.accounts[0].stxPrivateKey;
  const sender = privateKeyToAddress(pk, "mainnet");

  const acct  = await fetch(`${API}/v2/accounts/${sender}?proof=0`).then((r) => r.json());
  const bal   = parseInt(acct.balance, 16) / 1e6;
  let   nonce = acct.nonce;

  console.log("==========================================================");
  console.log("  FlashStack — F-10 phase 2: remove 9 receivers, both cores");
  console.log("==========================================================");
  console.log(`  Mode:     ${EXECUTE ? "LIVE — WILL BROADCAST" : "DRY RUN (nothing broadcast)"}`);
  console.log(`  Signer:   ${sender}`);
  console.log(`  Balance:  ${bal.toFixed(3)} STX`);
  console.log(`  Nonce:    ${nonce}`);
  console.log();

  if (sender !== ADMIN) {
    console.error(`  ⚠ WARNING: signer is not the expected admin (${ADMIN}).`);
    console.error(`    remove-approved-receiver will fail with ERR-NOT-ADMIN on either core unless this wallet is the admin.`);
    if (EXECUTE) { console.error("    Aborting live run — load the admin mnemonic."); process.exit(1); }
  }

  for (const { core, name } of TARGETS) {
    const { stx, sbtc } = await getBalances(core.address, name);
    const bal = core === SBTC_CORE ? sbtc : stx;
    const unit = core === SBTC_CORE ? "sats sBTC" : "µSTX";
    console.log(`  • remove-approved-receiver(${core.address}.${name}) on ${core.name}   (nonce ${nonce})`);
    console.log(`    current balance: ${bal} ${unit} ${bal > 0n ? "⚠ NONZERO — rescue before (or instead of) removing" : "(dormant)"}`);

    if (!EXECUTE) { nonce++; continue; }

    const tx = await makeContractCall({
      contractAddress:   core.address,
      contractName:      core.name,
      functionName:      "remove-approved-receiver",
      functionArgs:      [Cl.contractPrincipal(core.address, name)],
      senderKey:         pk,
      network:           STACKS_MAINNET,
      postConditionMode: PostConditionMode.Deny,
      fee:               FEE,
      nonce,
    });
    const res = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
    if (res.error) { console.error(`    ✗ ${res.error} ${res.reason ?? ""}`); process.exit(1); }
    console.log(`    ✓ ${EXPLORER}/0x${res.txid}?chain=mainnet`);
    nonce++;
  }

  console.log();
  console.log(EXECUTE
    ? "  Broadcast. Once confirmed, re-verify with is-approved-receiver on all nine -- should read false (ok false on sbtc-core)."
    : "  Dry run complete. Re-run with EXECUTE=true --yes-mainnet to broadcast.");
}

main().catch((e) => { console.error(e); process.exit(1); });
