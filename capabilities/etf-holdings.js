// etf-holdings.js
//
// Returns top holdings, sector weights, and asset allocation for any US ETF
// via Yahoo Finance quoteSummary (topHoldings module). Works for equity ETFs
// (SPY, VOO, QQQ), bond ETFs (AGG, BND), sector ETFs (XLK, XLF), and thematic.
//
// Complements hedge-fund-holdings (13F institutional) and equity-fundamentals
// (single-stock valuation). Agents doing portfolio construction, factor exposure
// analysis, or ETF comparison need composition data without a Morningstar or
// FactSet subscription ($1,000+/yr). $0.018/call — on-demand, no subscription.
//
// Upstream: Yahoo Finance v10 quoteSummary, topHoldings module (free, crumb-auth).
// Same crumb pattern as equity-fundamentals.js.

const UA           = "Mozilla/5.0 (compatible; the-stall/4.11; +https://intuitek.ai)";
const YF_CRUMB_SRC = "https://fc.yahoo.com";
const YF_CRUMB_URL = "https://query2.finance.yahoo.com/v1/test/getcrumb";
const YF_SUMMARY   = "https://query2.finance.yahoo.com/v10/finance/quoteSummary";
const TMO          = 12_000;
const CRUMB_TTL    = 30 * 60 * 1000;

let _crumbCache = null;

function r2(n) { return n != null ? Math.round(n * 100) / 100 : null; }
function pct(n) { return n != null ? r2(n * 100) : null; }

function rawVal(field) {
  if (field === null || field === undefined) return null;
  if (typeof field === "number") return field;
  return field?.raw ?? null;
}

async function refreshCrumb() {
  const seedResp = await fetch(YF_CRUMB_SRC, {
    headers: { "User-Agent": UA },
    redirect: "follow",
    signal: AbortSignal.timeout(TMO),
  });
  const setCookies = seedResp.headers.getSetCookie?.() ?? [];
  const cookies = setCookies.map(c => c.split(";")[0]).join("; ");

  const crumbResp = await fetch(YF_CRUMB_URL, {
    headers: { "User-Agent": UA, "Cookie": cookies },
    signal: AbortSignal.timeout(TMO),
  });
  if (!crumbResp.ok) throw new Error(`crumb fetch failed: ${crumbResp.status}`);
  const crumb = (await crumbResp.text()).trim();
  if (!crumb) throw new Error("empty crumb");

  _crumbCache = { crumb, cookies, ts: Date.now() };
  return _crumbCache;
}

async function getCrumb() {
  if (_crumbCache && (Date.now() - _crumbCache.ts) < CRUMB_TTL) return _crumbCache;
  return refreshCrumb();
}

