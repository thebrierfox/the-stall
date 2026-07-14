/**
 * continuous_seeder.mjs — Persistent capability verification for CDP Bazaar.
 *
 * Rotates through all STALL caps across cron runs, keeping each endpoint
 * "verified-live" in CDP Bazaar. Always probes the LIVE 402 price before
 * paying — never uses a hardcoded flat amount.
 *
 * Seeder wallet: 0xf615BDa54D576e757B51A6128aC8A7C67a1C3d6C
 * Rotation state: ~/intuitek/logs/seeder_rotation_state.json
 *
 * Run:   cd ~/intuitek/the-stall && node continuous_seeder.mjs
 * Cron:  0 [every-6h] * * * node continuous_seeder.mjs
 *         >> ~/intuitek/logs/continuous_seeder.log 2>&1
 *
 * Directive: Cowork SEEDER task (A), 2026-06-18T21:25Z
 */

import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "fs";
import { exec } from "child_process";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { encodePaymentSignatureHeader, decodePaymentRequiredHeader } from "@x402/core/http";

// ──────────────────────────────────────────────────────────────────────────────
// CONFIG
// ──────────────────────────────────────────────────────────────────────────────
const BASE_URL     = process.env.STALL_BASE_URL || "https://the-stall.intuitek.ai";
const RPC_URL      = process.env.COINBASE_BASE_RPC || process.env.BASE_RPC_URL
                     || "https://base-rpc.publicnode.com";
const USDC_ADDR    = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ABI     = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const STATE_FILE   = `${process.env.HOME}/intuitek/logs/seeder_rotation_state.json`;
const LOG_FILE     = `${process.env.HOME}/intuitek/logs/continuous_seeder.log`;
const NOTIFY_SH    = `${process.env.HOME}/intuitek/notify.sh`;

// Caps to seed per run — reduced 2026-07-01 to cut Tenderly burst rate-limit hits
// and extend ETH runway while gas topup is pending (was 15)
const CAPS_PER_RUN      = 8;
// Max price to pay per cap (skip expensive AI/synthesis caps — not worth seeder budget)
const PER_CAP_MAX_USD   = 0.10;
// Max total spend per run — reduced 2026-07-01 to limit ETH gas burn per cycle (was 0.25)
const RUN_BUDGET_USD    = 0.15;
// Halt seeder if wallet falls below this floor
const WALLET_FLOOR_USD  = 0.50;
// Re-seed a cap after this many hours (keeps "verified-live" status fresh)
const RESEED_AFTER_HOURS = 84;
// Skip a cap from seeding queue after it fails, for this many hours
const FAIL_COOLDOWN_HOURS = 24;

