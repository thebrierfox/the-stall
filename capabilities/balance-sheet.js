// balance-sheet.js
//
// Quarterly or annual balance sheet history for any US public company.
// Returns: cash & equivalents, short-term investments, total assets, total debt,
// net debt, total liabilities, stockholders' equity, book value (common equity),
// retained earnings, goodwill & intangibles, tangible book value, shares outstanding,
// current assets, current liabilities, and working capital.
//
// Fills the gap between income-statements (P&L + cash flow) and the equity
// research toolkit: agents building DCF models need total debt and net cash to
// compute Enterprise Value (EV = market cap + net debt). Balance sheet health
// (leverage ratios, working capital, book value) is also the primary input for
// distress screening, credit analysis, and bank/insurance equity research.
//
// Upstream: Yahoo Finance fundamentals timeseries v1 (free, crumb-auth, no API key).
// Same data source and quality as income-statements. Priced at $0.015.

const UA           = "Mozilla/5.0 (compatible; the-stall/4.10; +https://intuitek.ai)";
const YF_CRUMB_SRC = "https://fc.yahoo.com";
const YF_CRUMB_URL = "https://query2.finance.yahoo.com/v1/test/getcrumb";
const YF_TS_URL    = "https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries";
const TMO          = 14_000;
const CRUMB_TTL    = 30 * 60 * 1000;

let _crumbCache = null;

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
  "quarterlyCashAndCashEquivalents",
  "quarterlyShortTermInvestments",
  "quarterlyCurrentAssets",
  "quarterlyTotalAssets",
  "quarterlyCurrentLiabilities",
  "quarterlyTotalDebt",
  "quarterlyNetDebt",
  "quarterlyTotalLiabilitiesNetMinorityInterest",
  "quarterlyStockholdersEquity",
  "quarterlyCommonStockEquity",
  "quarterlyRetainedEarnings",
  "quarterlyGoodwillAndOtherIntangibleAssets",
  "quarterlyShareIssued",
];

const ANNUAL_TYPES = QUARTERLY_TYPES.map(t => t.replace("quarterly", "annual"));

// Maps the YF suffix (after "quarterly"/"annual") → output field name
const FIELD_MAP = {
  CashAndCashEquivalents:              "cash",
  ShortTermInvestments:                "short_term_investments",
  CurrentAssets:                       "current_assets",
  TotalAssets:                         "total_assets",
  CurrentLiabilities:                  "current_liabilities",
  TotalDebt:                           "total_debt",
  NetDebt:                             "net_debt",
  TotalLiabilitiesNetMinorityInterest: "total_liabilities",
  StockholdersEquity:                  "stockholders_equity",
  CommonStockEquity:                   "book_value",
  RetainedEarnings:                    "retained_earnings",
  GoodwillAndOtherIntangibleAssets:    "goodwill_intangibles",
  ShareIssued:                         "shares_outstanding",
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

    const suffix    = key.slice(prefix.length); // e.g. "TotalDebt"
    const fieldName = FIELD_MAP[suffix];
    if (!fieldName) continue;

    for (const item of series[key]) {
      const date = item.asOfDate;
      if (!dateMap[date]) dateMap[date] = { period_end: date };
      const raw = item.reportedValue?.raw ?? null;
      dateMap[date][fieldName] = raw !== undefined ? raw : null;
    }
  }

  // Compute derived fields after pivoting
  for (const row of Object.values(dateMap)) {
    // working_capital = current_assets - current_liabilities
    if (row.current_assets != null && row.current_liabilities != null) {
      row.working_capital = row.current_assets - row.current_liabilities;
    } else {
      row.working_capital = null;
    }
    // tangible_book_value = book_value - goodwill & intangibles
    if (row.book_value != null && row.goodwill_intangibles != null) {
      row.tangible_book_value = row.book_value - row.goodwill_intangibles;
    } else {
      row.tangible_book_value = null;
    }
    // net_cash (positive = cash > debt; negative = levered) derived from net_debt
    if (row.net_debt != null) {
      row.net_cash = -row.net_debt;
    } else if (row.cash != null && row.total_debt != null) {
      row.net_cash = (row.cash + (row.short_term_investments ?? 0)) - row.total_debt;
    } else {
      row.net_cash = null;
    }
  }

  return Object.values(dateMap)
    .sort((a, b) => b.period_end.localeCompare(a.period_end))
    .slice(0, limit);
}

