#!/usr/bin/env node
/**
 * FlashStack — Zest Liquidation Keeper
 *
 * Wires scan-zest-positions.mjs's verified candidates into
 * zest-v2-liquidation-receiver.clar's set-target / set-price-feed /
 * flash-loan execution flow. Reuses the scanner's own pricing and
 * eligibility functions directly (imported, not re-derived) so the two
 * scripts can never silently disagree about who's actually liquidatable.
 *
 * Mode mapping — keyed on "<collateral-asset-id>:<debt-asset-id>":
 *   1:0 -> mode 4  (v0-vault-stx collateral  / wSTX debt,   STX flash, no swap)
 *   3:2 -> mode 5  (v0-vault-sbtc collateral / sBTC debt,   sBTC flash, no swap)
 * Collateral is always the VAULT-SHARE asset id (1 or 3), never the raw
 * underlying (0 or 2) -- confirmed empirically that's what real positions
 * actually hold (see the receiver's own header + PR #98's fix history).
 * Any other collateral/debt pair the scanner finds has no supported mode
 * and is skipped, logged, not guessed at.
 *
 * Modes 1-3 (sBTC-collateral positions with USDCx/USDH/wSTX debt, needing
 * a sBTC->STX swap) are NOT mapped here at all -- found independently
 * while building this keeper, verified directly against live chain state:
 * the receiver's VELAR-POOL-SBTC-STX constant was never the real sBTC/STX
 * pool (it's an unrelated wstx/meme-coin pool), and the only wstx-paired
 * pool with "sbtc" in its name trades a different sBTC contract than the
 * one Zest's vault actually redeems. The receiver itself now rejects
 * arming modes 1-3 (ERR-NO-SWAP-ROUTE). Until a real swap route is found
 * and wired in on the receiver side, this keeper only ever proposes modes
 * 4/5 -- a position whose largest asset pair needs a swap is reported as
 * unsupported, not force-fit into a mode that would just revert.
 *
 * A position can hold several collateral and/or debt assets at once (the
 * bitmask model allows it); this keeper only targets the single
 * largest-USD collateral asset and largest-USD debt asset per candidate,
 * same conservative single-pair scope as every mode the receiver
 * implements. A multi-asset position is only ever partially covered.
 *
 * Loan sizing: exact for both supported modes -- the flash-borrowed asset
 * IS the debt payment, 1:1, no estimation involved.
 *
 * Known blockers to live execution right now (flagged loudly, not
 * silently worked around):
 *   - zest-v2-liquidation-receiver is NOT YET DEPLOYED (PR #98, open).
 *   - Mode 4 prices wSTX debt via Lazer feed 45 (STX); the active Lazer
 *     plan (Demo) does not grant that feed -- confirmed directly, see
 *     project memory. Mode 5 only needs feed 1 (sBTC), which Demo grants,
 *     so it's not blocked by this.
 *   - The current live scan (scan-zest-positions.mjs) finds 0 liquidatable
 *     accounts -- this keeper has nothing to act on today regardless.
 *
 * Usage:
 *   LAZER_TOKEN="..." node scripts/keeper-zest-liquidations.mjs
 *   EXECUTE=true LAZER_TOKEN="..." DEPLOYER_MNEMONIC="..." node scripts/keeper-zest-liquidations.mjs
 *
 * Environment variables:
 *   LAZER_TOKEN         — required (same account used by the scanner)
 *   DEPLOYER_MNEMONIC   — 24-word mnemonic, must own the receiver contract (required for EXECUTE=true)
 *   EXECUTE             — "true" to broadcast real transactions (default: dry-run)
 *   MAX_ACCOUNTS        — cap accounts scanned, same as scan-zest-positions.mjs
 *   STX_PRICE_USD8_FALLBACK — testing-only escape hatch, same as the scanner (fails closed without it)
 *   HIRO_API_KEY        — optional, raises the Hiro rate limit
 */

import { Cl, makeContractCall, PostConditionMode, getAddressFromPrivateKey } from "@stacks/transactions";
import networkPkg from "@stacks/network";
const { STACKS_MAINNET } = networkPkg;
import walletPkg from "@stacks/wallet-sdk";
const { generateWallet } = walletPkg;
import { PythLazerClient } from "@pythnetwork/pyth-lazer-sdk";