async function fetchTopHoldings(ticker, retry = true) {
  const { crumb, cookies } = await getCrumb();
  const modules = "topHoldings,summaryDetail,quoteType";
  const url = `${YF_SUMMARY}/${encodeURIComponent(ticker)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, "Cookie": cookies, "Accept": "application/json" },
    signal: AbortSignal.timeout(TMO),
  });
  if (resp.status === 401 && retry) {
    _crumbCache = null;
    return fetchTopHoldings(ticker, false);
  }
  if (!resp.ok) throw new Error(`Yahoo Finance returned ${resp.status}`);
  return resp.json();
}

export default {
  name:  "etf-holdings",
  price: "$0.059",

  description:
    "Top holdings, sector weights, and asset allocation for any US ETF (SPY, VOO, QQQ, AGG, XLK, etc.). Returns up to 25 positions with weights, sector breakdown, and stock/equity/bond/cash split. No API key. $0.018/call.",

  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description: "ETF ticker symbol (e.g. SPY, VOO, QQQ, AGG, XLK, VTI). Case-insensitive.",
      },
    },
    required: [],
  },

  outputSchema: {
    type: "object",
    properties: {
      ticker:      { type: "string",  description: "ETF ticker symbol." },
      name:        { type: "string",  description: "Full ETF name." },
      asset_class: { type: "string",  description: "Primary asset class (Equity, Fixed Income, etc.)." },
      asset_allocation: {
        type: "object",
        description: "Percentage allocation by asset type.",
        properties: {
          stock_pct:     { type: "number", description: "Equity allocation %." },
          bond_pct:      { type: "number", description: "Fixed income allocation %." },
          cash_pct:      { type: "number", description: "Cash and equivalents %." },
          other_pct:     { type: "number", description: "Other/alternative %." },
          preferred_pct: { type: "number", description: "Preferred stock %." },
        },
      },
      equity_profile: {
        type: "object",
        description: "Valuation/quality metrics of equity holdings (null for bond ETFs).",
        properties: {
          price_to_earnings: { type: "number", description: "Weighted average P/E." },
          price_to_book:     { type: "number", description: "Weighted average P/B." },
          price_to_sales:    { type: "number", description: "Weighted average P/S." },
          price_to_cashflow: { type: "number", description: "Weighted average P/CF." },
          earnings_growth_3y: { type: "number", description: "3-year earnings growth % (weighted avg)." },
        },
      },
      top_holdings: {
        type: "array",
        description: "Top holdings sorted by weight descending (up to 25 positions).",
        items: {
          type: "object",
          properties: {
            rank:    { type: "integer", description: "Position rank (1 = largest)." },
            ticker:  { type: "string",  description: "Holding ticker symbol." },
            name:    { type: "string",  description: "Holding company name." },
            weight_pct: { type: "number", description: "Portfolio weight %." },
          },
        },
      },
      sector_weights: {
        type: "array",
        description: "Sector allocation sorted by weight descending.",
        items: {
          type: "object",
          properties: {
            sector:     { type: "string", description: "Sector name." },
            weight_pct: { type: "number", description: "Sector weight %." },
          },
        },
      },
      total_top_weight_pct: {
        type: "number",
        description: "Combined weight of all returned top holdings %.",
      },
      retrieved_at: { type: "string", description: "ISO-8601 retrieval timestamp." },
    },
  },

  async handler({ ticker = "SPY" }) {
    const sym = ticker.trim().toUpperCase();

    const data = await fetchTopHoldings(sym);
    const result = data?.quoteSummary?.result?.[0];
    if (!result) {
      const err = data?.quoteSummary?.error?.description || "no data returned";
      throw new Error(`No ETF data for ${sym}: ${err}`);
    }

    const th = result.topHoldings  || {};
    const sd = result.summaryDetail || {};
    const qt = result.quoteType    || {};

    const name = qt.longName || qt.shortName || sym;
    const assetClass = qt.quoteType || "Unknown";

    // Asset allocation
    const allocation = {
      stock_pct:     pct(rawVal(th.stockPosition)),
      bond_pct:      pct(rawVal(th.bondPosition)),
      cash_pct:      pct(rawVal(th.cashPosition)),
      other_pct:     pct(rawVal(th.otherPosition)),
      preferred_pct: pct(rawVal(th.preferredPosition)),
    };

    // Equity profile
    const eq = th.equityHoldings || {};
    const equityProfile = {
      price_to_earnings:  r2(rawVal(eq.priceToEarnings)),
      price_to_book:      r2(rawVal(eq.priceToBook)),
      price_to_sales:     r2(rawVal(eq.priceToSales)),
      price_to_cashflow:  r2(rawVal(eq.priceToCashflow)),
      earnings_growth_3y: pct(rawVal(eq.threeYearEarningsGrowth)),
    };
    const hasEquityProfile = Object.values(equityProfile).some(v => v !== null);

    // Top holdings
    const holdings = (th.holdings || []).map((h, i) => ({
      rank:       i + 1,
      ticker:     h.symbol || null,
      name:       h.holdingName || null,
      weight_pct: pct(rawVal(h.holdingPercent)),
    }));

    const totalWeight = holdings.reduce((s, h) => s + (h.weight_pct ?? 0), 0);

    // Sector weights — YF returns [{realestate: N}, ...] format
    const sectors = (th.sectorWeightings || []).flatMap(obj =>
      Object.entries(obj).map(([sector, val]) => ({
        sector: sector.replace(/([A-Z])/g, " $1").trim(),
        weight_pct: pct(rawVal(val)),
      }))
    ).filter(s => s.weight_pct !== null && s.weight_pct > 0)
     .sort((a, b) => b.weight_pct - a.weight_pct);

    if (!holdings.length && !sectors.length) {
      throw new Error(`${sym} does not appear to be an ETF or has no holdings data`);
    }

    return {
      ticker: sym,
      name,
      asset_class: assetClass,
      asset_allocation: allocation,
      equity_profile: hasEquityProfile ? equityProfile : null,
      top_holdings: holdings,
      sector_weights: sectors,
      total_top_weight_pct: r2(totalWeight),
      retrieved_at: new Date().toISOString(),
    };
  },
};
