/**
 * Remove three currently-approved receivers on the live flashstack-stx-core
 * that have NO contract-caller restriction on execute-stx-flash and repay to
 * the CALLER-SUPPLIED `core` parameter instead of a hardcoded flashstack-stx-core
 * address. Anyone can call execute-stx-flash directly (not through a real
 * flash-loan) and redirect whatever STX balance the receiver holds to an
 * address of their choosing, as long as the receiver's balance is nonzero at
 * that moment.
 *
 * Found 2026-10-07. All three confirmed at 0 STX balance right now (dormant,
 * same posture as F-9) -- verified via get-stx-balance / account balance
 * lookup directly, not assumed. Not currently draining anything, but live and
 * reachable the moment any of these three holds a balance again.
 *
 *   alex-arb-receiver      -- no contract-caller check, no hardcoded repay target
 *   bitflow-arb-receiver   -- same
 *   zest-liquidation-receiver -- same
 *
 * NOT touched: alex-arb-receiver-v3/v4/v5 (all three have `contract-caller ==
 * FLASH-CORE` + a hardcoded repay target -- verified directly, safe, stay
 * approved). velar-sbtc-arb-receiver is already not approved. arkadiko-
 * liquidation-receiver is not deployed.
 *
 * DRY-RUN BY DEFAULT. To broadcast, pass BOTH: EXECUTE=true and --yes-mainnet
 *
 * Usage:
 *   DEPLOYER_MNEMONIC="…SPR9PQ… 24 words…" node scripts/remove-vulnerable-stx-core-receivers.mjs
 *   DEPLOYER_MNEMONIC="…" EXECUTE=true node scripts/remove-vulnerable-stx-core-receivers.mjs --yes-mainnet
 *
 * Must be signed by flashstack-stx-core's admin (SPR9PQ… after the
 * 2026-06-12 rotation -- confirmed live via get-admin before this script was
 * written); otherwise the calls fail with ERR-NOT-ADMIN.
 */

import { makeContractCall, broadcastTransaction, Cl, PostConditionMode, privateKeyToAddress } from "@stacks/transactions";
import networkPkg from "@stacks/network";
const { STACKS_MAINNET } = networkPkg;
import walletPkg from "@stacks/wallet-sdk";
const { generateWallet } = walletPkg;

const API      = "https://api.hiro.so";
const EXPLORER = "https://explorer.hiro.so/txid";
const ADMIN    = "SPR9PQANV6XHSDNRAX2GNKCA5Z1KH61961KE0BYG"; // expected signer (core admin)
const CORE     = { address: "SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5", name: "flashstack-stx-core" };

const RECEIVERS = ["alex-arb-receiver", "bitflow-arb-receiver", "zest-liquidation-receiver"];

const MNEMONIC = process.env.DEPLOYER_MNEMONIC;
const EXECUTE  = process.env.EXECUTE === "true" && process.argv.includes("--yes-mainnet");
const FEE      = BigInt(process.env.FEE ?? "50000"); // 0.05 STX default; override with FEE=…

if (!MNEMONIC) {
  console.error("ERROR: set DEPLOYER_MNEMONIC (the core admin wallet, SPR9PQ…)");
  process.exit(1);
}

async function getStxBalance(contractName) {
  const res = await fetch(`${API}/extended/v1/address/${CORE.address}.${contractName}/balances`).then((r) => r.json());
  return BigInt(res.stx?.balance ?? "0");
}

async function main() {
  const wallet = await generateWallet({ secretKey: MNEMONIC, password: "" });
  const pk     = wallet.accounts[0].stxPrivateKey;
  const sender = privateKeyToAddress(pk, "mainnet");

  const acct  = await fetch(`${API}/v2/accounts/${sender}?proof=0`).then((r) => r.json());
  const bal   = parseInt(acct.balance, 16) / 1e6;
  let   nonce = acct.nonce;

  console.log("==========================================================");
  console.log("  FlashStack — remove 3 unrestricted-callback receivers");
  console.log("==========================================================");
  console.log(`  Mode:     ${EXECUTE ? "LIVE — WILL BROADCAST" : "DRY RUN (nothing broadcast)"}`);
  console.log(`  Signer:   ${sender}`);
  console.log(`  Balance:  ${bal.toFixed(3)} STX`);
  console.log(`  Nonce:    ${nonce}`);
  console.log();

  if (sender !== ADMIN) {
    console.error(`  ⚠ WARNING: signer is not the expected admin (${ADMIN}).`);
    console.error(`    remove-approved-receiver will fail with ERR-NOT-ADMIN unless this wallet is the core admin.`);
    if (EXECUTE) { console.error("    Aborting live run — load the admin mnemonic."); process.exit(1); }
  }

  for (const name of RECEIVERS) {
    const preBalance = await getStxBalance(name);
    console.log(`  • remove-approved-receiver(${CORE.address}.${name})   (nonce ${nonce})`);
    console.log(`    current balance: ${preBalance} µSTX ${preBalance > 0n ? "⚠ NONZERO — re-check before proceeding" : "(dormant, as last verified)"}`);

    if (!EXECUTE) { nonce++; continue; }

    const tx = await makeContractCall({
      contractAddress:   CORE.address,
      contractName:      CORE.name,
      functionName:      "remove-approved-receiver",
      functionArgs:      [Cl.contractPrincipal(CORE.address, name)],
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
    ? "  Broadcast. Once confirmed, re-verify with is-approved-receiver on all three -- should read false."
    : "  Dry run complete. Re-run with EXECUTE=true --yes-mainnet to broadcast.");
}

main().catch((e) => { console.error(e); process.exit(1); });