import {
  ASSET_BY_ID,
  DEBT_OFFSET,
  resolveAllPrices,
  getNr,
  lookup,
  maskHasDebt,
  evaluateAccount,
} from "./scan-zest-positions.mjs";

const API      = "https://api.hiro.so";
const EXPLORER = "https://explorer.hiro.so/txid";
const network  = STACKS_MAINNET;

const MNEMONIC      = process.env.DEPLOYER_MNEMONIC;
const EXECUTE       = process.env.EXECUTE === "true";
const LAZER_TOKEN   = process.env.LAZER_TOKEN;
const MAX_ACCOUNTS  = process.env.MAX_ACCOUNTS;
const HIRO_API_KEY  = process.env.HIRO_API_KEY;

if (EXECUTE && !MNEMONIC) {
  console.error("ERROR: EXECUTE=true requires DEPLOYER_MNEMONIC (must own the receiver contract)");
  process.exit(1);
}

// Same deployer as every other FlashStack-controlled receiver this session.
const DEPLOYER       = "SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5";
const RECEIVER_NAME  = "zest-v2-liquidation-receiver";
const RECEIVER       = `${DEPLOYER}.${RECEIVER_NAME}`;
const STX_CORE_NAME  = "flashstack-stx-core";
const SBTC_CORE_NAME = "flashstack-sbtc-core";

// "<collateral-asset-id>:<debt-asset-id>" -> receiver mode. Only modes
// 4/5 -- modes 1-3 need a sBTC->STX swap route that doesn't exist right
// now (see header). The receiver itself rejects arming them.
const MODE_MAP = {
  "1:0": { mode: 4, core: "stx",  label: "STX-share collateral / wSTX debt (no swap)" },
  "3:2": { mode: 5, core: "sbtc", label: "sBTC-share collateral / sBTC debt (no swap)" },
};
const NEEDS_STX_FEED_MODES = new Set([4]);

// Lazer feed id per ASSET_TABLE priceSource. USDH has no Lazer feed (DIA
// oracle, read internally by v0-8-market) so it's intentionally absent --
// confirmed live, see scan-zest-positions.mjs's own header.
const LAZER_FEED_BY_SOURCE = { stx: 45, sbtc: 1, usdc: 7 };

// ── Pick the single largest-USD collateral/debt pair for a candidate ──────
function pickMode(candidate) {
  const topColl = [...candidate.collateralDetail].sort((a, b) => (a.usd < b.usd ? 1 : -1))[0];
  const topDebt = [...candidate.debtDetail].sort((a, b) => (a.usd < b.usd ? 1 : -1))[0];
  if (!topColl || !topDebt) return { unsupported: true, reason: "no collateral or debt detail" };

  const key    = `${topColl.aid}:${topDebt.aid}`;
  const mapped = MODE_MAP[key];
  if (!mapped) {
    return {
      unsupported: true,
      reason: `no receiver mode for collateral asset ${topColl.aid} (${topColl.asset}) + debt asset ${topDebt.aid} (${topDebt.asset})`,
      topColl, topDebt,
    };
  }
  return { ...mapped, topColl, topDebt };
}

// ── Fetch one signed Lazer update in "evm" format, covering the given feeds ─
// Mirrors the scanner's fetchLazerFeeds isolation pattern (a single feed
// lacking entitlement throws inside the pool's dedupeHandler, not as a
// subscribe() rejection), but requests the submittable signed buffer
// (formats: ["evm"]) instead of parsed numeric values -- this is what
// set-price-feed actually needs, confirmed against the receiver's own
// header and proven end-to-end earlier against pyth-lazer-decoder-v1.
function fetchLazerEvmBuffer(feedIds) {
  return new Promise((resolve, reject) => {
    const unhandled = (e) => { cleanup(); reject(e?.reason ?? e); };
    let client;
    const cleanup = () => {
      process.removeListener("unhandledRejection", unhandled);
      try { client?.shutdown(); } catch {}
    };
    process.once("unhandledRejection", unhandled);
    const timer = setTimeout(() => { cleanup(); reject(new Error("timed out waiting for Lazer evm buffer " + feedIds)); }, 15000);

    PythLazerClient.create({
      token: LAZER_TOKEN,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      webSocketPoolConfig: {
        urls: ["wss://pyth-lazer-0.dourolabs.app/v1/stream"],
        numConnections: 1,
        onError: () => {},
      },
    }).then((c) => {
      client = c;
      client.addMessageListener((event) => {
        if (event.type !== "json") return;
        const message = event.value;
        if (message.type !== "streamUpdated") return;
        const evm = message.evm;
        // jsonBinaryEncoding is pinned to "hex" below (its default is
        // undocumented in the SDK's own types -- not assumed), so evm.data
        // is always a hex string here, never base64.
        if (!evm?.data) return;
        clearTimeout(timer);
        cleanup();
        resolve(evm.data.startsWith("0x") ? evm.data.slice(2) : evm.data);
      });
      client.subscribe({
        type: "subscribe", subscriptionId: 1,
        priceFeedIds: feedIds,
        properties: ["price", "exponent"],
        formats: ["evm"],
        deliveryFormat: "json",
        jsonBinaryEncoding: "hex",
        channel: "fixed_rate@200ms",
      });
    });
  });
}

