// earnings-surprises.js
//
// Historical EPS beat/miss data for any US stock: actual vs estimate, surprise
// %, beat rate, estimate revisions, and next earnings date.
//
// Seam: equity-research agents running post-earnings strategies, drift models,
// and EPS revision screens need the raw surprise history — not just current
// price. equity-brief ($0.350) synthesises this into prose; this cap returns
// the structured data at $0.010, pairing with analyst-ratings and
// equity-fundamentals for a complete earnings intelligence stack.
//
// Source: Yahoo Finance quoteSummary (earnings + earningsTrend + calendarEvents
// + quoteType modules). Crumb-auth required (v10 endpoint); same refresh
// pattern used by analyst-ratings.js and equity-fundamentals.js.

const UA           = "Mozilla/5.0 (compatible; the-stall/4.8; +https://intuitek.ai)";
const YF_CRUMB_SRC = "https://fc.yahoo.com";
const YF_CRUMB_URL = "https://query2.finance.yahoo.com/v1/test/getcrumb";
const YF_SUMMARY   = "https://query2.finance.yahoo.com/v10/finance/quoteSummary";
const TMO          = 12_000;
const CRUMB_TTL    = 30 * 60 * 1000; // 30 min

let _crumbCache = null; // { crumb, cookies, ts }

function r2(n) { return n != null ? Math.round(n * 100) / 100 : null; }

function rawVal(field) {
  if (field == null) return null;
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
  const cookies   = setCookies.map(c => c.split(";")[0]).join("; ");
  const crumbResp = await fetch(YF_CRUMB_URL, {
    headers: { "User-Agent": UA, "Cookie": cookies },
    signal: AbortSignal.timeout(TMO),
  });
  if (!crumbResp.ok) throw new Error(`crumb fetch failed: ${crumbResp.status}`);
  const crumb = (await crumbResp.text()).trim();
  if (!crumb) throw new Error("empty crumb returned");
  _crumbCache = { crumb, cookies, ts: Date.now() };
  return _crumbCache;
}

async function getCrumb() {
  if (_crumbCache && (Date.now() - _crumbCache.ts) < CRUMB_TTL) return _crumbCache;
  return refreshCrumb();
}

