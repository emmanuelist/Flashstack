/**
 * FlashStack — Zest v0-8-market Position Scanner
 *
 * Finds real liquidatable positions on Zest's live market by replicating
 * its own on-chain valuation formula exactly (read directly from the
 * deployed v0-8-market source, not guessed), rather than trusting a
 * third-party's derived health factor. Cross-check candidates against
 * Nova's nova_stacks_zest_position tool as a sanity check, not a source
 * of truth.
 *
 * Architecture, confirmed live before writing a line of valuation code:
 *
 *   Enumeration: positions live in v0-market-vault (the persistent shared
 *   vault contract), NOT in the market contract itself -- that's why v0-4
 *   -> v0-8 didn't need a position migration. get-nr() = total registered
 *   accounts (1,334 as of this writing); lookup(id) returns {account,
 *   mask, ...} for id = 0..get-nr()-1. mask's low 64 bits are collateral
 *   (bit = asset-id), high 64 bits are debt (bit = asset-id + 64).
 *
 *   Pricing: Zest's on-chain liquidate() itself only recognizes 3 real
 *   Pyth Lazer feeds -- u1 (sBTC), u7 (USDC), u45 (STX) -- confirmed by
 *   reading resolve-pyth's hardcoded ident->feed-id table directly, plus
 *   USDH via a separate DIA oracle call ("USDh/USD", confirmed by
 *   decoding the 0x0d... consensus-buff prefix). That's what the real
 *   on-chain execution needs -- this SCANNER, which only estimates risk
 *   off-chain and submits nothing, does NOT need Lazer's STX feed at
 *   all. It uses DIA's own independent STX/USD feed instead (same oracle
 *   contract as USDH, confirmed live), since this account's Lazer plan
 *   (Demo) doesn't grant feed 45 -- and checked directly, there's no
 *   cheaper Lazer tier to fall back to either: Pyth Core (their free
 *   pull-oracle) dropped Stacks support entirely on 2026-08-26, so Lazer
 *   is now the only Pyth product on Stacks, full stop. See fetchDiaStx's
 *   own comment for the detail. Every other asset (the 7 v0-vault-*
 *   zToken/share tokens, stSTX, stBTC) derives its price from one of
 *   these base prices via a callcode multiplier (ztoken index, ststx
 *   ratio, stbtc ratio) rather than an independent feed -- confirmed by
 *   reading resolve-callcode's full dispatch table.
 *
 *   normalize-pyth(price, exponent) rescales any Pyth price to a fixed
 *   "USD x 1e8" representation regardless of the feed's native exponent.
 *   normalize(amount * price, decimals) = (amount * price) / 10^decimals
 *   -- since amount is stored in the asset's own raw units (real_amount *
 *   10^decimals), this cancels cleanly to real_amount * price, i.e. the
 *   notional value ends up in USD x 1e8 regardless of which asset.
 *
 *   Liquidation eligibility (read directly from liquidate()'s own health
 *   check, not inferred): current-ltv = debt-usd * 10000 / collateral-usd
 *   (BPS = 10000). A position is liquidatable when
 *   current-ltv >= LTV-LIQ-PARTIAL, the per-egroup threshold (looked up
 *   via v0-egroup.resolve(mask)).
 *
 * This script only SCANS -- it does not liquidate anything. It identifies
 * real candidates with an exact, verified health computation, and prints
 * them for review. Wiring a candidate into zest-v2-liquidation-receiver's
 * set-target/set-price-feed/flash-loan execution flow is a separate step.
 *
 * Exact liquidation SIZING (how much debt to repay, exact bonus) uses
 * Zest's own curve-based calc-liquidation-params, which this script does
 * NOT replicate -- it estimates conservatively using LIQ-PENALTY-MIN as a
 * floor. The receiver's own min-collateral-expected / min-profit checks
 * are the real safety net for sizing precision, same as every other
 * receiver built this session.
 *
 * Usage:
 *   LAZER_TOKEN="..." node scripts/scan-zest-positions.mjs   -- required, for live sBTC/USDC prices (STX comes from DIA, no token needed)
 *   NOVA_CROSSCHECK=3 node scripts/scan-zest-positions.mjs   -- cross-check the top N candidates against Nova
 */

import { Cl, cvToHex, hexToCV, cvToValue } from "@stacks/transactions";
import { PythLazerClient } from "@pythnetwork/pyth-lazer-sdk";

