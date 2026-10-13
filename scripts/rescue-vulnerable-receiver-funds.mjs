/**
 * Rescue FlashStack's own funds out of receivers vulnerable to F-10
 * (unrestricted execute-*-flash callback + caller-supplied repay target)
 * before removal from a core's approved-receivers list, since removal does
 * NOT protect a balance already sitting inside the receiver -- a direct
 * call to execute-*-flash never goes through the core, so it is unaffected
 * by whether the receiver is still whitelisted.
 *
 * Found by the Security & Contract Lead, 2026-10-09, re-auditing every
 * receiver ever approved on both cores (not just the three #95 removed).
 *
 * Two independent rescue paths, because they need two DIFFERENT signing
 * keys:
 *
 *   GROUP A -- owner-gated rescue-stx(amount, to)
 *     bitflow-arb-receiver-v3 (~200,000 uSTX), bitflow-arb-receiver-v4
 *     (~184,863 uSTX). CONTRACT-OWNER on both is `tx-sender` at DEPLOY time,
 *     i.e. the deployer wallet SP20XD46... -- NOT flashstack-stx-core's
 *     current (rotated) admin SPR9PQAN.... Needs DEPLOYER_MNEMONIC for
 *     SP20XD46....
 *
 *   GROUP B -- self-call the vulnerable path directly
 *     stx-test-receiver (~820,000 uSTX of flashstack-stx-core's STX),
 *     sbtc-test-receiver (~95 sats of flashstack-sbtc-core's sBTC). Neither
 *     has a rescue function; both have NO caller gate at all on
 *     execute-*-flash, so ANY funded wallet can call it directly with
 *     `core` set to a destination of OUR choosing, recovering the balance
 *     the same way an attacker would -- just first. Needs any funded
 *     SIGNER_MNEMONIC (does not need to be deployer or admin).
 *
 * All amounts are computed live from each receiver's CURRENT balance and
 * the core's CURRENT fee-basis-points, maximizing extraction while leaving
 * a safety margin so the repay transfer doesn't fail from rounding.
 *
 * DRY-RUN BY DEFAULT. To broadcast, pass BOTH: EXECUTE=true and --yes-mainnet
 *
 * Usage:
 *   RESCUE_TO="SP..."  DEPLOYER_MNEMONIC="...24 words..." node scripts/rescue-vulnerable-receiver-funds.mjs --group=A
 *   RESCUE_TO="SP..."  SIGNER_MNEMONIC="...24 words..."   node scripts/rescue-vulnerable-receiver-funds.mjs --group=B
 *   (add EXECUTE=true --yes-mainnet to broadcast; omit to dry-run)
 */

import { makeContractCall, broadcastTransaction, Cl, PostConditionMode, privateKeyToAddress } from "@stacks/transactions";
import networkPkg from "@stacks/network";
const { STACKS_MAINNET } = networkPkg;
import walletPkg from "@stacks/wallet-sdk";
const { generateWallet } = walletPkg;

const API      = "https://api.hiro.so";
const EXPLORER = "https://explorer.hiro.so/txid";
const DEPLOYER = "SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5"; // CONTRACT-OWNER on bitflow-v3/v4

const STX_CORE  = { address: DEPLOYER, name: "flashstack-stx-core" };
const SBTC_CORE = { address: DEPLOYER, name: "flashstack-sbtc-core" };

const GROUP_A = [
  { name: "bitflow-arb-receiver-v3", fn: "rescue-stx" },
  { name: "bitflow-arb-receiver-v4", fn: "rescue-stx" },
];

const GROUP_B = [
  { name: "stx-test-receiver",  core: STX_CORE,  fn: "execute-stx-flash",  asset: "stx" },
  { name: "sbtc-test-receiver", core: SBTC_CORE, fn: "execute-sbtc-flash", asset: "sbtc" },
];

const SBTC_CONTRACT = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

const GROUP     = (process.argv.find((a) => a.startsWith("--group=")) ?? "").split("=")[1];
const RESCUE_TO = process.env.RESCUE_TO;
const EXECUTE   = process.env.EXECUTE === "true" && process.argv.includes("--yes-mainnet");
const FEE       = BigInt(process.env.FEE ?? "50000"); // 0.05 STX default; override with FEE=...

if (GROUP !== "A" && GROUP !== "B") {
  console.error("ERROR: pass --group=A (bitflow-v3/v4 rescue-stx) or --group=B (test-receiver self-call)");
  process.exit(1);
}
if (!RESCUE_TO) {
  console.error("ERROR: set RESCUE_TO to the address that should receive the rescued funds");
  process.exit(1);
}
const MNEMONIC = GROUP === "A" ? process.env.DEPLOYER_MNEMONIC : process.env.SIGNER_MNEMONIC;
if (!MNEMONIC) {
  console.error(`ERROR: set ${GROUP === "A" ? "DEPLOYER_MNEMONIC (SP20XD46... deployer wallet)" : "SIGNER_MNEMONIC (any funded wallet)"}`);
  process.exit(1);
}