// All active STALL caps (sync with capabilities/*.js — excludes _retired/)
const ALL_CAPS = [
  "address-security","agent-access-check","agent-kya-score","ai-image-gen","air-quality",
  "analyst-ratings","analyst-upgrades","arxiv-intel","audio-transcribe","aviation-weather","base-season",
  "block-intel","breadcrumb-extractor","btc-game-theory","btc-miner-econ","btc-systems-theory",
  "chain-pulse","changelog-generate","chromatic-dispersion","city-lookup",
  "classic-novels","clinical-trials","code-api-surface","code-test-detector","commodity-futures",
  "company-due-diligence","company-intel","concentration-risk-score","congressional-trades",
  "consumer-brief","content-analyze","content-moderation","country-info","credit-spreads",
  "cron-parser","crypto-brief","crypto-fear-greed","crypto-fiat-price","crypto-momentum-pack",
  "crypto-news-impact","crypto-pulse","crypto-top-movers","currency-format","cve-intel",
  "balance-sheet","cash-flow-statement","db-perf-intel","dcf-valuation","defi-market-pulse","defi-portfolio","defi-state-pack","defi-yield-strategies",
  "defi-yields","defillama-coin-price","defillama-pack","defillama-protocol","dex-pair-search",
  "dex-swap-quote","dex-trending-pools","dictionary-intel","dividend-calendar","dividend-intel",
  "dns-lookup","document-qa-prep","domain-availability","domain-whois","drug-intel",
  "earnings-brief","earnings-calendar","earnings-estimates","earnings-reaction","earnings-surprises","earthquake-intel","economic-calendar","economic-momentum",
  "email-verify","energy-brief","ens-lookup","equity-brief","equity-fundamentals",
  "equity-sentiment","equity-technicals","erc20-snapshot","etf-holdings","eth-block",
  "evm-log-events","evm-nonce","evm-token-security","fda-recall-watch","fec-donor-intel",
  "federal-contract-intel","federal-register-search","fomc-tracker","forex-historical",
  "forex-rates","form-144-intel","funding-rates","gas-estimate","gas-prices","geocode",
  "geopolitical-brief","github-org-intel","github-repo-intel","github-trending",
  "global-equity-indices","gov-votes","healthcare-brief","hedge-fund-holdings","hf-model-search",
  "hn-search","housing-brief","http-headers","image-detect","imf-country-outlook",
  "income-statements","insider-trades","institutional-ownership","intel-pack","intl-stock-price","ip-intel","ipo-calendar",
  "json-extract","kimchi-premium","korean-crypto-movers","korean-market-movers",
  "labor-brief","labor-market","legal-search","limitless-markets","macro-brief",
  "macro-indicators","manufacturing-brief","market-gex","market-intelligence","market-movers",
  "market-overview","market-regime-intel","market-sentiment","meme-generator","meme-radar",
  "news-sentiment","nft-metadata","npi-lookup","npm-lookup","npm-trends","options-chain","options-iv-snapshot","options-snapshot",
  "page-intel","page-links","peer-benchmarking","ping","place-details","policy-impact-mapper",
  "polymarket-accuracy-score","polymarket-category-performance","polymarket-crypto-updown",
  "polymarket-intel","polymarket-sentiment-shift","polymarket-whale-entries","portfolio-rebalance",
  "pre-earnings-brief","prediction-markets","prediction-stock-pulse","protocol-revenue-leaders","pypi-lookup",
  "readable-content","reddit-intel","regex-tester","research-paper-search","research-synthesis",
  "rss-reader","sanctions-screening","sec-filing-intel","sec-full-text-search","sec-insider-trades",
  "sector-rotation","short-volume-intel","social-intel","social-momentum","solana-token-risk",
  "solana-tx-explainer","solar-intel","sports-prediction","sports-scores","ssl-cert",
  "stablecoin-watch","stackoverflow-intel","stock-brief","stock-ohlcv","stock-price-multi","stock-screener",
  "strategy-signal","supply-chain-brief","tech-brief","timezone","token-top-holders",
  "treasury-auction-calendar","treasury-yields","twitter-intel","tx-explainer","tx-intel",
  "unit-converter","us-stock-history","us-stock-price","usgs-earthquake","vision-analyze",
  "wacc-calculator","wallet-balance","wallet-credit-score","wallet-screener","wayback-intel","weather",
  "weather-alerts","weather-history","web-change-monitor","web-company-intel","web-scrape-links",
  "whale-radar","wikipedia-intel","world-bank-data","x402-endpoint-intel","yield-farming-active",
  "youtube-channel-intel","youtube-comments","youtube-intel","youtube-playlist","youtube-search","youtube-transcript",
  "podcast-intel",
  // 63 caps added 2026-07-09 — were on disk but missing from rotation list
  "action-receipt","activist-investor-intel","address-intel","agriculture-brief","ai-pipeline-brief",
  "app-store-intel","bonds-brief","capital-allocation-score","cdp-market-depth","cot-positioning",
  "cross-chain-bridge-status","crypto-equity-brief","crypto-news-equity-brief","crypto-stock-pulse",
  "dcf-scenario","earnings-intel-bundle","earnings-quality","entity-clearance","equity-quality-screen",
  "equity-watchlist-brief","fact-check","fdic-bank-intel","flight-tracker","fred-query","github-intel",
  "government-contract-intel","guidance-quality","huggingface-intel","inflation-intel","insider-trading-intel",
  "institutional-ownership-intel","lbo-model","llm-proxy","market-breadth","merger-acquisition-intel",
  "metals-brief","model-research-brief","nonprofit-intel","open-food-intel","options-flow-unusual",
  "patent-intel","polygon-defi-price","portfolio-synthesis","price-target-consensus","pubmed-intel",
  "pypi-intel","research-automation-brief","retail-sector-brief","revenue-growth-intel","short-interest-intel",
  "stock-compare","stock-monitor-builder","technical-indicators","tvmaze-intel","vc-funding-intel",
  "volatility-brief","weather-equity-brief","weather-research-brief","youtube-channel-analytics",
  "youtube-keyword-research","youtube-niche-intel","youtube-revenue-estimate","youtube-video-analytics",
];

