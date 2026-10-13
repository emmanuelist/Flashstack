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
 *     project memory. Gated behind FEED_45_AVAILABLE (default false) so
 *     the keeper skips mode 4 candidates entirely rather than arming a
 *     target it then can't fetch a feed for. Mode 5 only needs feed 1
 *     (sBTC), which Demo grants, so it's not gated.
 *   - The current live scan (scan-zest-positions.mjs) finds 0 liquidatable
 *     accounts -- this keeper has nothing to act on today regardless.
 *
 * Usage:
 *   LAZER_TOKEN="..." node scripts/keeper-zest-liquidations.mjs                  -- single scan
 *   WATCH=true LAZER_TOKEN="..." node scripts/keeper-zest-liquidations.mjs       -- loop every INTERVAL_MS, same shape as monitor-alex-arb.mjs
 *   EXECUTE=true WATCH=true LAZER_TOKEN="..." KEEPER_MNEMONIC="..." node scripts/keeper-zest-liquidations.mjs
 *
 * Environment variables:
 *   LAZER_TOKEN         — required (same account used by the scanner, for sBTC/USDC feeds)
 *   WATCH               — "true" to loop forever instead of scanning once (default: single scan)
 *   INTERVAL_MS         — loop interval in ms when WATCH=true (default: 300000 = 5 min)
 *   KEEPER_MNEMONIC     — 24-word mnemonic for the dedicated keeper wallet that OWNS the
 *                         receiver contract (required for EXECUTE=true; renamed from
 *                         DEPLOYER_MNEMONIC -- this should be a narrow keeper key, not the
 *                         deployer's, per #98's ownership-handoff plan). Checked live against
 *                         the receiver's own get-owner() before anything is broadcast.
 *   FEED_45_AVAILABLE   — "true" once the Lazer plan is upgraded past Demo (default: false,
 *                         mode 4 candidates are skipped, not attempted)
 *   EXECUTE             — "true" to broadcast real transactions (default: dry-run)
 *   MAX_ACCOUNTS        — cap accounts scanned, same as scan-zest-positions.mjs
 *   HIRO_API_KEY        — optional, raises the Hiro rate limit
 */

import { Cl, Pc, makeContractCall, PostConditionMode, getAddressFromPrivateKey } from "@stacks/transactions";
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
  readOnly,
  uw,
} from "./scan-zest-positions.mjs";

const API      = "https://api.hiro.so";
const EXPLORER = "https://explorer.hiro.so/txid";
const network  = STACKS_MAINNET;

const MNEMONIC          = process.env.KEEPER_MNEMONIC;
const EXECUTE           = process.env.EXECUTE === "true";
const LAZER_TOKEN       = process.env.LAZER_TOKEN;
const MAX_ACCOUNTS      = process.env.MAX_ACCOUNTS;
const HIRO_API_KEY      = process.env.HIRO_API_KEY;
const WATCH             = process.env.WATCH === "true";
const INTERVAL_MS       = parseInt(process.env.INTERVAL_MS ?? "300000"); // 5 min default -- a full scan is 1,334 accounts, no reason to hammer Hiro faster
const FEED_45_AVAILABLE = process.env.FEED_45_AVAILABLE === "true";

if (EXECUTE && !MNEMONIC) {
  console.error("ERROR: EXECUTE=true requires KEEPER_MNEMONIC (must own the receiver contract)");
  process.exit(1);
}

// Same deployer as every other FlashStack-controlled receiver this session.
const DEPLOYER       = "SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5";
const RECEIVER_NAME  = "zest-v2-liquidation-receiver";
const RECEIVER       = `${DEPLOYER}.${RECEIVER_NAME}`;
const STX_CORE_NAME  = "flashstack-stx-core";
const SBTC_CORE_NAME = "flashstack-sbtc-core";
const SBTC_ID        = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const SBTC_ASSET     = "sbtc-token";