export default {
  name:  "balance-sheet",
  price: "$0.021",

  description:
    "Quarterly or annual balance sheet history for any US public stock. Returns cash & equivalents, " +
    "short-term investments, total assets, total debt, net debt, total liabilities, stockholders' equity, " +
    "book value, retained earnings, goodwill & intangibles, tangible book value, working capital, " +
    "and shares outstanding. Quarterly default (up to 8 periods); annual returns up to 4 fiscal years. " +
    "Critical for EV calculation (market cap + net debt), leverage screening, and distress analysis. " +
    "Pairs with income-statements (P&L + cash flow) to complete the financial statement trilogy. " +
    "Source: Yahoo Finance fundamentals timeseries (free, no API key required).",

  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description: "US equity ticker symbol (e.g. 'AAPL', 'MSFT', 'NVDA', 'TSLA').",
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
        description: "Balance sheet snapshots, most-recent-first. All monetary values in USD.",
        items: {
          type: "object",
          properties: {
            period_end:          { type: "string", description: "Balance sheet date (YYYY-MM-DD)." },
            cash:                { type: ["number", "null"], description: "Cash and cash equivalents (USD)." },
            short_term_investments: { type: ["number", "null"], description: "Short-term investments / marketable securities." },
            current_assets:      { type: ["number", "null"], description: "Total current assets." },
            total_assets:        { type: ["number", "null"], description: "Total assets." },
            current_liabilities: { type: ["number", "null"], description: "Total current liabilities." },
            total_debt:          { type: ["number", "null"], description: "Total financial debt (short-term + long-term)." },
            net_debt:            { type: ["number", "null"], description: "Net debt (total_debt - cash - short_term_investments). Positive = levered." },
            net_cash:            { type: ["number", "null"], description: "Net cash position (-net_debt). Positive = cash > debt." },
            total_liabilities:   { type: ["number", "null"], description: "Total liabilities including minority interest." },
            stockholders_equity: { type: ["number", "null"], description: "Total stockholders' equity." },
            book_value:          { type: ["number", "null"], description: "Common stockholders' equity (book value)." },
            retained_earnings:   { type: ["number", "null"], description: "Retained earnings / accumulated deficit." },
            goodwill_intangibles:{ type: ["number", "null"], description: "Goodwill + other intangible assets." },
            tangible_book_value: { type: ["number", "null"], description: "book_value minus goodwill_intangibles." },
            working_capital:     { type: ["number", "null"], description: "current_assets minus current_liabilities." },
            shares_outstanding:  { type: ["number", "null"], description: "Shares issued / outstanding." },
          },
        },
      },
      retrieved_at: { type: "string" },
      related_capabilities: {
        type: "array",
        description: "Companion caps for complete financial analysis.",
        items: {
          type: "object",
          properties: {
            cap:         { type: "string" },
            description: { type: "string" },
            price:       { type: "string" },
          },
        },
      },
    },
  },

  async handler({ ticker = "AAPL", period = "quarterly", limit = 4 }) {
    const sym      = (ticker || "AAPL").trim().toUpperCase();
    const maxLimit = Math.min(Math.max(1, limit), period === "annual" ? 4 : 8);

    const data    = await fetchTimeSeries(sym, period);
    const results = data?.timeseries?.result ?? [];

    if (!results.length) {
      throw new Error(`No ${period} balance sheet data found for ${sym}`);
    }

    const periods = pivot(results, period, maxLimit);

    if (!periods.length) {
      throw new Error(`No ${period} balance sheet periods found for ${sym}`);
    }

    return {
      ticker:      sym,
      period_type: period,
      currency:    "USD",
      periods,
      retrieved_at: new Date().toISOString(),
      related_capabilities: [
        { cap: "income-statements",  description: "Full P&L + cash flow history — revenue, margins, EPS, FCF.",           price: "$0.015" },
        { cap: "equity-fundamentals",description: "Trailing valuation ratios: P/E, EV/EBITDA, P/B, margins, ROE, FCF.",  price: "$0.020" },
        { cap: "earnings-estimates", description: "Forward analyst EPS & revenue consensus, revision momentum.",           price: "$0.012" },
        { cap: "peer-benchmarking",  description: "Comps table: 5 sector peers vs target on valuation/growth/margins.",   price: "$0.100" },
        { cap: "analyst-ratings",    description: "Buy/hold/sell counts, mean recommendation score, price target range.", price: "$0.010" },
      ],
    };
  },
};