async function fetchQuoteSummary(ticker, modules, retry = true) {
  const { crumb, cookies } = await getCrumb();
  const url = `${YF_SUMMARY}/${encodeURIComponent(ticker)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, "Cookie": cookies, "Accept": "application/json" },
    signal: AbortSignal.timeout(TMO),
  });
  if (resp.status === 401 && retry) {
    _crumbCache = null;
    return fetchQuoteSummary(ticker, modules, false);
  }
  if (!resp.ok) throw new Error(`Yahoo Finance returned ${resp.status}`);
  return resp.json();
}

function isoDate(epochSec) {
  if (!epochSec) return null;
  return new Date(epochSec * 1000).toISOString().slice(0, 10);
}

export default {
  name: "earnings-surprises",
  price: "$0.099",

  description:
    "Historical EPS beat/miss data for any US stock: actual EPS, consensus estimate, surprise %, beat rate, estimate revisions (30-day EPS drift), and next earnings date. Per-ticker, entity-parametric — parallel-safe for batch earnings analysis pipelines. Free Yahoo Finance data, no API key. Pairs with earnings-calendar and equity-fundamentals for a complete earnings intelligence stack.",

  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description: "US stock ticker symbol (e.g. AAPL, NVDA, MSFT). Case-insensitive.",
      },
      quarters: {
        type: "integer",
        description: "Number of past quarters to return (1-8, default 4).",
        minimum: 1,
        maximum: 8,
        default: 4,
      },
    },
    required: [],
  },

  outputSchema: {
    type: "object",
    properties: {
      ticker:   { type: "string",  description: "Canonical ticker symbol." },
      name:     { type: "string",  description: "Company name." },
      quarterly: {
        type: "array",
        description: "Historical quarterly EPS results, newest first.",
        items: {
          type: "object",
          properties: {
            period:           { type: "string",  description: "Calendar quarter label (e.g. 2Q2025)." },
            fiscal_quarter:   { type: "string",  description: "Fiscal quarter label (e.g. 3Q2025)." },
            actual_eps:       { type: "number",  description: "Reported EPS (USD)." },
            estimate_eps:     { type: "number",  description: "Consensus EPS estimate at time of report (USD)." },
            surprise_pct:     { type: "number",  description: "EPS surprise % (positive = beat, negative = miss)." },
            reported_date:    { type: "string",  description: "ISO date when earnings were reported." },
            period_end_date:  { type: "string",  description: "ISO date of fiscal period end." },
          },
        },
      },
      beat_rate_pct:              { type: "number",  description: "% of quarters in sample where actual EPS beat estimate." },
      avg_surprise_pct:           { type: "number",  description: "Average EPS surprise % across the sample." },
      next_earnings_date:         { type: "string",  description: "ISO date of next expected earnings report (if announced)." },
      current_quarter_estimate:   { type: "number",  description: "Current consensus EPS estimate for next unreported quarter (USD)." },
      estimate_revision_30d_pct:  { type: "number",  description: "% change in current quarter EPS estimate over last 30 days. Positive = upward revisions." },
      annual: {
        type: "array",
        description: "Annual revenue and earnings history, newest first.",
        items: {
          type: "object",
          properties: {
            year:              { type: "integer", description: "Fiscal year (e.g. 2025)." },
            revenue_usd:       { type: "number",  description: "Annual revenue in USD." },
            net_income_usd:    { type: "number",  description: "Annual net income in USD." },
            profit_margin_pct: { type: "number",  description: "Net profit margin %." },
          },
        },
      },
      ts: { type: "string", description: "ISO-8601 timestamp of this response." },
    },
  },

  async handler(query) {
    const rawTicker = (query.ticker || "AAPL").trim();
    const ticker  = rawTicker.toUpperCase().replace(/[^A-Z0-9.\-^]/g, "");
    if (!ticker) throw new Error("invalid ticker symbol");
    const quarters = Math.min(8, Math.max(1, Number(query.quarters) || 4));

    let data;
    try {
      data = await fetchQuoteSummary(ticker, "earnings,earningsTrend,calendarEvents,quoteType");
    } catch (err) {
      throw new Error(`upstream fetch failed: ${err.message}`);
    }

    const result = data?.quoteSummary?.result?.[0];
    if (!result) {
      const errMsg = data?.quoteSummary?.error?.description || "no data";
      throw new Error(`no earnings data for "${ticker}": ${errMsg}`);
    }

    const earnChart = result?.earnings?.earningsChart     || {};
    const annChart  = result?.earnings?.financialsChart   || {};
    const trend     = result?.earningsTrend?.trend        || [];
    const calendar  = result?.calendarEvents?.earnings    || {};
    const qt        = result?.quoteType                   || {};

    // Quarterly history — newest first
    const rawQtrs = (earnChart.quarterly || []).slice().reverse().slice(0, quarters);
    const quarterly = rawQtrs.map(q => {
      const actual   = rawVal(q.actual);
      const estimate = rawVal(q.estimate);
      const surp     = rawVal(q.surprisePct);
      return {
        period:          q.date        || null,
        fiscal_quarter:  q.fiscalQuarter || null,
        actual_eps:      r2(actual),
        estimate_eps:    r2(estimate),
        surprise_pct:    surp != null ? r2(surp) : (actual != null && estimate != null && estimate !== 0
                           ? r2(((actual - estimate) / Math.abs(estimate)) * 100)
                           : null),
        reported_date:   isoDate(rawVal(q.reportedDate)),
        period_end_date: isoDate(rawVal(q.periodEndDate)),
      };
    });

    // Beat rate and average surprise
    const beats = quarterly.filter(q => q.surprise_pct != null && q.surprise_pct > 0);
    const valid  = quarterly.filter(q => q.surprise_pct != null);
    const beat_rate_pct  = valid.length ? r2((beats.length / valid.length) * 100) : null;
    const avg_surprise   = valid.length ? r2(valid.reduce((s, q) => s + q.surprise_pct, 0) / valid.length) : null;

    // Next earnings date
    const nextDates = calendar.earningsDate || [];
    const nextEarningsDate = nextDates.length ? isoDate(rawVal(nextDates[0])) : null;

    // Current quarter estimate and 30-day revision
    const currentTrend   = trend[0]?.epsTrend || {};
    const curEst         = rawVal(currentTrend.current);
    const est30dAgo      = rawVal(currentTrend["30daysAgo"]);
    const rev30d         = (curEst != null && est30dAgo != null && est30dAgo !== 0)
      ? r2(((curEst - est30dAgo) / Math.abs(est30dAgo)) * 100)
      : null;

    // Annual history — newest first
    const rawAnnual = (annChart.yearly || []).slice().reverse().slice(0, 4);
    const annual = rawAnnual.map(y => {
      const rev    = rawVal(y.revenue);
      const earn   = rawVal(y.earnings);
      const margin = rawVal(y.profitMargin);
      return {
        year:              y.date || null,
        revenue_usd:       rev,
        net_income_usd:    earn,
        profit_margin_pct: margin != null ? r2(margin * 100) : null,
      };
    });

    return {
      ticker,
      name:                      qt.longName || qt.shortName || ticker,
      quarterly,
      beat_rate_pct,
      avg_surprise_pct:          avg_surprise,
      next_earnings_date:        nextEarningsDate,
      current_quarter_estimate:  r2(curEst),
      estimate_revision_30d_pct: rev30d,
      annual,
      ts: new Date().toISOString(),
    };
  },
};