async function getStxBalance(address, name) {
  const res = await fetch(`${API}/extended/v1/address/${address}.${name}/balances`).then((r) => r.json());
  return BigInt(res.stx?.balance ?? "0");
}
async function getSbtcBalance(address, name) {
  const res = await fetch(`${API}/extended/v1/address/${address}.${name}/balances`).then((r) => r.json());
  return BigInt(res.fungible_tokens?.[`${SBTC_CONTRACT}::sbtc-token`]?.balance ?? "0");
}
async function getFeeBp(core) {
  const res = await fetch(`${API}/v2/contracts/call-read/${core.address}/${core.name}/get-fee-basis-points`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender: core.address, arguments: [] }),
  }).then((r) => r.json());
  // (response uint none) hex-decoded result: 0x07 (ok) + 01 (uint type) + 16-byte value,
  // e.g. 0x0701000000000000000000000000000005 -> ok(u5). Must strip BOTH tag bytes (6 hex
  // chars after "0x"), not just the response tag -- slice(4) alone leaves the type-tag byte
  // in the value, inflating it by 2^128.
  const hex = res.result.slice(6);
  return BigInt("0x" + hex);
}

// Pick the largest `amount` such that amount + fee(amount) <= balance, with
// a safety margin so the repay transfer can't fail from an off-by-one.
function maxExtractable(balance, feeBp) {
  let amount = balance;
  for (let i = 0; i < 3; i++) {
    const rawFee = (amount * feeBp) / 10000n;
    const fee = rawFee > 0n ? rawFee : 1n;
    amount = balance - fee;
  }
  const rawFee = (amount * feeBp) / 10000n;
  const fee = rawFee > 0n ? rawFee : 1n;
  return amount - fee > 0n ? amount - fee : 0n; // extra 1-unit margin
}

async function main() {
  const wallet = await generateWallet({ secretKey: MNEMONIC, password: "" });
  const pk     = wallet.accounts[0].stxPrivateKey;
  const sender = privateKeyToAddress(pk, "mainnet");

  const acct  = await fetch(`${API}/v2/accounts/${sender}?proof=0`).then((r) => r.json());
  let   nonce = acct.nonce;

  console.log("==========================================================");
  console.log(`  FlashStack — rescue F-10 funds (Group ${GROUP})`);
  console.log("==========================================================");
  console.log(`  Mode:       ${EXECUTE ? "LIVE — WILL BROADCAST" : "DRY RUN (nothing broadcast)"}`);
  console.log(`  Signer:     ${sender}`);
  console.log(`  Rescue to:  ${RESCUE_TO}`);
  console.log(`  Nonce:      ${nonce}`);
  console.log();

  if (GROUP === "A" && sender !== DEPLOYER) {
    console.error(`  ⚠ WARNING: signer is not the deployer wallet (${DEPLOYER}).`);
    console.error(`    rescue-stx will fail with ERR-NOT-OWNER unless this wallet deployed the receiver.`);
    if (EXECUTE) { console.error("    Aborting live run."); process.exit(1); }
  }

  if (GROUP === "A") {
    for (const { name, fn } of GROUP_A) {
      const balance = await getStxBalance(DEPLOYER, name);
      console.log(`  • ${fn}(${DEPLOYER}.${name})   (nonce ${nonce})`);
      console.log(`    current balance: ${balance} µSTX`);
      if (balance === 0n) { console.log(`    nothing to rescue, skipping`); continue; }

      if (!EXECUTE) { nonce++; continue; }
      const tx = await makeContractCall({
        contractAddress: DEPLOYER, contractName: name, functionName: fn,
        functionArgs: [Cl.uint(balance), Cl.principal(RESCUE_TO)],
        // Allow, not Deny: this call itself moves the STX we're rescuing (the
        // receiver's own repay transfer), and we don't declare a matching
        // post-condition -- Deny with none declared aborts the whole tx.
        senderKey: pk, network: STACKS_MAINNET, postConditionMode: PostConditionMode.Allow, fee: FEE, nonce,
      });
      const res = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
      if (res.error) { console.error(`    ✗ ${res.error} ${res.reason ?? ""}`); process.exit(1); }
      console.log(`    ✓ ${EXPLORER}/0x${res.txid}?chain=mainnet`);
      nonce++;
    }
  }

  if (GROUP === "B") {
    for (const { name, core, fn, asset } of GROUP_B) {
      const balance = asset === "stx" ? await getStxBalance(core.address, name) : await getSbtcBalance(core.address, name);
      console.log(`  • ${fn}(amount, core=${RESCUE_TO}) on ${core.address}.${name}   (nonce ${nonce})`);
      console.log(`    current balance: ${balance} ${asset === "stx" ? "µSTX" : "sats sBTC"}`);
      if (balance === 0n) { console.log(`    nothing to rescue, skipping`); continue; }

      const feeBp = await getFeeBp(core);
      const amount = maxExtractable(balance, feeBp);
      console.log(`    fee-bp: ${feeBp}, rescuing amount=${amount} (leaves a small dust margin)`);

      if (!EXECUTE) { nonce++; continue; }
      const tx = await makeContractCall({
        contractAddress: core.address, contractName: name, functionName: fn,
        functionArgs: [Cl.uint(amount), Cl.principal(RESCUE_TO)],
        // Allow, not Deny: same reason as Group A above -- this transfers the
        // STX/sBTC we're rescuing and we don't declare a post-condition for it.
        senderKey: pk, network: STACKS_MAINNET, postConditionMode: PostConditionMode.Allow, fee: FEE, nonce,
      });
      const res = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
      if (res.error) { console.error(`    ✗ ${res.error} ${res.reason ?? ""}`); process.exit(1); }
      console.log(`    ✓ ${EXPLORER}/0x${res.txid}?chain=mainnet`);
      nonce++;
    }
  }

  console.log();
  console.log(EXECUTE
    ? "  Broadcast. Once confirmed, re-verify each receiver's balance dropped to ~0 before removing it from either core's approved-receiver list."
    : "  Dry run complete. Re-run with EXECUTE=true --yes-mainnet to broadcast.");
}

main().catch((e) => { console.error(e); process.exit(1); });
