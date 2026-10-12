/**
 * FlashStack - ALEX STX/ALEX Arb Monitor
 *
 * Watches the ALEX AMM wSTX-v2/ALEX pool for profitable round-trip arb.
 * When profitable: flash-borrows STX from FlashStack, executes via alex-arb-receiver-v5.
 *
 * Pool:     SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.amm-pool-v2-01
 * Token X:  token-wstx-v2  (STX wrapper, 8 decimals; 1 microSTX = 100 units)
 * Token Y:  token-alex     (ALEX governance token, 8 decimals)
 * Factor:   u100000000
 * Receiver: SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.alex-arb-receiver-v5
 *
 * Arb opportunity:
 *   ALEX accrues protocol revenue. Before emissions or governance events it
 *   briefly trades above fair value. Flash-borrow STX, buy ALEX cheap, sell
 *   back for more STX, repay FlashStack (0.05% fee), keep the spread.
 *
 * Usage:
 *   node scripts/monitor-alex-arb.mjs
 *   EXECUTE=true LOAN_STX=50 DEPLOYER_MNEMONIC="..." node scripts/monitor-alex-arb.mjs
 *
 * Environment variables:
 *   DEPLOYER_MNEMONIC  — 24-word mnemonic (required for EXECUTE=true)
 *   EXECUTE            — "true" to auto-execute when profitable (default: dry-run)
 *   LOAN_STX           — loan size in whole STX (default: 10)
 *   INTERVAL_MS        — scan interval in ms (default: 30000)
 *   MIN_PROFIT_STX     — minimum profit threshold in whole STX (default: 0.01)
 *   HIRO_API_KEY       — optional Hiro API key for higher rate limits
 */

import {
  makeContractCall,
  broadcastTransaction,
  PostConditionMode,
  Cl,
  fetchCallReadOnlyFunction,
  cvToJSON,
  getAddressFromPrivateKey,
} from "@stacks/transactions";
import networkPkg from "@stacks/network";
const { STACKS_MAINNET } = networkPkg;
import walletPkg from "@stacks/wallet-sdk";
const { generateWallet } = walletPkg;

const MNEMONIC       = process.env.DEPLOYER_MNEMONIC;
const EXECUTE        = process.env.EXECUTE === "true";
const INTERVAL       = parseInt(process.env.INTERVAL_MS    ?? "30000");
const LOAN_STX_MICRO = parseInt(process.env.LOAN_STX       ?? "10") * 1_000_000;
const MIN_PROFIT     = parseFloat(process.env.MIN_PROFIT_STX ?? "0.01") * 1_000_000;
const HIRO_API_KEY   = process.env.HIRO_API_KEY;

const DEPLOYER = "SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5";
const API      = "https://api.hiro.so";
const EXPLORER = "https://explorer.hiro.so/txid";
const network  = STACKS_MAINNET;

// ALEX AMM
const ALEX_ADDR   = "SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM";
const ALEX_AMM    = "amm-pool-v2-01";
const WSTX_V2     = `${ALEX_ADDR}.token-wstx-v2`;
const ALEX_TOKEN  = `${ALEX_ADDR}.token-alex`;
const ALEX_FACTOR = 100_000_000n;

// Conversion: 1 microSTX = 100 wSTX-v2 fixed-point units
const WSTX_SCALE = 100n;

// FlashStack receiver
const RECEIVER = `${DEPLOYER}.alex-arb-receiver-v5`;

if (EXECUTE && !MNEMONIC) {
  console.error("ERROR: Set DEPLOYER_MNEMONIC to execute transactions");
  process.exit(1);
}

function hiroFetch(url, opts = {}) {
  if (HIRO_API_KEY && typeof url === "string" && url.includes("hiro.so")) {
    opts = { ...opts, headers: { ...opts?.headers, "x-api-key": HIRO_API_KEY } };
  }
  return globalThis.fetch(url, opts);
}

