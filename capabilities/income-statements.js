// income-statements.js
//
// Full P&L + cash flow history for any US public company — quarterly or annual.
// Returns: revenue, COGS, gross profit, R&D, SG&A, operating income, EBITDA,
// pretax income, tax provision, net income, EPS, operating cash flow,
// capex, free cash flow — up to 8 quarters or 4 annual periods.
//
// Seam: stablefinance.dev/api/financials/income-statements — 8 payers,
//       48 calls, $0.020/call (first seen 2026-06-08). STALL at $0.015.
//
// Upstream: Yahoo Finance fundamentals timeseries v1 — free, crumb-auth, no API key.
// Better data quality than quoteSummary: returns actual reported values per period
// rather than trailing estimates.

const UA           = "Mozilla/5.0 (compatible; the-stall/4.9; +https://intuitek.ai)";
const YF_CRUMB_SRC = "https://fc.yahoo.com";
const YF_CRUMB_URL = "https://query2.finance.yahoo.com/v1/test/getcrumb";
const YF_TS_URL    = "https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries";
const TMO          = 14_000;
const CRUMB_TTL    = 30 * 60 * 1000;

let _crumbCache = null;

function r2(n) { return n != null ? Math.round(n * 100) / 100 : null; }
function r4(n) { return n != null ? Math.round(n * 10000) / 10000 : null; }

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

const QUARTERLY_TYPES = [
  "quarterlyTotalRevenue",
  "quarterlyCostOfRevenue",
  "quarterlyGrossProfit",
  "quarterlyResearchAndDevelopment",
  "quarterlySellingGeneralAndAdministration",
  "quarterlyOperatingExpense",
  "quarterlyOperatingIncome",
  "quarterlyEBITDA",
  "quarterlyPretaxIncome",
  "quarterlyTaxProvision",
  "quarterlyNetIncome",
  "quarterlyBasicEPS",
  "quarterlyDilutedEPS",
  "quarterlyOperatingCashFlow",
  "quarterlyCapitalExpenditure",
  "quarterlyFreeCashFlow",
];

const ANNUAL_TYPES = QUARTERLY_TYPES.map(t => t.replace("quarterly", "annual"));

const FIELD_MAP = {
  TotalRevenue:                  "total_revenue",
  CostOfRevenue:                 "cost_of_revenue",
  GrossProfit:                   "gross_profit",
  ResearchAndDevelopment:        "research_development",
  SellingGeneralAndAdministration: "selling_general_admin",
  OperatingExpense:              "total_operating_expense",
  OperatingIncome:               "operating_income",
  EBITDA:                        "ebitda",
  PretaxIncome:                  "pretax_income",
  TaxProvision:                  "tax_provision",
  NetIncome:                     "net_income",
  BasicEPS:                      "eps_basic",
  DilutedEPS:                    "eps_diluted",
  OperatingCashFlow:             "operating_cash_flow",
  CapitalExpenditure:            "capital_expenditures",
  FreeCashFlow:                  "free_cash_flow",
};

