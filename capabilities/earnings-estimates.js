// earnings-estimates.js
//
// Forward analyst consensus EPS and revenue estimates for any US stock.
// Covers current-quarter, next-quarter, current-year, and next-year with
// estimate revision momentum (revisions up vs down last 7 and 30 days)
// and EPS trend drift (current estimate vs 30/60/90 days ago).
//
// Bridges the gap between historical earnings-surprises (backward-looking)
// and equity-fundamentals (trailing metrics). Agents building DCF models,
// running estimate-revision momentum screens, or staging catalyst calendars
// need forward consensus without paying for narrative synthesis (equity-brief).
//
// Upstream: Yahoo Finance quoteSummary earningsTrend (free, crumb-auth).
// Priced at $0.012.

const UA           = "Mozilla/5.0 (compatible; the-stall/4.10; +https://intuitek.ai)";
const YF_CRUMB_SRC = "https://fc.yahoo.com";
const YF_CRUMB_URL = "https://query2.finance.yahoo.com/v1/test/getcrumb";
const YF_SUMMARY   = "https://query2.finance.yahoo.com/v10/finance/quoteSummary";
const MODULES      = "earningsTrend";
const TMO          = 12_000;
const CRUMB_TTL    = 30 * 60 * 1000;

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

function parsePeriod(trend) {
  const eps  = trend.earningsEstimate  || {};
  const rev  = trend.revenueEstimate   || {};
  const epsT = trend.epsTrend          || {};
  const epsR = trend.epsRevisions      || {};

  return {
    period:   trend.period,
    end_date: trend.endDate || null,
    eps_estimate: {
      avg:          r2(rawVal(eps.avg)),
      low:          r2(rawVal(eps.low)),
      high:         r2(rawVal(eps.high)),
      year_ago_eps: r2(rawVal(eps.yearAgoEps)),
      growth_pct:   pct(rawVal(eps.growth)),
      num_analysts: rawVal(eps.numberOfAnalysts),
    },
    revenue_estimate: {
      avg:          rawVal(rev.avg),
      low:          rawVal(rev.low),
      high:         rawVal(rev.high),
      year_ago:     rawVal(rev.yearAgoRevenue),
      growth_pct:   pct(rawVal(rev.growth)),
      num_analysts: rawVal(rev.numberOfAnalysts),
    },
    eps_trend: {
      current:     r2(rawVal(epsT.current)),
      days_7_ago:  r2(rawVal(epsT["7daysAgo"])),
      days_30_ago: r2(rawVal(epsT["30daysAgo"])),
      days_60_ago: r2(rawVal(epsT["60daysAgo"])),
      days_90_ago: r2(rawVal(epsT["90daysAgo"])),
    },
    revisions: {
      up_last_7d:    rawVal(epsR.upLast7days),
      up_last_30d:   rawVal(epsR.upLast30days),
      down_last_30d: rawVal(epsR.downLast30days),
      down_last_90d: rawVal(epsR.downLast90days),
    },
  };
}

