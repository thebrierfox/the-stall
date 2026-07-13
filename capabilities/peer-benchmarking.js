// peer-benchmarking.js
//
// Comparable-company analysis for any US stock. Fetches the target stock's
// valuation, growth, and profitability metrics, identifies 5 sector peers via
// Yahoo Finance recommendations, fetches the same metrics for each peer, then
// computes peer medians and explicit premium/discount % for the target.
//
// Replaces the manual "comps table" step in equity research workflows.
// Agents building investment theses, screening tools, or trading models
// currently chain equity-fundamentals + analyst-ratings with no peer context —
// this cap closes that gap at $0.10, below the cost of a full equity-brief ($0.35).
//
// Upstream: Yahoo Finance quoteSummary (crumb-auth, free) + recommendationsbysymbol (no-auth).
// All 6 fetches (1 target + 5 peers) run in parallel after the crumb is obtained.

const UA           = "Mozilla/5.0 (compatible; the-stall/4.9; +https://intuitek.ai)";
const YF_CRUMB_SRC = "https://fc.yahoo.com";
const YF_CRUMB_URL = "https://query2.finance.yahoo.com/v1/test/getcrumb";
const YF_SUMMARY   = "https://query2.finance.yahoo.com/v10/finance/quoteSummary";
const YF_RECS      = "https://query2.finance.yahoo.com/v6/finance/recommendationsbysymbol";
const MODULES      = "defaultKeyStatistics,financialData,summaryDetail,summaryProfile";
const CRUMB_TTL    = 30 * 60 * 1000;
const TMO          = 14_000;

let _crumbCache = null;

function r2(n) { return n != null ? Math.round(n * 100) / 100 : null; }
function pct(n) { return n != null ? r2(n * 100) : null; }
function rawVal(f) { if (f == null) return null; if (typeof f === "number") return f; return f?.raw ?? null; }

async function refreshCrumb() {
  const seed = await fetch(YF_CRUMB_SRC, {
    headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(TMO),
  });
  const cookies = (seed.headers.getSetCookie?.() ?? []).map(c => c.split(";")[0]).join("; ");
  const cr = await fetch(YF_CRUMB_URL, {
    headers: { "User-Agent": UA, "Cookie": cookies }, signal: AbortSignal.timeout(TMO),
  });
  if (!cr.ok) throw new Error(`crumb fetch ${cr.status}`);
  const crumb = (await cr.text()).trim();
  if (!crumb) throw new Error("empty crumb");
  _crumbCache = { crumb, cookies, ts: Date.now() };
  return _crumbCache;
}

async function getCrumb() {
  if (_crumbCache && (Date.now() - _crumbCache.ts) < CRUMB_TTL) return _crumbCache;
  return refreshCrumb();
}