// The three fees already used below, named so the profit floor (set once
// per scan pass, see setMinProfitFloors) can't silently drift out of sync
// with what an attempt actually costs.
const FEE_SET_TARGET = 50_000n;
const FEE_SET_FEED   = 50_000n;
const FEE_FLASH      = 300_000n;
const FEE_TOTAL_USTX = FEE_SET_TARGET + FEE_SET_FEED + FEE_FLASH; // ~0.4 STX/attempt
const MIN_PROFIT_MARGIN_USTX = FEE_TOTAL_USTX * 2n; // require profit to clear 2x the attempt's own gas cost

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

    // error/warn/onError used to be muted entirely, same bug fixed in the
    // scanner's fetchLazerFeeds -- it hid the real cause of a connection
    // failure (auth rejection, DNS, TLS, protocol-level issue) behind a
    // generic "timed out" message. Left debug/info muted (too noisy).
    PythLazerClient.create({
      token: LAZER_TOKEN,
      logger: {
        debug: () => {}, info: () => {},
        warn: (...a) => console.error("  [Lazer warn]", ...a),
        error: (...a) => console.error("  [Lazer error]", ...a),
      },
      webSocketPoolConfig: {
        urls: ["wss://pyth-lazer-0.dourolabs.app/v1/stream"],
        numConnections: 1,
        onError: (e) => console.error("  [Lazer pool onError]", e?.message ?? e),
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
    }).catch((e) => {
      // Explicit catch on PythLazerClient.create() itself, not just the
      // unhandledRejection safety net above -- same fix as the scanner's
      // fetchLazerFeeds, more direct, same reject path.
      cleanup();
      reject(e);
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

// Hiro's "confirmed nonce" (/v2/accounts) only reflects anchored state --
// re-reading it for a second candidate in the same pass collides with the
// first candidate's still-pending transactions. possible_next_nonce
// accounts for mempool-pending txs too, and the caller carries it forward
// locally across every tx in the pass rather than re-fetching.
async function getPossibleNextNonce(address) {
  const res = await fetch(`${API}/extended/v1/address/${address}/nonces`).then((r) => r.json());
  return res.possible_next_nonce;
}

// Sets both profit floors once per scan pass (they're standing receiver
// vars, not reset after use -- no need to repeat this per candidate).
// Converts the same ~0.4 STX/attempt gas cost into both STX and sBTC
// terms at current prices, with a 2x margin, so a liquidation smaller
// than what it costs to run can't execute at a net loss. The contract
// default (u1, "any nonzero profit") is otherwise far too permissive.
async function setMinProfitFloors(pk, nonce, prices) {
  const stxPrice1e8  = prices[0]; // wstx, USD x 1e8 per whole STX
  const sbtcPrice1e8 = prices[2]; // sbtc-token, USD x 1e8 per whole sBTC
  if (sbtcPrice1e8 === 0n || stxPrice1e8 === 0n) {
    throw new Error(`setMinProfitFloors: zero price from resolveAllPrices (stx=${stxPrice1e8}, sbtc=${sbtcPrice1e8}) -- refusing to divide by it`);
  }
  const feeUsdX1e8   = (MIN_PROFIT_MARGIN_USTX * stxPrice1e8) / 1_000_000n; // wstx: 6 decimals
  const minProfitSbtc = (feeUsdX1e8 * 100_000_000n) / sbtcPrice1e8;         // sbtc: 8 decimals

  console.log(`  Setting profit floors: min-profit-stx=${MIN_PROFIT_MARGIN_USTX} uSTX, min-profit-sbtc=${minProfitSbtc} sats (2x this pass's ~${FEE_TOTAL_USTX} uSTX gas cost)`);

  const tx1 = await makeContractCall({
    contractAddress: DEPLOYER, contractName: RECEIVER_NAME, functionName: "set-min-profit-stx",
    functionArgs: [Cl.uint(MIN_PROFIT_MARGIN_USTX)],
    senderKey: pk, network, postConditionMode: PostConditionMode.Deny, anchorMode: 1, nonce, fee: FEE_SET_TARGET,
  });
  console.log(`    ${EXPLORER}/0x${await broadcastOne(tx1)}?chain=mainnet`);
  nonce += 1;

  const tx2 = await makeContractCall({
    contractAddress: DEPLOYER, contractName: RECEIVER_NAME, functionName: "set-min-profit-sbtc",
    functionArgs: [Cl.uint(minProfitSbtc)],
    senderKey: pk, network, postConditionMode: PostConditionMode.Deny, anchorMode: 1, nonce, fee: FEE_SET_TARGET,
  });
  console.log(`    ${EXPLORER}/0x${await broadcastOne(tx2)}?chain=mainnet`);
  nonce += 1;
  return nonce;
}

// ── Execute one liquidation: fetch feed -> set-target -> set-price-feed -> flash-loan ──
// pk/signer are derived once per scan pass (see scan()), not re-derived
// here; nonce is threaded through so a second candidate in the same pass
// continues from where the first one left off instead of colliding.
async function executeLiquidation(pk, signer, nonce, candidate, decision) {
  const debtAmount = decision.topDebt.actual;

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

  // Fetch the feed BEFORE arming, not after -- set-target used to broadcast
  // first, so a feed fetch that timed out (or, for mode 4, was never going
  // to succeed on the Demo plan) left the receiver armed with a target and
  // nothing behind it, paying set-target's fee for nothing every cycle.
  console.log(`  1/3 fetching fresh signed Lazer update for feeds [${feedIds.join(", ")}]...`);
  const evmHex = await fetchLazerEvmBuffer(feedIds);

  // 4th arg (amount) is the exact flash-loan size this liquidation is
  // armed for -- the receiver's own execute-stx-flash/execute-sbtc-flash
  // now assert the real flash-loan amount matches this exactly
  // (ERR-AMOUNT-MISMATCH otherwise), closing the gap where
  // flashstack-stx-core.flash-loan has no caller restriction at all and
  // anyone could otherwise fire an already-armed target with an amount
  // of their own choosing (see the receiver's own header SECURITY note).
  // Deny mode, no conditions -- neither call moves any asset, so any
  // unexpected transfer here should abort the tx rather than be allowed.
  console.log(`  2/3 set-target(${candidate.account}, ${debtAmount}, mode ${decision.mode}, amount ${decision.loanAmount})`);
  const setTargetTx = await makeContractCall({
    contractAddress: DEPLOYER, contractName: RECEIVER_NAME, functionName: "set-target",
    functionArgs: [Cl.principal(candidate.account), Cl.uint(debtAmount), Cl.uint(decision.mode), Cl.uint(decision.loanAmount)],
    senderKey: pk, network, postConditionMode: PostConditionMode.Deny, anchorMode: 1, nonce, fee: FEE_SET_TARGET,
  });
  console.log(`      ${EXPLORER}/0x${await broadcastOne(setTargetTx)}?chain=mainnet`);
  nonce += 1;

  const setFeedTx = await makeContractCall({
    contractAddress: DEPLOYER, contractName: RECEIVER_NAME, functionName: "set-price-feed",
    functionArgs: [Cl.bufferFromHex(evmHex)],
    senderKey: pk, network, postConditionMode: PostConditionMode.Deny, anchorMode: 1, nonce, fee: FEE_SET_FEED,
  });
  try {
    console.log(`      ${EXPLORER}/0x${await broadcastOne(setFeedTx)}?chain=mainnet`);
  } catch (e) {
    // set-target already landed at this point -- the receiver is armed
    // with a target but no price feed behind it. Acceptable: the armed
    // amount is bound to this exact loan size (see set-target's own
    // comment), so a stranger firing flash-loan against it still just
    // fails inside the receiver with no price feed set. But this pass
    // aborts here, so say so rather than let the thrown error alone
    // explain why the rest of toExecute never ran.
    console.error(`  ABORT: set-price-feed failed after set-target landed (${e.message}). Receiver is armed for ${candidate.account} with no feed behind it -- safe (amount-bound, next flash-loan attempt just fails), but the rest of this pass's candidates are skipped.`);
    throw e;
  }
  nonce += 1;

  const loanAmount = decision.loanAmount;
  const coreName   = decision.core === "sbtc" ? SBTC_CORE_NAME : STX_CORE_NAME;
  // The receiver repays the core from ITS OWN balance via as-contract; the
  // signer should never send any STX/sBTC out of their own wallet as part
  // of this call, only pay the tx fee. Allow mode (the internal transfers
  // the loan itself makes are expected and fine) plus one explicit
  // zero-send condition on the signer catches a buggy or compromised
  // receiver trying to pull funds from the signer's wallet directly.
  const zeroSendPc = decision.core === "sbtc"
    ? Pc.principal(signer).willSendEq(0).ft(SBTC_ID, SBTC_ASSET)
    : Pc.principal(signer).willSendEq(0).ustx();
  console.log(`  3/3 ${coreName}.flash-loan(${loanAmount}, ${RECEIVER_NAME})`);
  const flashTx = await makeContractCall({
    contractAddress: DEPLOYER, contractName: coreName, functionName: "flash-loan",
    functionArgs: [Cl.uint(loanAmount), Cl.contractPrincipal(DEPLOYER, RECEIVER_NAME)],
    senderKey: pk, network, postConditionMode: PostConditionMode.Allow, postConditions: [zeroSendPc], anchorMode: 1, nonce, fee: FEE_FLASH,
  });
  let txid = null;
  try {
    txid = await broadcastOne(flashTx);
    console.log(`      Broadcast: ${EXPLORER}/0x${txid}?chain=mainnet`);
  } catch (e) {
    // A rejected broadcast never consumed this nonce -- returning nonce+1
    // anyway would leave a gap the next candidate's transactions sit
    // behind forever, unconfirmed. Return the SAME nonce so the next
    // candidate reuses it.
    console.error(`      FAILED: ${e.message}`);
    return { txid: null, nonce };
  }
  return { txid, nonce: nonce + 1 };
}

// ── Decide the loan amount for a mapped mode ───────────────────────────────
function sizeLoan(decision) {
  // Only modes 4/5 are ever proposed (see MODE_MAP) -- both are no-swap,
  // so the flash-borrowed asset IS the debt payment, 1:1, exactly.
  return decision.topDebt.actual;
}

// ── One scan pass: look for candidates, act on them if EXECUTE, return whether any were found ──
async function scan() {
  console.log(`\n[${new Date().toISOString()}] Scanning...`);
  console.log("Fetching live prices (Lazer + DIA)...");
  const prices = await resolveAllPrices();

  const realNr = await getNr();
  const nr = MAX_ACCOUNTS ? (BigInt(MAX_ACCOUNTS) < realNr ? BigInt(MAX_ACCOUNTS) : realNr) : realNr;
  console.log(`Scanning ${nr}${nr < realNr ? ` of ${realNr}` : ""} registered accounts...`);

  const candidates = [];
  let failed = 0;
  for (let id = 0n; id < nr; id++) {
    // lookup() and evaluateAccount() share one try/catch -- lookup() now
    // throws on failure instead of returning null (same fix as the
    // scanner's main loop: a lookup failure is always a network/parse
    // issue, never a legitimate "no entry", and must be counted here
    // rather than silently `continue`-ing with no record of it).
    try {
      const entry = await lookup(id);
      const mask = BigInt(entry.mask.value);
      if (!maskHasDebt(mask)) continue;
      const account = entry.account.value;
      const result = await evaluateAccount(id, account, mask, prices);
      // safeToAct, not liquidatable -- liquidatable alone means Zest's own
      // formula calls this account liquidatable, but this keeper prices
      // STX via DIA while Zest checks LTV against Lazer feed 45 on-chain,
      // and the two can disagree near the threshold. safeToAct requires
      // clearing LTV-LIQ-PARTIAL by a margin, not just touching it, so
      // nothing this keeper ever arms is one that Zest's own check might
      // reject as still-healthy.
      if (result?.safeToAct) candidates.push(result);
    } catch (e) {
      failed++;
      console.error(`\n  WARN: account ${id} failed to evaluate, skipped: ${e.message}`);
    }
    if (id % 100n === 0n) process.stdout.write(`\r  ...${id}/${nr}`);
  }
  console.log(`\r  done: ${candidates.length} safe-to-act candidate(s) found, ${failed} failed`);

  if (candidates.length === 0) {
    console.log("No safe-to-act liquidatable accounts right now.");
    return 0;
  }

  // Decide first, execute second -- so setMinProfitFloors (a real,
  // fee-paying broadcast) only runs when there's actually something
  // actionable in this pass, not on every pass that merely found a
  // liquidatable-looking candidate that then gets filtered out below. A
  // persistent unsupported/unsafe candidate used to cost 2 wasted
  // transactions every watch cycle forever -- the same pay-for-nothing
  // pattern the feed-before-arm fix removed from executeLiquidation.
  const toExecute = [];
  for (const candidate of candidates) {
    console.log(`\n--- ${candidate.account} ---`);
    console.log(`  collateral-usd: $${(Number(candidate.collateralUsd) / 1e8).toFixed(2)}  debt-usd: $${(Number(candidate.debtUsd) / 1e8).toFixed(2)}`);

    let decision = pickMode(candidate);
    // Mode 4 needs Lazer feed 45, which the active Demo plan doesn't
    // grant -- skip it outright rather than arm set-target and then fail
    // to fetch a feed for it (that used to cost a wasted set-target fee
    // every cycle; see executeLiquidation's feed-before-arm fix too).
    if (!decision.unsupported && NEEDS_STX_FEED_MODES.has(decision.mode) && !FEED_45_AVAILABLE) {
      decision = { unsupported: true, reason: `mode ${decision.mode} needs Lazer feed 45, not available on the current Demo plan (see project memory; set FEED_45_AVAILABLE=true once upgraded)` };
    }
    if (decision.unsupported) {
      console.log(`  SKIP -- ${decision.reason}`);
      continue;
    }
    decision.loanAmount = sizeLoan(decision);
    // Grep-able marker, same convention as monitor-alex-arb.mjs /
    // monitor-bitflow-arb.mjs's "*** ARB OPPORTUNITY ***" -- a Monitor
    // watch on this script's output greps for this exact string.
    console.log(`  *** LIQUIDATION OPPORTUNITY *** ${candidate.account} -- mode ${decision.mode} (${decision.label})`);
    console.log(`  Target debt: ${decision.topDebt.actual} raw units of ${decision.topDebt.asset}`);
    console.log(`  Loan size:   ${decision.loanAmount} ${decision.core === "sbtc" ? "sat sBTC" : "microSTX"} (exact -- no-swap mode)`);
    toExecute.push({ candidate, decision });
  }

  if (toExecute.length === 0) return 0;

  if (!EXECUTE) {
    console.log(`\n  (dry-run -- set EXECUTE=true KEEPER_MNEMONIC="..." to trigger)`);
    return toExecute.length;
  }

  // Signer, owner check, starting nonce, and the profit floors are all
  // done ONCE per pass, not per candidate -- re-deriving them per
  // candidate was also what led to the per-candidate nonce re-read that
  // collided across candidates.
  const wallet = await generateWallet({ secretKey: MNEMONIC, password: "" });
  const pk     = wallet.accounts[0].stxPrivateKey;
  const signer = getAddressFromPrivateKey(pk, "mainnet");

  const owner = uw(await readOnly(RECEIVER, "get-owner", []));
  if (owner !== signer) {
    console.error(`  ABORT: KEEPER_MNEMONIC signs as ${signer}, but the receiver's owner is ${owner}. Refusing to arm anything with a key that isn't actually the owner.`);
    return 0;
  }

  let nonce = await getPossibleNextNonce(signer);
  nonce = await setMinProfitFloors(pk, nonce, prices);

  for (const { candidate, decision } of toExecute) {
    const result = await executeLiquidation(pk, signer, nonce, candidate, decision);
    nonce = result.nonce;
  }
  return toExecute.length;
}

async function main() {
  console.log("==========================================================");
  console.log("  FlashStack — Zest Liquidation Keeper");
  console.log("==========================================================");
  console.log(`  Mode:     ${EXECUTE ? "LIVE EXECUTION" : "dry-run (mapping only)"}`);
  console.log(`  Watch:    ${WATCH ? `looping every ${INTERVAL_MS / 1000}s` : "single scan"}`);
  console.log(`  Receiver: ${RECEIVER}  (NOT YET DEPLOYED as of this writing -- see PR #98)`);

  if (!WATCH) {
    await scan();
    return;
  }

  // Loop mode -- same shape as monitor-alex-arb.mjs / monitor-bitflow-arb.mjs,
  // so a Monitor watch can grep this script's stdout the same way. A
  // single account's evaluation failure (handled inside scan() already)
  // doesn't stop the loop; an unexpected error from scan() itself is
  // logged and the loop continues rather than crashing the whole watch.
  for (;;) {
    try {
      await scan();
    } catch (e) {
      console.error(`  SCAN FAILED: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