export default {
  name:  "earnings-estimates",
  price: "$0.079",

  description:
    "Forward analyst consensus EPS and revenue estimates for any US stock. Returns current-quarter, " +
    "next-quarter, current-year, and next-year forecasts — avg/low/high EPS and revenue, YoY growth, " +
    "analyst count, estimate revision momentum (revisions up vs down last 7/30 days), and EPS trend " +
    "drift (current vs 30/60/90 days ago). Bridges the gap between historical earnings-surprises and " +
    "trailing equity-fundamentals for DCF inputs and estimate-revision momentum screens. " +
    "Free upstream: Yahoo Finance (no API key required).",

  inputSchema: {
    type: "object",
    required: ["symbol"],
    properties: {
      symbol: {
        type: "string",
        description: "US equity ticker symbol (e.g. 'AAPL', 'MSFT', 'NVDA').",
      },
    },
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      symbol: { type: "string" },
      periods: {
        type: "object",
        description: "Estimates keyed by period: current_quarter, next_quarter, current_year, next_year.",
        additionalProperties: {
          type: "object",
          properties: {
            period:   { type: "string", description: "Yahoo period code (0q, +1q, 0y, +1y)." },
            end_date: { type: ["string", "null"] },
            eps_estimate: {
              type: "object",
              properties: {
                avg:          { type: ["number", "null"], description: "Mean EPS estimate." },
                low:          { type: ["number", "null"] },
                high:         { type: ["number", "null"] },
                year_ago_eps: { type: ["number", "null"] },
                growth_pct:   { type: ["number", "null"], description: "Forecast YoY EPS growth %." },
                num_analysts: { type: ["integer", "null"] },
              },
            },
            revenue_estimate: {
              type: "object",
              properties: {
                avg:          { type: ["number", "null"], description: "Mean revenue estimate (USD)." },
                low:          { type: ["number", "null"] },
                high:         { type: ["number", "null"] },
                year_ago:     { type: ["number", "null"] },
                growth_pct:   { type: ["number", "null"], description: "Forecast YoY revenue growth %." },
                num_analysts: { type: ["integer", "null"] },
              },
            },
            eps_trend: {
              type: "object",
              description: "How the mean EPS estimate has drifted. Rising = positive revision momentum.",
              properties: {
                current:     { type: ["number", "null"] },
                days_7_ago:  { type: ["number", "null"] },
                days_30_ago: { type: ["number", "null"] },
                days_60_ago: { type: ["number", "null"] },
                days_90_ago: { type: ["number", "null"] },
              },
            },
            revisions: {
              type: "object",
              description: "Analyst estimate revision counts. More ups than downs = bullish momentum.",
              properties: {
                up_last_7d:    { type: ["integer", "null"] },
                up_last_30d:   { type: ["integer", "null"] },
                down_last_30d: { type: ["integer", "null"] },
                down_last_90d: { type: ["integer", "null"] },
              },
            },
          },
        },
      },
      related_capabilities: {
        type: "array",
        description: "Other STALL caps for equity research workflows.",
        items: {
          type: "object",
          properties: {
            cap:         { type: "string" },
            description: { type: "string" },
            price:       { type: "string" },
          },
        },
      },
      ts: { type: "string", description: "ISO-8601 response timestamp." },
    },
  },

  async handler(query) {
    const symbol = (query.symbol || "").toUpperCase().trim();
    if (!symbol) throw Object.assign(new Error("symbol is required"), { status: 400 });

    const { crumb, cookies } = await getCrumb();
    const url = `${YF_SUMMARY}/${encodeURIComponent(symbol)}?modules=${MODULES}&crumb=${encodeURIComponent(crumb)}`;

    const resp = await fetch(url, {
      headers: { "User-Agent": UA, "Cookie": cookies },
      signal: AbortSignal.timeout(TMO),
    });
    if (!resp.ok) {
      const body = await resp.text();
      if (resp.status === 404 || body.includes("No fundamentals data")) {
        throw Object.assign(new Error(`symbol not found: ${symbol}`), { status: 404 });
      }
      throw new Error(`YF quoteSummary ${resp.status}: ${body.slice(0, 120)}`);
    }

    const data = await resp.json();
    const result = data?.quoteSummary?.result?.[0];
    if (!result) throw new Error("no quoteSummary result for symbol");

    const trends = result.earningsTrend?.trend ?? [];
    if (!trends.length) {
      throw Object.assign(
        new Error(`no earningsTrend data for ${symbol} — non-US or non-earnings ticker`),
        { status: 404 },
      );
    }

    const PERIOD_MAP = {
      "0q":  "current_quarter",
      "+1q": "next_quarter",
      "0y":  "current_year",
      "+1y": "next_year",
    };
    const periods = {};
    for (const t of trends) {
      const key = PERIOD_MAP[t.period] || t.period;
      periods[key] = parsePeriod(t);
    }

    return {
      symbol,
      periods,
      related_capabilities: [
        { cap: "earnings-surprises",  description: "Historical EPS beat/miss data — actual vs consensus, % surprise, reaction.",    price: "$0.010" },
        { cap: "equity-fundamentals", description: "Trailing P/E, EV/EBITDA, margins, FCF, ROE — DCF inputs from financials.",       price: "$0.020" },
        { cap: "analyst-ratings",     description: "Buy/hold/sell counts, mean recommendation score, and price target consensus.",  price: "$0.010" },
        { cap: "earnings-calendar",   description: "Upcoming earnings dates and consensus EPS estimate for a ticker or date range.", price: "$0.010" },
        { cap: "peer-benchmarking",   description: "Comps table: 5 sector peers with valuation/growth/profitability vs target.",    price: "$0.100" },
      ],
      ts: new Date().toISOString(),
    };
  },
};