async function fetchSummary(ticker, retry = true) {
  const { crumb, cookies } = await getCrumb();
  const url = `${YF_SUMMARY}/${encodeURIComponent(ticker)}?modules=${MODULES}&crumb=${encodeURIComponent(crumb)}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, "Cookie": cookies, "Accept": "application/json" },
    signal: AbortSignal.timeout(TMO),
  });
  if (resp.status === 401 && retry) { _crumbCache = null; return fetchSummary(ticker, false); }
  if (!resp.ok) throw new Error(`YF ${resp.status} for ${ticker}`);
  return resp.json();
}

function extractMetrics(data, ticker) {
  const r = data?.quoteSummary?.result?.[0];
  if (!r) return null;
  const ks = r.defaultKeyStatistics || {};
  const fd = r.financialData        || {};
  const sd = r.summaryDetail        || {};
  const sp = r.summaryProfile       || {};
  const qi = r.quoteType            || {};
  return {
    ticker:              ticker.toUpperCase(),
    name:                qi.longName || qi.shortName || null,
    sector:              sp.sector   || null,
    industry:            sp.industry || null,
    pe_trailing:         r2(rawVal(sd.trailingPE)  ?? rawVal(ks.trailingPE)),
    pe_forward:          r2(rawVal(sd.forwardPE)   ?? rawVal(ks.forwardPE)),
    ev_to_ebitda:        r2(rawVal(ks.enterpriseToEbitda)),
    price_to_sales:      r2(rawVal(sd.priceToSalesTrailingTwelveMonths)),
    price_to_book:       r2(rawVal(ks.priceToBook)),
    revenue_growth_pct:  pct(rawVal(fd.revenueGrowth)),
    earnings_growth_pct: pct(rawVal(fd.earningsGrowth)),
    profit_margin_pct:   pct(rawVal(fd.profitMargins) ?? rawVal(ks.profitMargins)),
    gross_margin_pct:    pct(rawVal(fd.grossMargins)),
    roe_pct:             pct(rawVal(fd.returnOnEquity)),
    market_cap_b:        r2((rawVal(sd.marketCap) ?? 0) / 1e9) || null,
  };
}

async function getPeerSymbols(ticker) {
  try {
    const resp = await fetch(`${YF_RECS}/${encodeURIComponent(ticker)}`, {
      headers: { "User-Agent": UA, "Accept": "application/json" },
      signal: AbortSignal.timeout(TMO),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data?.finance?.result?.[0]?.recommendedSymbols ?? [])
      .slice(0, 5).map(s => s.symbol).filter(Boolean);
  } catch { return []; }
}

function median(arr) {
  const nums = arr.filter(n => n != null && isFinite(n)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : r2((nums[mid - 1] + nums[mid]) / 2);
}

function vsPeers(target, med) {
  if (target == null || med == null || med === 0) return null;
  return r2(((target - med) / Math.abs(med)) * 100);
}

export default {
  name:  "peer-benchmarking",
  price: "$0.100",

  description:
    "Comparable-company analysis for any US stock. Returns target vs. 5 sector-peer median on P/E, EV/EBITDA, revenue growth, and profit margin — with explicit premium/discount %. Replaces manual comps-table research. No API key required.",

  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description: "US stock ticker symbol (e.g. AAPL, NVDA, MSFT). Case-insensitive.",
      },
    },
    required: [],
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      ticker:   { type: "string" },
      name:     { type: ["string","null"] },
      sector:   { type: ["string","null"] },
      industry: { type: ["string","null"] },
      target: {
        type: "object",
        description: "Target stock metrics.",
        properties: {
          pe_trailing:          { type: ["number","null"] },
          pe_forward:           { type: ["number","null"] },
          ev_to_ebitda:         { type: ["number","null"] },
          price_to_sales:       { type: ["number","null"] },
          price_to_book:        { type: ["number","null"] },
          revenue_growth_pct:   { type: ["number","null"], description: "YoY revenue growth %." },
          earnings_growth_pct:  { type: ["number","null"], description: "YoY earnings growth %." },
          profit_margin_pct:    { type: ["number","null"] },
          gross_margin_pct:     { type: ["number","null"] },
          roe_pct:              { type: ["number","null"] },
          market_cap_b:         { type: ["number","null"], description: "Market cap in billions." },
        },
      },
      peer_median: {
        type: "object",
        description: "Median value across 5 sector peers for each metric.",
        properties: {
          pe_trailing:          { type: ["number","null"] },
          pe_forward:           { type: ["number","null"] },
          ev_to_ebitda:         { type: ["number","null"] },
          price_to_sales:       { type: ["number","null"] },
          price_to_book:        { type: ["number","null"] },
          revenue_growth_pct:   { type: ["number","null"] },
          earnings_growth_pct:  { type: ["number","null"] },
          profit_margin_pct:    { type: ["number","null"] },
          gross_margin_pct:     { type: ["number","null"] },
          roe_pct:              { type: ["number","null"] },
        },
      },
      vs_peers: {
        type: "object",
        description: "Target premium (+) or discount (–) to peer median, in percentage points.",
        properties: {
          pe_trailing_pct:    { type: ["number","null"], description: "PE premium/discount vs peers (%)." },
          pe_forward_pct:     { type: ["number","null"] },
          ev_to_ebitda_pct:   { type: ["number","null"] },
          price_to_sales_pct: { type: ["number","null"] },
          revenue_growth_pct: { type: ["number","null"], description: "Revenue growth advantage/disadvantage vs peers (pp)." },
          profit_margin_pct:  { type: ["number","null"] },
        },
      },
      peers: {
        type: "array",
        description: "Individual peer company metrics (up to 5).",
        items: {
          type: "object",
          properties: {
            ticker:              { type: "string" },
            name:                { type: ["string","null"] },
            pe_trailing:         { type: ["number","null"] },
            pe_forward:          { type: ["number","null"] },
            ev_to_ebitda:        { type: ["number","null"] },
            revenue_growth_pct:  { type: ["number","null"] },
            profit_margin_pct:   { type: ["number","null"] },
            market_cap_b:        { type: ["number","null"] },
          },
        },
      },
      peer_count: { type: "number", description: "Number of peers successfully fetched." },
      ts:         { type: "string", description: "ISO-8601 response timestamp." },
    },
  },

  async handler({ ticker = "AAPL" }) {
    const sym = ticker.trim().toUpperCase();

    // Fetch target data and peer symbols in parallel
    const [targetData, peerSyms] = await Promise.all([
      fetchSummary(sym),
      getPeerSymbols(sym),
    ]);

    const t = extractMetrics(targetData, sym);
    if (!t) throw new Error(`No data returned for ${sym}`);

    // Fetch all peer metrics in parallel (best-effort)
    const peerResults = await Promise.all(
      peerSyms.map(ps =>
        fetchSummary(ps)
          .then(d => extractMetrics(d, ps))
          .catch(() => null)
      )
    );
    const peers = peerResults.filter(Boolean);

    // Compute peer medians
    const KEYS = ["pe_trailing","pe_forward","ev_to_ebitda","price_to_sales",
                  "price_to_book","revenue_growth_pct","earnings_growth_pct",
                  "profit_margin_pct","gross_margin_pct","roe_pct"];
    const peerMedian = {};
    for (const k of KEYS) peerMedian[k] = median(peers.map(p => p[k]));

    return {
      ticker:   t.ticker,
      name:     t.name,
      sector:   t.sector,
      industry: t.industry,
      target: {
        pe_trailing:         t.pe_trailing,
        pe_forward:          t.pe_forward,
        ev_to_ebitda:        t.ev_to_ebitda,
        price_to_sales:      t.price_to_sales,
        price_to_book:       t.price_to_book,
        revenue_growth_pct:  t.revenue_growth_pct,
        earnings_growth_pct: t.earnings_growth_pct,
        profit_margin_pct:   t.profit_margin_pct,
        gross_margin_pct:    t.gross_margin_pct,
        roe_pct:             t.roe_pct,
        market_cap_b:        t.market_cap_b,
      },
      peer_median: peerMedian,
      vs_peers: {
        pe_trailing_pct:    vsPeers(t.pe_trailing,        peerMedian.pe_trailing),
        pe_forward_pct:     vsPeers(t.pe_forward,         peerMedian.pe_forward),
        ev_to_ebitda_pct:   vsPeers(t.ev_to_ebitda,       peerMedian.ev_to_ebitda),
        price_to_sales_pct: vsPeers(t.price_to_sales,     peerMedian.price_to_sales),
        revenue_growth_pct: vsPeers(t.revenue_growth_pct, peerMedian.revenue_growth_pct),
        profit_margin_pct:  vsPeers(t.profit_margin_pct,  peerMedian.profit_margin_pct),
      },
      peers: peers.map(p => ({
        ticker:             p.ticker,
        name:               p.name,
        pe_trailing:        p.pe_trailing,
        pe_forward:         p.pe_forward,
        ev_to_ebitda:       p.ev_to_ebitda,
        revenue_growth_pct: p.revenue_growth_pct,
        profit_margin_pct:  p.profit_margin_pct,
        market_cap_b:       p.market_cap_b,
      })),
      peer_count: peers.length,
      ts: new Date().toISOString(),
    };
  },
};