// ── Broadcast one signed tx, return its txid (same helper as the ALEX/Bitflow monitors) ──
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

// ── Execute one liquidation: set-target -> set-price-feed -> flash-loan ───
async function executeLiquidation(candidate, decision) {
  const wallet = await generateWallet({ secretKey: MNEMONIC, password: "" });
  const pk     = wallet.accounts[0].stxPrivateKey;
  const signer = getAddressFromPrivateKey(pk, "mainnet");
  let   nonce  = await fetch(`${API}/v2/accounts/${signer}?proof=0`).then(r => r.json()).then(d => d.nonce);

  const debtAmount = decision.topDebt.actual;

  // 4th arg (amount) is the exact flash-loan size this liquidation is
  // armed for -- the receiver's own execute-stx-flash/execute-sbtc-flash
  // now assert the real flash-loan amount matches this exactly
  // (ERR-AMOUNT-MISMATCH otherwise), closing the gap where
  // flashstack-stx-core.flash-loan has no caller restriction at all and
  // anyone could otherwise fire an already-armed target with an amount
  // of their own choosing (see the receiver's own header SECURITY note).
  console.log(`  1/3 set-target(${candidate.account}, ${debtAmount}, mode ${decision.mode}, amount ${decision.loanAmount})`);
  const setTargetTx = await makeContractCall({
    contractAddress: DEPLOYER, contractName: RECEIVER_NAME, functionName: "set-target",
    functionArgs: [Cl.principal(candidate.account), Cl.uint(debtAmount), Cl.uint(decision.mode), Cl.uint(decision.loanAmount)],
    senderKey: pk, network, postConditionMode: PostConditionMode.Allow, anchorMode: 1, nonce, fee: 50_000,
  });
  console.log(`      ${EXPLORER}/0x${await broadcastOne(setTargetTx)}?chain=mainnet`);
  nonce += 1;

  // Feeds needed = union of this account's actual collateral + debt price
  // sources (NOT just this pair) -- liquidate() reprices the WHOLE
  // account's collateral/debt stack to verify LTV, confirmed directly from
  // its own health-check formula (see scan-zest-positions.mjs's header).
  const sources = new Set();
  for (const d of [...candidate.collateralDetail, ...candidate.debtDetail]) {
    const asset = ASSET_BY_ID[d.aid];
    if (asset && LAZER_FEED_BY_SOURCE[asset.priceSource]) sources.add(LAZER_FEED_BY_SOURCE[asset.priceSource]);
  }
  const feedIds = [...sources];
  console.log(`  2/3 fetching fresh signed Lazer update for feeds [${feedIds.join(", ")}]...`);
  const evmHex = await fetchLazerEvmBuffer(feedIds);
  const setFeedTx = await makeContractCall({
    contractAddress: DEPLOYER, contractName: RECEIVER_NAME, functionName: "set-price-feed",
    functionArgs: [Cl.bufferFromHex(evmHex)],
    senderKey: pk, network, postConditionMode: PostConditionMode.Allow, anchorMode: 1, nonce, fee: 50_000,
  });
  console.log(`      ${EXPLORER}/0x${await broadcastOne(setFeedTx)}?chain=mainnet`);
  nonce += 1;

  const loanAmount = decision.loanAmount;
  const coreName   = decision.core === "sbtc" ? SBTC_CORE_NAME : STX_CORE_NAME;
  const flashFn    = "flash-loan";
  console.log(`  3/3 ${coreName}.${flashFn}(${loanAmount}, ${RECEIVER_NAME})`);
  const flashTx = await makeContractCall({
    contractAddress: DEPLOYER, contractName: coreName, functionName: flashFn,
    functionArgs: [Cl.uint(loanAmount), Cl.contractPrincipal(DEPLOYER, RECEIVER_NAME)],
    senderKey: pk, network, postConditionMode: PostConditionMode.Allow, anchorMode: 1, nonce, fee: 300_000,
  });
  let txid;
  try {
    txid = await broadcastOne(flashTx);
  } catch (e) {
    console.error(`      FAILED: ${e.message}`);
    return null;
  }
  console.log(`      Broadcast: ${EXPLORER}/0x${txid}?chain=mainnet`);
  return txid;
}