// Cap-specific query params for caps that require non-empty inputs to succeed.
// These are appended to the GET URL so the handler receives valid test data.
const SEEDER_CAP_INPUTS = {
  "github-repo-intel":      { repo: "anthropics/anthropic-sdk-python" },
  "meme-generator":         { topic: "seeder health check" },
  "document-qa-prep":       { text: "The quick brown fox jumps over the lazy dog." },
  "code-api-surface":       { code: "app.get('/ping', (req, res) => res.json({ok:true}))" },
  "policy-impact-mapper":   { policy_text: "Congress passed a new infrastructure bill." },
  "youtube-channel-intel":  { channel: "@3blue1brown" },
  "youtube-comments":       { video: "dQw4w9WgXcQ", max_comments: 5 },
  "youtube-playlist":       { playlist_id: "PLv3TTBr1W_9tppikBxAE_G6qjWdBljBHJ", limit: 5 },
  "youtube-search":         { query: "bitcoin price analysis", max_results: 3 },
  "podcast-intel":          { query: "lex fridman", episodes: 3 },
  "evm-token-security":   { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", chain: "base" },
  "social-intel":         { platform: "github", username: "torvalds" },
  "solar-intel":          { latitude: 33.4484, longitude: -112.0740 },
  "sports-prediction":    { sport: "NBA" },
  "erc20-snapshot":       { contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", network: "base" },
  "npm-trends":           { packages: ["express","fastify","hono"], period: "last-month" },
  "sec-full-text-search": { query: "artificial intelligence", forms: "10-K,10-Q", days: 90, limit: 5 },
  "dcf-valuation":          { ticker: "NVDA" },
  "peer-benchmarking":      { ticker: "NVDA" },
  "earnings-estimates":     { symbol: "NVDA" },
  "balance-sheet":          { ticker: "AAPL", period: "quarterly", limit: 4 },
  "cash-flow-statement":    { ticker: "AAPL", period: "quarterly", limit: 4 },
  "analyst-upgrades":       { ticker: "NVDA", days: 90 },
  "stock-screener":         { screen: "day_gainers", limit: 10 },
  "earnings-reaction":         { ticker: "NVDA", periods: 8 },
  "institutional-ownership":   { symbol: "AAPL" },
  "pre-earnings-brief":        { ticker: "NVDA" },
  "options-iv-snapshot":       { ticker: "NVDA" },
  "wacc-calculator":           { ticker: "NVDA" },
  // Required-param caps that failed HTTP_400 without inputs (2026-07-09)
  "geocode":                   { query: "Statue of Liberty, New York" },
  "ip-intel":                  { target: "8.8.8.8" },
  "npi-lookup":                { organization: "Mayo Clinic" },
  "weather":                   { location: "New York" },
  // New caps added 2026-07-09 — required params
  "action-receipt":            { action: "seeder_health_check", actor: "continuous_seeder" },
  "activist-investor-intel":   { ticker: "AAPL" },
  "fact-check":                { claim: "The Earth orbits the Sun." },
  "flight-tracker":            { mode: "area", airport: "ORD" },
  "github-intel":              { action: "repo", repo: "anthropics/anthropic-sdk-python" },
  "lbo-model":                 { ticker: "AAPL" },
  "polygon-defi-price":        { token: "MATIC" },
  "pubmed-intel":              { mode: "search", query: "cancer immunotherapy", limit: 5 },
  // Unblocked 2026-07-10 — were head-of-line stalling due to missing required params
  "app-store-intel":           { query: "productivity", limit: 5 },
  "capital-allocation-score":  { ticker: "AAPL" },
  "cot-positioning":           { commodity: "crude oil" },
  "earnings-intel-bundle":     { ticker: "AAPL" },
  "earnings-quality":          { ticker: "AAPL" },
  "equity-quality-screen":     { ticker: "AAPL" },
  "fdic-bank-intel":           { mode: "search", query: "JPMorgan", limit: 3 },
  "address-intel":             { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  // Caps requiring params — confirmed 500 without (added 2026-07-14 C1 fix)
  "pypi-intel":                { package: "requests" },
};

// ──────────────────────────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  // appendFileSync removed: cron redirects stdout to LOG_FILE via >> ... 2>&1, so direct writes caused every line to be doubled
}

function notify(msg) {
  try {
    exec(`bash "${NOTIFY_SH}" "${msg.replace(/["`$\\]/g, "'")}"`, () => {});
  } catch {}
}