async function fetchTimeSeries(ticker, period, retry = true) {
  const { crumb, cookies } = await getCrumb();
  const types = period === "annual" ? ANNUAL_TYPES : QUARTERLY_TYPES;
  const now   = Math.floor(Date.now() / 1000);
  const past  = now - (period === "annual" ? 5 : 2) * 365 * 24 * 3600;

  const url = `${YF_TS_URL}/${encodeURIComponent(ticker)}?type=${types.join(",")}&period1=${past}&period2=${now}&crumb=${encodeURIComponent(crumb)}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, "Cookie": cookies, "Accept": "application/json" },
    signal: AbortSignal.timeout(TMO),
  });

  if (resp.status === 401 && retry) {
    _crumbCache = null;
    return fetchTimeSeries(ticker, period, false);
  }
  if (!resp.ok) throw new Error(`Yahoo Finance timeseries returned ${resp.status}`);
  return resp.json();
}

function pivot(results, period, limit) {
  const prefix = period === "annual" ? "annual" : "quarterly";
  const dateMap = {};

  for (const series of results) {
    const key = Object.keys(series).find(k => k.startsWith(prefix) && Array.isArray(series[k]));
    if (!key) continue;

    const suffix = key.slice(prefix.length); // e.g. "GrossProfit"
    const fieldName = FIELD_MAP[suffix];
    if (!fieldName) continue;

    for (const item of series[key]) {
      const date = item.asOfDate;
      if (!dateMap[date]) dateMap[date] = { period_end: date };
      const raw = item.reportedValue?.raw ?? null;
      dateMap[date][fieldName] = raw !== undefined ? raw : null;
    }
  }

  return Object.values(dateMap)
    .sort((a, b) => b.period_end.localeCompare(a.period_end))
    .slice(0, limit);
}

export default {
  name:  "income-statements",
  price: "$0.295",

  description:
    "Full income statement + cash flow history for any US public stock. " +
    "Returns quarterly (default, up to 8 periods) or annual (up to 4 years): " +
    "revenue, COGS, gross profit, R&D, SG&A, operating income, EBITDA, pretax income, " +
    "tax, net income, EPS (basic/diluted), operating cash flow, capex, free cash flow. " +
    "40% below stablefinance.dev/api/financials/income-statements ($0.020). " +
    "Per-ticker, entity-parametric — parallel-safe for batch financial analysis across company lists. " +
    "Source: Yahoo Finance fundamentals timeseries (free, no API key required).",

  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description: "Stock ticker symbol (e.g. 'AAPL', 'MSFT', 'NVDA', 'TSLA').",
      },
      period: {
        type: "string",
        enum: ["quarterly", "annual"],
        description: "Period type. Default: 'quarterly' (up to 8 recent quarters). 'annual' returns up to 4 fiscal years.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 8,
        description: "Max periods to return (1–8 for quarterly; 1–4 for annual). Default: 4.",
      },
    },
    required: [],
  },

  outputSchema: {
    type: "object",
    properties: {
      ticker:      { type: "string" },
      period_type: { type: "string" },
      currency:    { type: "string" },
      periods: {
        type: "array",
        description: "Periods most-recent-first. All monetary values in USD.",
        items: {
          type: "object",
          properties: {
            period_end:               { type: "string" },
            total_revenue:            { type: "number" },
            cost_of_revenue:          { type: "number" },
            gross_profit:             { type: "number" },
            research_development:     { type: "number" },
            selling_general_admin:    { type: "number" },
            total_operating_expense:  { type: "number" },
            operating_income:         { type: "number" },
            ebitda:                   { type: "number" },
            pretax_income:            { type: "number" },
            tax_provision:            { type: "number" },
            net_income:               { type: "number" },
            eps_basic:                { type: "number" },
            eps_diluted:              { type: "number" },
            operating_cash_flow:      { type: "number" },
            capital_expenditures:     { type: "number" },
            free_cash_flow:           { type: "number" },
          },
        },
      },
      retrieved_at: { type: "string" },
    },
  },

  async handler({ ticker = "AAPL", period = "quarterly", limit = 4 }) {
    const sym      = ticker.trim().toUpperCase();
    const maxLimit = Math.min(Math.max(1, limit), period === "annual" ? 4 : 8);

    const data    = await fetchTimeSeries(sym, period);
    const results = data?.timeseries?.result ?? [];

    if (!results.length) {
      throw new Error(`No ${period} financials found for ${sym}`);
    }

    const periods = pivot(results, period, maxLimit);

    if (!periods.length) {
      throw new Error(`No ${period} income statement periods found for ${sym}`);
    }

    return {
      ticker:      sym,
      period_type: period,
      currency:    "USD",
      periods,
      retrieved_at: new Date().toISOString(),
    };
  },
};