// ── Decide the loan amount for a mapped mode ───────────────────────────────
function sizeLoan(decision) {
  // Only modes 4/5 are ever proposed (see MODE_MAP) -- both are no-swap,
  // so the flash-borrowed asset IS the debt payment, 1:1, exactly.
  return decision.topDebt.actual;
}

async function main() {
  console.log("==========================================================");
  console.log("  FlashStack — Zest Liquidation Keeper");
  console.log("==========================================================");
  console.log(`  Mode:     ${EXECUTE ? "LIVE EXECUTION" : "dry-run (mapping only)"}`);
  console.log(`  Receiver: ${RECEIVER}  (NOT YET DEPLOYED as of this writing -- see PR #98)`);
  console.log();

  console.log("Fetching live prices (Lazer + DIA)...");
  const prices = await resolveAllPrices();

  const realNr = await getNr();
  const nr = MAX_ACCOUNTS ? (BigInt(MAX_ACCOUNTS) < realNr ? BigInt(MAX_ACCOUNTS) : realNr) : realNr;
  console.log(`Scanning ${nr}${nr < realNr ? ` of ${realNr}` : ""} registered accounts...`);

  const candidates = [];
  for (let id = 0n; id < nr; id++) {
    const entry = await lookup(id);
    if (!entry) continue;
    const mask = BigInt(entry.mask.value);
    if (!maskHasDebt(mask)) continue;
    const account = entry.account.value;
    try {
      const result = await evaluateAccount(id, account, mask, prices);
      if (result?.liquidatable) candidates.push(result);
    } catch (e) {
      console.error(`  WARN: account ${id} failed to evaluate, skipped: ${e.message}`);
    }
    if (id % 100n === 0n) process.stdout.write(`\r  ...${id}/${nr}`);
  }
  console.log(`\r  done: ${candidates.length} liquidatable candidate(s) found`);

  if (candidates.length === 0) {
    console.log("\nNothing to do -- no liquidatable accounts right now.");
    return;
  }

  for (const candidate of candidates) {
    console.log(`\n--- ${candidate.account} ---`);
    console.log(`  collateral-usd: $${(Number(candidate.collateralUsd) / 1e8).toFixed(2)}  debt-usd: $${(Number(candidate.debtUsd) / 1e8).toFixed(2)}`);

    const decision = pickMode(candidate);
    if (decision.unsupported) {
      console.log(`  SKIP -- ${decision.reason}`);
      continue;
    }
    decision.loanAmount = sizeLoan(decision);
    console.log(`  Mode ${decision.mode}: ${decision.label}`);
    console.log(`  Target debt: ${decision.topDebt.actual} raw units of ${decision.topDebt.asset}`);
    console.log(`  Loan size:   ${decision.loanAmount} ${decision.core === "sbtc" ? "sat sBTC" : "microSTX"} (exact -- no-swap mode)`);
    if (NEEDS_STX_FEED_MODES.has(decision.mode)) {
      console.log(`  NOTE: mode ${decision.mode} prices wSTX debt via Lazer feed 45 (STX) -- blocked on`);
      console.log(`        the current Demo plan's entitlement gap (see project memory).`);
    }

    if (EXECUTE) {
      await executeLiquidation(candidate, decision);
    } else {
      console.log(`  (dry-run -- set EXECUTE=true DEPLOYER_MNEMONIC="..." to trigger)`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