// ── Get ALEX out for given wSTX-v2 in ────────────────────────────────────────
async function getAlexForStx(dxMicro) {
  const dx = BigInt(dxMicro) * WSTX_SCALE; // microSTX -> wSTX-v2 units
  try {
    const r = await fetchCallReadOnlyFunction({
      contractAddress: ALEX_ADDR,
      contractName:    ALEX_AMM,
      functionName:    "get-y-given-x",
      functionArgs:    [
        Cl.principal(WSTX_V2),
        Cl.principal(ALEX_TOKEN),
        Cl.uint(ALEX_FACTOR),
        Cl.uint(dx),
      ],
      network,
      senderAddress: DEPLOYER,
      client: { fetch: hiroFetch },
    });
    const v = cvToJSON(r);
    // Returns (ok uint) or just uint depending on Clarity version
    const val = v?.value?.value ?? v?.value;
    return val ? BigInt(val) : null;
  } catch {
    return null;
  }
}

// ── Get wSTX-v2 out for given ALEX in ────────────────────────────────────────
async function getStxForAlex(dyAlex) {
  try {
    const r = await fetchCallReadOnlyFunction({
      contractAddress: ALEX_ADDR,
      contractName:    ALEX_AMM,
      functionName:    "get-x-given-y",
      functionArgs:    [
        Cl.principal(WSTX_V2),
        Cl.principal(ALEX_TOKEN),
        Cl.uint(ALEX_FACTOR),
        Cl.uint(dyAlex),
      ],
      network,
      senderAddress: DEPLOYER,
      client: { fetch: hiroFetch },
    });
    const v = cvToJSON(r);
    const val = v?.value?.value ?? v?.value;
    return val ? BigInt(val) : null;
  } catch {
    return null;
  }
}

// ── Get pool balances ─────────────────────────────────────────────────────────
async function getPoolBalances() {
  try {
    const r = await fetchCallReadOnlyFunction({
      contractAddress: ALEX_ADDR,
      contractName:    ALEX_AMM,
      functionName:    "get-balances",
      functionArgs:    [
        Cl.principal(WSTX_V2),
        Cl.principal(ALEX_TOKEN),
        Cl.uint(ALEX_FACTOR),
      ],
      network,
      senderAddress: DEPLOYER,
      client: { fetch: hiroFetch },
    });
    const v = cvToJSON(r)?.value?.value;
    if (!v) return null;
    return {
      balX: BigInt(v["balance-x"]?.value ?? 0), // wSTX-v2 units (8 dec)
      balY: BigInt(v["balance-y"]?.value ?? 0), // ALEX units    (8 dec)
    };
  } catch {
    return null;
  }
}

// ── Get ALEX spot price in STX ────────────────────────────────────────────────
// Uses pool balances directly: price = balX / balY (in wSTX-v2 per ALEX)
// Both tokens have 8 decimals so ratio gives full STX per full ALEX.
function spotPrice(balX, balY) {
  if (!balY || balY === 0n) return null;
  // wSTX-v2 units per ALEX unit (both 8 dec)
  // Multiply numerator by 1e8 to preserve precision
  return Number(balX * 100_000_000n / balY) / 1e8;
}

// ── Check arb opportunity ─────────────────────────────────────────────────────
async function checkAlexArb(loanMicro) {
  const fee     = BigInt(Math.max(1, Math.floor(loanMicro * 5 / 10000)));
  const gasCost = 300_000n;
  const owed    = BigInt(loanMicro) + fee;

  // Leg 1: how much ALEX do we get for loanMicro STX?
  const alexOut = await getAlexForStx(loanMicro);
  if (!alexOut || alexOut === 0n) return null;

  // Leg 2: how much wSTX-v2 do we get back for that ALEX?
  const stxBackWstx = await getStxForAlex(alexOut);
  if (!stxBackWstx || stxBackWstx === 0n) return null;

  // Convert wSTX-v2 units back to microSTX
  const stxBackMicro = stxBackWstx / WSTX_SCALE;

  const profit = stxBackMicro - owed - gasCost;

  return {
    loanMicro,
    alexOut,
    stxBackMicro,
    fee,
    gasCost,
    owed,
    profit,
    profitable: profit > 0n && profit >= BigInt(Math.floor(MIN_PROFIT)),
  };
}