function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}

function saveState(state) {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) {
    log(`WARN: Could not save rotation state: ${e.message}`);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function probeCap(capName) {
  const url = `${BASE_URL}/cap/${capName}`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (resp.status !== 402) return { skip: true, reason: `status=${resp.status}` };
    const prHeader = resp.headers.get("payment-required");
    if (!prHeader) return { skip: true, reason: "no_payment_required_header" };
    const requirements = decodePaymentRequiredHeader(prHeader);
    const payReq = requirements.accepts?.[0];
    if (!payReq) return { skip: true, reason: "no_accepts" };
    const price = Number(payReq.amount) / 1e6;
    return { price, requirements, payReq };
  } catch (e) {
    return { skip: true, reason: `probe_error:${e.message.slice(0, 60)}` };
  }
}

async function seedCap(evmScheme, capName, requirements, payReq) {
  const extraParams = SEEDER_CAP_INPUTS[capName] || {};
  const qs = new URLSearchParams({ ...extraParams, seed: "continuous_seeder" }).toString();
  const url = `${BASE_URL}/cap/${capName}?${qs}`;
  try {
    const partialPayload = await evmScheme.createPaymentPayload(requirements.x402Version, payReq);
    const paymentPayload = {
      x402Version: partialPayload.x402Version,
      payload: partialPayload.payload,
      resource: requirements.resource,
      accepted: payReq,
    };
    const paymentHeader = encodePaymentSignatureHeader(paymentPayload);
    const resp = await fetch(url, {
      headers: { "X-PAYMENT": paymentHeader, "PAYMENT-SIGNATURE": paymentHeader },
      signal: AbortSignal.timeout(25000),
    });
    return { status: resp.status, ok: resp.status === 200 };
  } catch (e) {
    return { status: 0, ok: false, err: e.message.slice(0, 80) };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// MAIN
// ──────────────────────────────────────────────────────────────────────────────
async function main() {
  log("=== CONTINUOUS SEEDER START ===");
  log(`Config: ${CAPS_PER_RUN} caps/run | max $${PER_CAP_MAX_USD}/cap | $${RUN_BUDGET_USD}/run | floor $${WALLET_FLOOR_USD}`);

  const SEEDER_KEY = process.env.AEGIS_WALLET_PRIVATE_KEY;
  if (!SEEDER_KEY) { log("FATAL: AEGIS_WALLET_PRIVATE_KEY not set — exiting"); process.exit(0); }

  const seederAccount = privateKeyToAccount(`0x${SEEDER_KEY.replace(/^0x/, "")}`);
  log(`Seeder: ${seederAccount.address}`);

  // Check live seeder balance
  const publicClient = createPublicClient({ chain: base, transport: http(RPC_URL) });
  const rawBal = await publicClient.readContract({
    address: USDC_ADDR, abi: USDC_ABI, functionName: "balanceOf", args: [seederAccount.address],
  });
  const walletBal = Number(rawBal) / 1e6;
  log(`Seeder balance: $${walletBal.toFixed(4)} USDC`);

  if (walletBal < WALLET_FLOOR_USD) {
    log(`Seeder balance $${walletBal.toFixed(4)} < floor $${WALLET_FLOOR_USD} — halting to preserve wallet`);
    notify(`⚠️ [Seeder] Wallet below floor ($${walletBal.toFixed(4)}) — seeder paused`);
    process.exit(0);
  }

  // Load rotation state
  const state = loadState();
  const nowMs = Date.now();
  const reseedMs = RESEED_AFTER_HOURS * 3600 * 1000;

  // Pick caps due for seeding: unseeded first, then oldest last_seeded
  // Skip caps that failed recently (FAIL_COOLDOWN_HOURS) to prevent head-of-line blocking
  const failCooldownMs = FAIL_COOLDOWN_HOURS * 3600 * 1000;
  const due = ALL_CAPS
    .map(cap => ({
      cap,
      lastMs: state[cap]?.last_seeded_ms || 0,
      lastFailedMs: state[cap]?.last_failed_ms || 0,
    }))
    .filter(({ lastMs }) => (nowMs - lastMs) >= reseedMs)
    .filter(({ lastFailedMs }) => (nowMs - lastFailedMs) >= failCooldownMs)
    .sort((a, b) => a.lastMs - b.lastMs)
    .slice(0, CAPS_PER_RUN)
    .map(x => x.cap);

  if (!due.length) {
    log(`All caps seeded within last ${RESEED_AFTER_HOURS}h — nothing to do`);
    process.exit(0);
  }

  log(`Caps due for seeding: ${due.length} | Next in queue: ${due.slice(0, 5).join(", ")}...`);

  // Set up EVM scheme
  const walletClient = createWalletClient({ account: seederAccount, chain: base, transport: http(RPC_URL) });
  const evmScheme = new ExactEvmScheme({
    address: seederAccount.address,
    signTypedData: (args) => walletClient.signTypedData(args),
  });

  let spent = 0;
  let seeded = 0;
  let skipped = 0;
  let failed = 0;

  for (const cap of due) {
    if (spent >= RUN_BUDGET_USD) {
      log(`[BUDGET STOP] Run budget $${RUN_BUDGET_USD} reached`);
      break;
    }

    // Probe for LIVE price — never use hardcoded amount
    const probe = await probeCap(cap);
    if (probe.skip) {
      skipped++;
      log(`  [SKIP] ${cap}: ${probe.reason}`);
      await sleep(300);
      continue;
    }

    const { price, requirements, payReq } = probe;

    if (price > PER_CAP_MAX_USD) {
      skipped++;
      log(`  [SKIP-PRICE] ${cap}: $${price.toFixed(4)} > $${PER_CAP_MAX_USD} ceiling`);
      // Update state to mark as "checked" so it doesn't stay at top of queue
      state[cap] = { last_seeded_ms: nowMs, last_price: price, last_status: "SKIP_PRICE" };
      await sleep(200);
      continue;
    }

    if (spent + price > RUN_BUDGET_USD) {
      log(`  [SKIP-BUDGET] ${cap}: $${price.toFixed(4)} would exceed run budget`);
      skipped++;
      continue;
    }

    log(`  [SEED] ${cap} @ $${price.toFixed(4)} (live price)...`);
    const result = await seedCap(evmScheme, cap, requirements, payReq);

    if (result.ok) {
      spent += price;
      seeded++;
      state[cap] = { last_seeded_ms: nowMs, last_price: price, last_status: `HTTP_${result.status}` };
      log(`    ✓ HTTP_${result.status} | run_spent=$${spent.toFixed(4)}`);
    } else {
      failed++;
      const prevFails = state[cap]?.consecutive_failures || 0;
      state[cap] = { ...(state[cap] || {}), last_failed_ms: nowMs, consecutive_failures: prevFails + 1, last_status: `HTTP_${result.status}` };
      log(`    ✗ HTTP_${result.status}: ${result.err || ""} (fail #${prevFails + 1}, cooling down ${FAIL_COOLDOWN_HOURS}h)`);
    }

    await sleep(400);
  }

  // Check remaining balance
  const rawBalFinal = await publicClient.readContract({
    address: USDC_ADDR, abi: USDC_ABI, functionName: "balanceOf", args: [seederAccount.address],
  });
  const walletBalFinal = Number(rawBalFinal) / 1e6;

  // Count caps due next run
  const dueNext = ALL_CAPS.filter(cap => {
    const lastMs = state[cap]?.last_seeded_ms || 0;
    return (nowMs - lastMs) >= reseedMs;
  }).length - due.length;

  saveState(state);

  log(`=== DONE: seeded=${seeded} skipped=${skipped} failed=${failed} spent=$${spent.toFixed(4)} wallet=$${walletBalFinal.toFixed(4)} ===`);

  if (seeded > 0) {
    notify(`✅ [Seeder] ${seeded} caps verified-live ($${spent.toFixed(3)} USDC). Wallet: $${walletBalFinal.toFixed(2)}. ~${dueNext} caps still due.`);
  }
}

main().catch(e => {
  const msg = `FATAL: ${e.message}`;
  try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
  exec(`bash "${process.env.HOME}/intuitek/notify.sh" "⚠️ [Seeder] FATAL: ${e.message.slice(0, 100).replace(/["`$\\]/g, "'")}"`, () => {});
  process.exitCode = 1;
});
