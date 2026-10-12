/**
 * De-approve seyi-flash-receiver-v1 (a third party's own contract, out of
 * FlashStack's control) from flashstack-stx-core.
 *
 * Still approved as of 2026-10-12 (confirmed by Hillary's F-10 re-sweep)
 * and holding 999,000 uSTX that anyone can take with a direct call --
 * live, reachable, exploitable right now. Rescuing those funds is Seyi's
 * own call (he's been notified separately); removing the approval from
 * stx-core is FlashStack's call as core admin, independent of whether he's
 * acted yet -- this script only does the latter. It does not touch his
 * contract or its balance in any way.
 *
 * Same pattern as scripts/remove-vulnerable-stx-core-receivers.mjs (PR
 * #95): DRY-RUN BY DEFAULT, signer checked against the expected admin
 * before any broadcast, balance re-checked immediately before each call.
 *
 * Broadcast 2026-10-12, success, re-verified independently after
 * confirmation (is-approved-receiver reads false): txid
 * 0xbd6c7faca384a7e880e0df954e8cb60d1e460038cd7f49c0658ad864065b0b9e
 *
 * Usage:
 *   DEPLOYER_MNEMONIC="…" node scripts/remove-seyi-stx-core-receiver.mjs
 *   DEPLOYER_MNEMONIC="…" EXECUTE=true node scripts/remove-seyi-stx-core-receiver.mjs --yes-mainnet
 *
 * Must be signed by flashstack-stx-core's admin (SPR9PQ… after the
 * 2026-06-12 rotation); otherwise the call fails with ERR-NOT-ADMIN.
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

// Not under CORE.address -- this is Seyi's own deployer, a third party.
const TARGET = { address: "SP6XSRT6QYQ3KJ96Q8JG3N0QVDS4BHKSCHREMFMF", name: "seyi-flash-receiver-v1" };

const MNEMONIC = process.env.DEPLOYER_MNEMONIC;
const EXECUTE  = process.env.EXECUTE === "true" && process.argv.includes("--yes-mainnet");
const FEE      = BigInt(process.env.FEE ?? "50000"); // 0.05 STX default; override with FEE=…

if (!MNEMONIC) {
  console.error("ERROR: set DEPLOYER_MNEMONIC (the core admin wallet, SPR9PQ…)");
  process.exit(1);
}

async function getStxBalance(address, contractName) {
  const res = await fetch(`${API}/extended/v1/address/${address}.${contractName}/balances`).then((r) => r.json());
  return BigInt(res.stx?.balance ?? "0");
}

async function main() {
  const wallet = await generateWallet({ secretKey: MNEMONIC, password: "" });
  const pk     = wallet.accounts[0].stxPrivateKey;
  const sender = privateKeyToAddress(pk, "mainnet");

  const acct  = await fetch(`${API}/v2/accounts/${sender}?proof=0`).then((r) => r.json());
  const bal   = parseInt(acct.balance, 16) / 1e6;
  const nonce = acct.nonce;

  console.log("==========================================================");
  console.log("  FlashStack — de-approve seyi-flash-receiver-v1");
  console.log("==========================================================");
  console.log(`  Mode:     ${EXECUTE ? "LIVE — WILL BROADCAST" : "DRY RUN (nothing broadcast)"}`);
  console.log(`  Signer:   ${sender}`);
  console.log(`  Expected: ${ADMIN}`);
  console.log(`  Match:    ${sender === ADMIN ? "yes" : "NO -- see warning below"}`);
  console.log(`  Balance:  ${bal.toFixed(3)} STX`);
  console.log(`  Nonce:    ${nonce}`);
  console.log();

  if (sender !== ADMIN) {
    console.error(`  ⚠ WARNING: signer is not the expected admin (${ADMIN}).`);
    console.error(`    remove-approved-receiver will fail with ERR-NOT-ADMIN unless this wallet is the core admin.`);
    if (EXECUTE) { console.error("    Aborting live run — load the admin mnemonic."); process.exit(1); }
  }

  const preBalance = await getStxBalance(TARGET.address, TARGET.name);
  console.log(`  • remove-approved-receiver(${TARGET.address}.${TARGET.name})   (nonce ${nonce})`);
  console.log(`    current balance: ${preBalance} µSTX ${preBalance > 0n ? "⚠ NONZERO — this is the live exposure, removal doesn't touch it, only the approval" : "(already rescued)"}`);

  if (!EXECUTE) {
    console.log();
    console.log("  Dry run only -- rerun with EXECUTE=true ... --yes-mainnet to broadcast.");
    return;
  }

  const tx = await makeContractCall({
    contractAddress:   CORE.address,
    contractName:      CORE.name,
    functionName:      "remove-approved-receiver",
    functionArgs:      [Cl.contractPrincipal(TARGET.address, TARGET.name)],
    senderKey:         pk,
    network:           STACKS_MAINNET,
    postConditionMode: PostConditionMode.Deny,
    anchorMode:         1,
    nonce,
    fee: FEE,
  });

  const result = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if (result.error) {
    console.error(`    FAILED: ${result.error} -- ${result.reason ?? ""}`);
    process.exit(1);
  }
  console.log(`    Broadcast: ${EXPLORER}/0x${result.txid}?chain=mainnet`);
}

main().catch((e) => { console.error(e); process.exit(1); });