// ── Broadcast one signed tx, return its txid ────────────────────────────────────
async function broadcastOne(tx) {
  const raw  = tx.serialize();
  const body = typeof raw === "string" ? Buffer.from(raw.replace(/^0x/, ""), "hex") : raw;
  const res  = await fetch(`${API}/v2/transactions`, {
    method: "POST", headers: { "Content-Type": "application/octet-stream" }, body,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Non-JSON: ${text.slice(0, 200)}`); }
  if (data?.error) throw new Error(`${data.error} -- ${data.reason ?? ""}`);
  return typeof data === "string" ? data : data.txid;
}

// ── Execute flash loan ────────────────────────────────────────────────────────
// alex-arb-receiver-v5 requires min-alex-out to be freshly set before every
// call -- it auto-resets to 0 after each use specifically to force
// re-calibration, so a flash-loan call alone (with no prior set-min-alex-out)
// either reverts with ERR-MIN-ALEX-UNSET, or -- if a stale nonzero value is
// still sitting there from an earlier run -- fails Leg 1's own slippage
// check against whatever the CURRENT quote actually is. Confirmed live:
// min-alex-out on-chain right now is a leftover value from some earlier
// setup (6,890,524,177,442), unrelated to this script's current LOAN_STX.
async function executeAlexArb(loanMicro, alexOut) {
  const wallet = await generateWallet({ secretKey: MNEMONIC, password: "" });
  const pk     = wallet.accounts[0].stxPrivateKey;
  // Signer address is derived from the mnemonic -- after the 2026-06-12 wallet
  // rotation this is no longer the contract deployer address. Must be
  // alex-arb-receiver-v5's current contract-owner (confirmed live:
  // SPR9PQAN..., the rotated admin wallet) or set-min-alex-out below fails
  // with ERR-NOT-OWNER before the flash loan is ever attempted.
  const signer = getAddressFromPrivateKey(pk, "mainnet");
  let   nonce  = await fetch(`${API}/v2/accounts/${signer}?proof=0`)
    .then(r => r.json()).then(d => d.nonce);

  // 1% slippage tolerance off the quote this same scan just fetched --
  // matches the receiver's own min-profit/max-fee-bp philosophy of a real,
  // computed guard rather than an arbitrary placeholder.
  const minAlexOut = (alexOut * 99n) / 100n;
  console.log(`  Setting min-alex-out: ${Number(minAlexOut) / 1e8} ALEX (1% below quoted ${Number(alexOut) / 1e8})`);

  const setMinTx = await makeContractCall({
    contractAddress:   DEPLOYER,
    contractName:      "alex-arb-receiver-v5",
    functionName:      "set-min-alex-out",
    functionArgs:      [Cl.uint(minAlexOut)],
    senderKey:         pk,
    network,
    postConditionMode: PostConditionMode.Allow,
    anchorMode:        1,
    nonce,
    fee:               50_000,
  });
  const setMinTxid = await broadcastOne(setMinTx);
  console.log(`  set-min-alex-out broadcast: ${EXPLORER}/0x${setMinTxid}?chain=mainnet`);
  nonce += 1;

  console.log(`  Executing ${loanMicro / 1e6} STX ALEX arb flash loan...`);

  const tx = await makeContractCall({
    contractAddress:   DEPLOYER,
    contractName:      "flashstack-stx-core",
    functionName:      "flash-loan",
    functionArgs:      [Cl.uint(loanMicro), Cl.principal(RECEIVER)],
    senderKey:         pk,
    network,
    postConditionMode: PostConditionMode.Allow,
    anchorMode:        1,
    nonce,
    fee:               300_000,
  });

  let txid;
  try {
    txid = await broadcastOne(tx);
  } catch (e) {
    console.error(`  FAILED: ${e.message}`);
    return null;
  }
  console.log(`  Broadcast: ${txid}`);
  console.log(`  Explorer:  ${EXPLORER}/0x${txid}?chain=mainnet`);
  return txid;
}

// ── Main scan ─────────────────────────────────────────────────────────────────
async function scan() {
  const timestamp = new Date().toISOString();
  console.log(`\n[${timestamp}] Scanning ALEX STX/ALEX pool...`);

  const balances = await getPoolBalances();
  if (balances) {
    const price = spotPrice(balances.balX, balances.balY);
    const poolStx  = Number(balances.balX) / 1e8;
    const poolAlex = Number(balances.balY) / 1e8;
    if (price !== null) {
      console.log(`  Pool liquidity: ${poolStx.toFixed(0)} wSTX-v2 | ${poolAlex.toFixed(0)} ALEX`);
      console.log(`  Spot price:     1 ALEX = ${price.toFixed(6)} STX`);
    }
  }

  const arb = await checkAlexArb(LOAN_STX_MICRO);
  if (!arb) {
    console.log("  Could not fetch ALEX pool quote — rate-limited or pool paused");
    return;
  }

  const profitStx = Number(arb.profit) / 1e6;
  const alexOut   = Number(arb.alexOut) / 1e8;
  const stxBack   = Number(arb.stxBackMicro) / 1e6;

  console.log(`\n  ALEX ARB (loan: ${arb.loanMicro / 1e6} STX)`);
  console.log(`  Leg 1 out:   ${alexOut.toFixed(6)} ALEX`);
  console.log(`  Leg 2 back:  ${stxBack.toFixed(6)} STX`);
  console.log(`  Flash fee:   ${Number(arb.fee) / 1e6} STX (0.05%)`);
  console.log(`  Gas est:     ${Number(arb.gasCost) / 1e6} STX`);
  console.log(`  Total owed:  ${Number(arb.owed) / 1e6} STX`);
  console.log(`  Est. profit: ${profitStx.toFixed(6)} STX`);

  if (arb.profitable) {
    console.log(`\n  *** ARB OPPORTUNITY *** +${profitStx.toFixed(4)} STX`);
    console.log(`  ALEX trading above fair value — round-trip profitable`);
    if (EXECUTE) {
      await executeAlexArb(arb.loanMicro, arb.alexOut);
    } else {
      console.log(`  (dry-run -- set EXECUTE=true DEPLOYER_MNEMONIC="..." to trigger)`);
    }
  } else {
    const deficit = (Number(arb.owed) + Number(arb.gasCost) - Number(arb.stxBackMicro)) / 1e6;
    console.log(`  No arb -- deficit ${deficit.toFixed(6)} STX (ALEX near fair value)`);
  }
}

async function main() {
  console.log("================================================");
  console.log("  FlashStack - ALEX STX/ALEX Arb Monitor");
  console.log("================================================");
  console.log(`  Mode:       ${EXECUTE ? "LIVE EXECUTION" : "dry-run (monitoring only)"}`);
  console.log(`  Loan size:  ${LOAN_STX_MICRO / 1e6} STX`);
  console.log(`  Min profit: ${MIN_PROFIT / 1e6} STX`);
  console.log(`  Interval:   ${INTERVAL / 1000}s`);
  console.log(`  Receiver:   ${RECEIVER}`);
  console.log(`\n  Pool:       ${ALEX_ADDR}.${ALEX_AMM}`);
  console.log(`  Token X:    token-wstx-v2  (factor u${ALEX_FACTOR})`);
  console.log(`  Token Y:    token-alex`);
  console.log(`\n  Tips:`);
  console.log(`    EXECUTE=true LOAN_STX=100 DEPLOYER_MNEMONIC="..." -- live execution`);
  console.log(`    LOAN_STX=500                                       -- larger loan, more profit`);
  console.log(`    MIN_PROFIT_STX=0.1                                 -- raise profit threshold`);
  console.log(`    INTERVAL_MS=10000                                  -- scan every 10s`);
  console.log(`\n  Watching for ALEX to trade above fair value...`);
  console.log(`  Best opportunities: before emissions events, governance votes,`);
  console.log(`  or when buy pressure builds from staking reward cycles.\n`);

  await scan();
  setInterval(scan, INTERVAL);
}

main().catch(e => { console.error("\nFATAL:", e.message); process.exit(1); });