const API    = "https://api.hiro.so";
const ZEST   = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7";
const VAULT  = `${ZEST}.v0-market-vault`;
const ASSETS = `${ZEST}.v0-assets`;
const MARKET = `${ZEST}.v0-8-market`;
const EGROUP = `${ZEST}.v0-egroup`;
const DIA    = "SP1G48FZ4Y7JY8G2Z0N51QTCYGBQ6F4J43J77BQC0.dia-oracle";

const LAZER_TOKEN     = process.env.LAZER_TOKEN;
const NOVA_CROSSCHECK = parseInt(process.env.NOVA_CROSSCHECK ?? "3");
const BPS             = 10000n;
const DEBT_OFFSET     = 64n;

// Asset registry -- confirmed live via v0-assets.status-multi(0..13), not
// guessed. priceSource: which base feed resolve-price-feed routes to.
// callcode: the transform resolve-callcode applies on top of that base
// price (null = none, use the base price directly).
const ASSET_TABLE = [
  { id: 0,  addr: `${ZEST}.wstx`,                                           decimals: 6, collateral: false, debt: true,  priceSource: "stx",  callcode: null },
  { id: 1,  addr: `${ZEST}.v0-vault-stx`,                                   decimals: 6, collateral: true,  debt: false, priceSource: "stx",  callcode: "zstx" },
  { id: 2,  addr: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",    decimals: 8, collateral: true,  debt: true,  priceSource: "sbtc", callcode: null },
  { id: 3,  addr: `${ZEST}.v0-vault-sbtc`,                                  decimals: 8, collateral: true,  debt: false, priceSource: "sbtc", callcode: "zsbtc" },
  { id: 4,  addr: "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token",    decimals: 6, collateral: false, debt: true,  priceSource: "stx",  callcode: "ststx" },
  { id: 5,  addr: `${ZEST}.v0-vault-ststx`,                                 decimals: 6, collateral: true,  debt: false, priceSource: "stx",  callcode: "zststx" },
  { id: 6,  addr: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx",         decimals: 6, collateral: false, debt: true,  priceSource: "usdc", callcode: null },
  { id: 7,  addr: `${ZEST}.v0-vault-usdc`,                                  decimals: 6, collateral: true,  debt: false, priceSource: "usdc", callcode: "zusdc" },
  { id: 8,  addr: "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.usdh-token-v1",  decimals: 8, collateral: false, debt: true,  priceSource: "usdh", callcode: null },
  { id: 9,  addr: `${ZEST}.v0-vault-usdh`,                                  decimals: 8, collateral: true,  debt: false, priceSource: "usdh", callcode: "zusdh" },
  { id: 10, addr: "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststxbtc-token-v2", decimals: 6, collateral: false, debt: false, priceSource: "stx", callcode: null },
  { id: 11, addr: `${ZEST}.v0-vault-ststxbtc`,                              decimals: 6, collateral: true,  debt: false, priceSource: "stx",  callcode: "zststxbtc" },
  { id: 12, addr: "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.stbtc-token",    decimals: 8, collateral: false, debt: false, priceSource: "sbtc", callcode: "stbtc" },
  { id: 13, addr: `${ZEST}.v0-vault-stbtc`,                                 decimals: 8, collateral: true,  debt: false, priceSource: "sbtc", callcode: "stbtc" },
];
const ASSET_BY_ID = Object.fromEntries(ASSET_TABLE.map((a) => [a.id, a]));

const ZTOKEN_UNDERLYING = { zstx: 0, zsbtc: 2, zststx: 4, zusdc: 6, zusdh: 8, zststxbtc: 10 };

const STSTX_RATIO_DECIMALS = 1_000_000n; // confirmed live: v0-8-market's own STSTX-RATIO-DECIMALS constant (NOT 1e8 -- that's STBTC's scale, a wrong assumption-by-analogy caught by the resulting stSTX price being ~84x too low)
const STBTC_RATIO_DECIMALS = 100_000_000n;
const INDEX_PRECISION      = 1_000_000_000_000n; // confirmed: v0-8-market's own INDEX-PRECISION constant

const HIRO_API_KEY  = process.env.HIRO_API_KEY;
const CALL_DELAY_MS = parseInt(process.env.CALL_DELAY_MS ?? (HIRO_API_KEY ? "0" : "150"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A full scan makes thousands of sequential read-only calls (1,334
// accounts x several calls each for the ones with debt) -- confirmed live
// this hits Hiro's unauthenticated per-minute rate limit partway through a
// real run, not a hypothetical concern, and the limit is per-MINUTE, so a
// short escalating backoff isn't enough -- confirmed live too (5 retries
// up to 10s each still hit the same window). CALL_DELAY_MS paces every
// call proactively (default 150ms unauthenticated, 0 with an API key);
// the retry below is a backstop for whatever that pacing doesn't catch,
// and waits a flat 15s specifically on a detected rate-limit response
// rather than a short backoff. HIRO_API_KEY raises the limit in the
// first place, same env var the other two monitors already use.
async function readOnly(contract, fn, args, attempt = 0) {
  if (CALL_DELAY_MS > 0) await sleep(CALL_DELAY_MS);
  const [addr, name] = contract.split(".");
  const headers = { "Content-Type": "application/json" };
  if (HIRO_API_KEY) headers["x-api-key"] = HIRO_API_KEY;

  // The fetch() call itself, not just JSON-parsing its response, needs to
  // be inside the retry -- confirmed live: a full 1,334-account scan hit a
  // bare ETIMEDOUT partway through (a transient network read timeout, not
  // a rate limit), which threw directly out of fetch() and was never
  // caught by the parse-step try/catch below, killing the whole scan.
  let raw, text;
  try {
    raw = await fetch(`${API}/v2/contracts/call-read/${addr}/${name}/${fn}`, {
      method: "POST", headers,
      body: JSON.stringify({ sender: addr, arguments: args }),
    });
    text = await raw.text();
  } catch (e) {
    if (attempt < 8) { await sleep(2000 * (attempt + 1)); return readOnly(contract, fn, args, attempt + 1); }
    throw new Error(`${contract}.${fn}: network error after retries: ${e.message}`);
  }

  let res;
  try {
    res = JSON.parse(text);
  } catch {
    if (attempt < 8) {
      const isRateLimit = /rate limit/i.test(text);
      await sleep(isRateLimit ? 15000 : 2000 * (attempt + 1));
      return readOnly(contract, fn, args, attempt + 1);
    }
    throw new Error(`${contract}.${fn}: non-JSON response after retries: ${text.slice(0, 200)}`);
  }
  if (!res.okay) throw new Error(`${contract}.${fn} failed: ${JSON.stringify(res)}`);
  return cvToValue(hexToCV(res.result), true);
}

// cvToValue(cv, true)'s envelope behavior is genuinely inconsistent and
// confirmed empirically against live calls, not assumed: a value that's
// bare at the TOP level of a function's own return type (e.g. get-nr's
// plain uint128, lookup's plain tuple) decodes with no {type,value}
// envelope at all; a value recovered from INSIDE an unwrapped
// response/optional (e.g. call-ststx-ratio's (response uint128 none))
// keeps one. This normalizes both to the same shape. Tuple FIELDS
// (accessed as obj["field-name"]) are consistently enveloped either way
// -- only the outermost level varies.
export function uw(v) {
  return v && typeof v === "object" && !Array.isArray(v) && "value" in v ? v.value : v;
}

// ── Fetch a set of Lazer feeds in one isolated client, with a timeout ──────
// Isolated per call (not all feeds in one client) because a single feed
// lacking entitlement throws inside the WebSocket pool's own
// dedupeHandler, not as a rejection on subscribe() -- it would otherwise
// take the whole price fetch down even for feeds that DO work. Confirmed
// live on this account: feed 1 (sBTC) and feed 7 (USDC) are both
// entitled. STX (feed 45) used to be fetched here too, but isn't anymore
// -- see fetchDiaStx below for why.
function fetchLazerFeeds(feedIds) {
  return new Promise((resolve, reject) => {
    const unhandled = (e) => { cleanup(); reject(e?.reason ?? e); };
    let client;
    const cleanup = () => {
      process.removeListener("unhandledRejection", unhandled);
      try { client?.shutdown(); } catch {}
    };
    process.once("unhandledRejection", unhandled);

    const timer = setTimeout(() => { cleanup(); reject(new Error("timed out waiting for Lazer feeds " + feedIds)); }, 15000);

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
      const got = {};
      client.addMessageListener((event) => {
        if (event.type !== "json") return;
        const message = event.value;
        if (message.type !== "streamUpdated" || !message.parsed) return;
        for (const feed of message.parsed.priceFeeds) {
          if (feed.price === undefined) continue;
          got[feed.priceFeedId] = { price: BigInt(feed.price), exponent: feed.exponent };
        }
        if (feedIds.every((id) => got[id])) {
          clearTimeout(timer);
          cleanup();
          resolve(got);
        }
      });
      client.subscribe({
        type: "subscribe", subscriptionId: 1,
        priceFeedIds: feedIds,
        properties: ["price", "exponent"],
        formats: [],
        deliveryFormat: "json",
        channel: "fixed_rate@200ms",
        parsed: true,
      });
    });
  });
}

async function fetchLazerPrices() {
  if (!LAZER_TOKEN) {
    console.error("ERROR: set LAZER_TOKEN to fetch live prices (free signup: pythdata.app)");
    process.exit(1);
  }
  const got = {};
  try {
    Object.assign(got, await fetchLazerFeeds([1, 7]));
  } catch (e) {
    console.error(`ERROR: Lazer feeds 1/7 (sBTC/USDC) unavailable: ${e.message}`);
    process.exit(1);
  }
  return got;
}

// price * 10^(exponent+8), matching normalize-pyth exactly -> USD x 1e8
function normalizePyth(price, exponent) {
  const adj = exponent + 8;
  if (adj > 0) return price * 10n ** BigInt(adj);
  if (adj < 0) return price / 10n ** BigInt(-adj);
  return price;
}

async function fetchDiaUsdh() {
  const v = await readOnly(DIA, "get-value", [cvToHex(Cl.stringAscii("USDh/USD"))]);
  return BigInt(v.value.value.value); // already USD x 1e8, confirmed live (100000000 = $1.00)
}

// STX used to come from Lazer feed 45, but that account's Lazer plan
// (Demo) doesn't grant it -- confirmed live ("Not entitled: feed 45").
// Checked whether a cheaper Lazer tier exists instead: it doesn't --
// Pyth Core (their free pull-oracle, Hermes) dropped Stacks support
// entirely on 2026-08-26, so Lazer is now the ONLY Pyth product live on
// Stacks at all, and its Free tier has no API access, period -- Starter
// ($500/mo) is the only paid-API floor. For the real on-chain liquidate()
// submission this is unavoidable (Zest's own v0-8-market hardcodes
// verification against a genuine signed Lazer buffer -- not FlashStack's
// choice of oracle to swap). But THIS function only estimates who's at
// risk off-chain, never submits anything on-chain, so it doesn't need
// Lazer's entitlement at all -- DIA (the same oracle Zest itself already
// uses for USDH, see fetchDiaUsdh) has its own independent STX/USD feed,
// confirmed live (STX/USD -> $0.3947 at the time of checking, same USD x
// 1e8 scale as USDh/USD). Free, no entitlement, plain contract-call.
// Replaces the old STX_PRICE_USD8_FALLBACK manual escape hatch entirely.
async function fetchDiaStx() {
  const v = await readOnly(DIA, "get-value", [cvToHex(Cl.stringAscii("STX/USD"))]);
  return BigInt(v.value.value.value);
}

// ── Resolve every asset's price (USD x 1e8), applying callcodes ────────────
async function resolveAllPrices() {
  const lazer = await fetchLazerPrices();
  const basePrices = {
    stx:  await fetchDiaStx(),
    sbtc: normalizePyth(lazer[1].price, lazer[1].exponent),
    usdc: normalizePyth(lazer[7].price, lazer[7].exponent),
    usdh: await fetchDiaUsdh(),
  };

  const ststxRatio = BigInt(uw(await readOnly(MARKET, "call-ststx-ratio", [])));
  const stbtcRatio = BigInt(uw(await readOnly(MARKET, "call-stbtc-ratio", [])));
  const stbtcHaircutBps = BigInt(uw(await readOnly(MARKET, "get-stbtc-haircut-bps", [])));

  const ztokenIds = ASSET_TABLE.filter((a) => a.callcode?.startsWith("z")).map((a) => a.id);
  const indexes = {};
  for (const id of ztokenIds) {
    const v = await readOnly(MARKET, "get-cached-indexes", [cvToHex(Cl.uint(id))]);
    if (v) indexes[id] = BigInt(uw(v).lindex.value);
  }

  const prices = {};
  for (const asset of ASSET_TABLE) {
    const base = basePrices[asset.priceSource];
    if (!asset.callcode) { prices[asset.id] = base; continue; }
    if (asset.callcode === "ststx") {
      prices[asset.id] = (base * ststxRatio) / STSTX_RATIO_DECIMALS;
    } else if (asset.callcode === "stbtc") {
      prices[asset.id] = (base * stbtcRatio * (BPS - stbtcHaircutBps)) / BPS / STBTC_RATIO_DECIMALS;
    } else if (asset.callcode === "zststx") {
      const ststxPrice = (base * ststxRatio) / STSTX_RATIO_DECIMALS;
      const lindex = indexes[asset.id] ?? INDEX_PRECISION;
      prices[asset.id] = (ststxPrice * lindex) / INDEX_PRECISION;
    } else {
      // zstx / zsbtc / zusdc / zusdh / zststxbtc: plain ztoken-index on the base price
      const lindex = indexes[asset.id] ?? INDEX_PRECISION;
      prices[asset.id] = (base * lindex) / INDEX_PRECISION;
    }
  }
  return prices;
}

// ── Enumeration ───────────────────────────────────────────────────────────
async function getNr() {
  const v = await readOnly(VAULT, "get-nr", []);
  return BigInt(uw(v));
}

// Normalized here so callers can always do entry.mask.value / entry.account.value
// regardless of whether this particular call happened to come back enveloped.
async function lookup(id) {
  try {
    return uw(await readOnly(VAULT, "lookup", [cvToHex(Cl.uint(id))]));
  } catch {
    return null;
  }
}

function maskHasDebt(mask) {
  const debtMask = mask >> DEBT_OFFSET;
  return debtMask !== 0n;
}
function maskAssetIds(mask, offset) {
  const ids = [];
  const shifted = mask >> offset;
  for (let bit = 0n; bit < DEBT_OFFSET; bit++) {
    if ((shifted >> bit) & 1n) ids.push(Number(bit));
  }
  return ids;
}

// get-collateral/get-debt panic (API-level error, not a Clarity err) when
// the account has no entry at all for that specific asset id -- shouldn't
// happen given callers only query asset ids present in the account's own
// mask, but treated as 0 defensively rather than crashing the whole scan.
async function getCollateral(id, assetId) {
  try {
    const v = await readOnly(VAULT, "get-collateral", [cvToHex(Cl.uint(id)), cvToHex(Cl.uint(assetId))]);
    return BigInt(uw(v));
  } catch { return 0n; }
}
async function getDebtScaled(id, assetId) {
  try {
    const v = await readOnly(VAULT, "get-debt", [cvToHex(Cl.uint(id)), cvToHex(Cl.uint(assetId))]);
    return BigInt(uw(v).scaled.value);
  } catch { return 0n; }
}
async function getCachedIndex(assetId) {
  const v = await readOnly(MARKET, "get-cached-indexes", [cvToHex(Cl.uint(assetId))]);
  return v ? BigInt(uw(v).index.value) : INDEX_PRECISION;
}
async function getEgroup(mask) {
  // resolve() is (response (tuple ...) uint) -- an error case (no egroup
  // registered for this exact mask) decodes to a bare error code, not a
  // fields object, so checking for the expected field after uw() is the
  // robust way to tell success from error regardless of which envelope
  // shape this particular call happens to come back as. Confirmed live
  // against v0-egroup's real interface: LTV-LIQ-PARTIAL and friends are
  // (buff 2), not plain uint -- cvToValue already renders a buffer's
  // .value as a "0x..." hex string, which BigInt() parses directly.
  const v = uw(await readOnly(EGROUP, "resolve", [cvToHex(Cl.uint(mask))]));
  if (!v || typeof v !== "object" || !v["LTV-LIQ-PARTIAL"]) return null;
  return {
    ltvLiqPartial: BigInt(v["LTV-LIQ-PARTIAL"].value),
  };
}

// ── Evaluate one account ────────────────────────────────────────────────────
async function evaluateAccount(id, account, mask, prices) {
  const collIds = maskAssetIds(mask, 0n);
  const debtIds = maskAssetIds(mask, DEBT_OFFSET);

  let collateralUsd = 0n;
  for (const aid of collIds) {
    const asset = ASSET_BY_ID[aid];
    if (!asset) continue;
    const amount = await getCollateral(id, aid);
    if (amount === 0n) continue;
    collateralUsd += (amount * prices[aid]) / 10n ** BigInt(asset.decimals);
  }

  let debtUsd = 0n;
  let debtDetail = [];
  for (const aid of debtIds) {
    const asset = ASSET_BY_ID[aid];
    if (!asset) continue;
    const scaled = await getDebtScaled(id, aid);
    if (scaled === 0n) continue;
    const index = await getCachedIndex(aid);
    const actual = (scaled * index + INDEX_PRECISION - 1n) / INDEX_PRECISION; // mul-div-up
    const usd = (actual * prices[aid]) / 10n ** BigInt(asset.decimals);
    debtUsd += usd;
    debtDetail.push({ aid, asset: asset.addr, actual, usd });
  }

  if (collateralUsd === 0n && debtUsd === 0n) return null;
  const currentLtv = collateralUsd === 0n ? (debtUsd === 0n ? 0n : BPS) : (debtUsd * BPS) / collateralUsd;

  const egroup = await getEgroup(mask);
  const ltvLiqPartial = egroup?.ltvLiqPartial ?? null;
  const liquidatable = ltvLiqPartial !== null && currentLtv >= ltvLiqPartial;

  return { id, account, mask, collateralUsd, debtUsd, currentLtv, ltvLiqPartial, liquidatable, debtDetail };
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log("==========================================================");
  console.log("  FlashStack — Zest v0-8-market Position Scanner");
  console.log("==========================================================");

  console.log("Fetching live prices (Lazer + DIA)...");
  const prices = await resolveAllPrices();
  for (const a of ASSET_TABLE) {
    console.log(`  asset ${a.id} (${a.addr.split(".").pop()}): $${(Number(prices[a.id]) / 1e8).toFixed(6)}`);
  }

  const realNr = await getNr();
  const nr = process.env.MAX_ACCOUNTS ? (BigInt(process.env.MAX_ACCOUNTS) < realNr ? BigInt(process.env.MAX_ACCOUNTS) : realNr) : realNr;
  console.log(`\nScanning ${nr}${nr < realNr ? ` of ${realNr}` : ""} registered accounts (v0-market-vault.get-nr())...`);

  const candidates = [];
  let checked = 0, skippedNoDebt = 0, failed = 0;
  for (let id = 0n; id < nr; id++) {
    const entry = await lookup(id);
    if (!entry) continue;
    const mask = BigInt(entry.mask.value);
    if (!maskHasDebt(mask)) { skippedNoDebt++; continue; }
    checked++;
    const account = entry.account.value;
    // A single account failing after readOnly's own retries are exhausted
    // (e.g. a sustained outage mid-scan) shouldn't discard progress on the
    // other 1,333 -- logged and skipped, not fatal.
    try {
      const result = await evaluateAccount(id, account, mask, prices);
      if (result?.liquidatable) candidates.push(result);
    } catch (e) {
      failed++;
      console.error(`\n  WARN: account ${id} (${account}) failed to evaluate, skipped: ${e.message}`);
    }
    if (id % 100n === 0n) process.stdout.write(`\r  ...${id}/${nr}`);
  }
  console.log(`\r  done: ${nr} total, ${skippedNoDebt} no-debt (skipped), ${checked} evaluated, ${failed} failed`);

  console.log(`\n=== ${candidates.length} LIQUIDATABLE CANDIDATE(S) ===`);
  for (const c of candidates) {
    console.log(`\n  account:         ${c.account}`);
    console.log(`  collateral-usd:  $${(Number(c.collateralUsd) / 1e8).toFixed(2)}`);
    console.log(`  debt-usd:        $${(Number(c.debtUsd) / 1e8).toFixed(2)}`);
    console.log(`  current-ltv:     ${(Number(c.currentLtv) / 100).toFixed(2)}%  (liq threshold: ${(Number(c.ltvLiqPartial) / 100).toFixed(2)}%)`);
    for (const d of c.debtDetail) console.log(`    debt: ${d.asset} -- $${(Number(d.usd) / 1e8).toFixed(2)}`);
  }

  if (NOVA_CROSSCHECK > 0 && candidates.length > 0) {
    console.log(`\n=== Cross-check top ${Math.min(NOVA_CROSSCHECK, candidates.length)} against Nova (sanity check, not source of truth) ===`);
    console.log("  (requires the nova MCP tool -- run this list through nova_stacks_zest_position manually for now)");
    for (const c of candidates.slice(0, NOVA_CROSSCHECK)) console.log(`  ${c.account}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
