/**
 * De-approve the REAL hk-stx-real-receiver-v1 from flashstack-stx-core.
 *
 * Part of the original F-10 sweep (PR #95) targeted
 * SP20XD46...hk-stx-real-receiver-v1 for removal -- but no contract exists
 * at that address. Hillary's re-sweep (2026-10-12) found the real one at
 * SP3NZYZA88ENNF0FCR57KBGPFY5RAXWHXXVSB6FBW.hk-stx-real-receiver-v1,
 * confirmed it has no caller check, and confirmed it's still approved.
 * Holds 0 STX (not an active funds exposure, unlike seyi's receiver), but
 * it's still a live, reachable, unprotected surface and shouldn't stay
 * approved. Hillary is waiting on this (plus the seyi removal, already
 * done) before he reviews #95 -- the register there should list this one
 * correctly once it lands.
 *
 * Same pattern as scripts/remove-vulnerable-stx-core-receivers.mjs (PR
 * #95) and scripts/remove-seyi-stx-core-receiver.mjs: DRY-RUN BY DEFAULT,
 * signer checked against the expected admin before any broadcast,
 * balance re-checked immediately before the call.
 *
 * Broadcast 2026-10-12, success, re-verified independently after
 * confirmation (is-approved-receiver reads false): txid
 * 0xd6fe02d9c325da5816f65d009cc7e163a61c5c6be61c85c319612940b897d741
 *
 * Usage:
 *   DEPLOYER_MNEMONIC="…" node scripts/remove-hk-stx-real-receiver.mjs
 *   DEPLOYER_MNEMONIC="…" EXECUTE=true node scripts/remove-hk-stx-real-receiver.mjs --yes-mainnet
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

// Hillary's contract, not FlashStack's own deployer -- the "hk-" prefix.
const TARGET = { address: "SP3NZYZA88ENNF0FCR57KBGPFY5RAXWHXXVSB6FBW", name: "hk-stx-real-receiver-v1" };

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
  console.log("  FlashStack — de-approve the REAL hk-stx-real-receiver-v1");
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
  console.log(`    current balance: ${preBalance} µSTX ${preBalance > 0n ? "⚠ NONZERO — re-check before proceeding, this was expected to be 0" : "(as expected, dormant)"}`);

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
