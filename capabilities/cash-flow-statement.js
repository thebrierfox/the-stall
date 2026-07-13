// cash-flow-statement.js
//
// Full cash flow statement history for any US public company — quarterly or annual.
// Covers all three sections: operating activities (D&A, stock comp, working capital
// changes, total operating CF), investing activities (capex, acquisitions, net
// investing CF), and financing activities (debt issuance/repayment, share buybacks,
// dividends paid, net financing CF). Also returns free cash flow, owner earnings
// (net income + D&A – capex), cash conversion ratio, and beginning/ending cash.
//
// Complement to income-statements (which exposes only 3 CF lines) and balance-sheet.
// The three together form the complete financial statement set needed for rigorous DCF
// modeling, quality-of-earnings analysis (accruals ratio), and capital allocation review.
//
// Upstream: Yahoo Finance fundamentals timeseries v1 (free, crumb-auth, no API key).
// Priced at $0.015.

const UA           = "Mozilla/5.0 (compatible; the-stall/4.11; +https://intuitek.ai)";
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

// Operating section
const QUARTERLY_OPERATING = [
  "quarterlyNetIncome",
  "quarterlyDepreciationAndAmortization",
  "quarterlyStockBasedCompensation",
  "quarterlyDeferredTax",
  "quarterlyChangeInWorkingCapital",
  "quarterlyOtherNonCashItems",
  "quarterlyOperatingCashFlow",
];

// Investing section
const QUARTERLY_INVESTING = [
  "quarterlyCapitalExpenditure",
  "quarterlyNetPPEPurchaseAndSale",
  "quarterlyNetBusinessPurchaseAndSale",
  "quarterlyNetInvestmentPurchaseAndSale",
  "quarterlyInvestingCashFlow",
];

// Financing section
const QUARTERLY_FINANCING = [
  "quarterlyRepaymentOfDebt",
  "quarterlyIssuanceOfDebt",
  "quarterlyRepurchaseOfCapitalStock",
  "quarterlyCommonStockDividendPaid",
  "quarterlyNetOtherFinancingCharges",
  "quarterlyFinancingCashFlow",
];

// Cash position
const QUARTERLY_CASH_POS = [
  "quarterlyFreeCashFlow",
  "quarterlyBeginningCashPosition",
  "quarterlyEndCashPosition",
  "quarterlyChangesInCash",
];

const ALL_QUARTERLY = [
  ...QUARTERLY_OPERATING,
  ...QUARTERLY_INVESTING,
  ...QUARTERLY_FINANCING,
  ...QUARTERLY_CASH_POS,
];

const ALL_ANNUAL = ALL_QUARTERLY.map(t => t.replace("quarterly", "annual"));

const FIELD_MAP = {
  // Operating
  NetIncome:                   "net_income",
  DepreciationAndAmortization: "depreciation_amortization",
  StockBasedCompensation:      "stock_based_compensation",
  DeferredTax:                 "deferred_tax",
  ChangeInWorkingCapital:      "change_in_working_capital",
  OtherNonCashItems:           "other_non_cash_items",
  OperatingCashFlow:           "operating_cash_flow",
  // Investing
  CapitalExpenditure:          "capital_expenditures",
  NetPPEPurchaseAndSale:       "net_ppe_purchase_sale",
  NetBusinessPurchaseAndSale:  "acquisitions_divestitures",
  NetInvestmentPurchaseAndSale:"net_investment_purchase_sale",
  InvestingCashFlow:           "investing_cash_flow",
  // Financing
  RepaymentOfDebt:             "debt_repayment",
  IssuanceOfDebt:              "debt_issuance",
  RepurchaseOfCapitalStock:    "share_buybacks",
  CommonStockDividendPaid:     "dividends_paid",
  NetOtherFinancingCharges:    "other_financing",
  FinancingCashFlow:           "financing_cash_flow",
  // Cash position
  FreeCashFlow:                "free_cash_flow",
  BeginningCashPosition:       "beginning_cash",
  EndCashPosition:             "ending_cash",
  ChangesInCash:               "net_change_in_cash",
};

async function fetchTimeSeries(ticker, period, retry = true) {
  const { crumb, cookies } = await getCrumb();
  const types = period === "annual" ? ALL_ANNUAL : ALL_QUARTERLY;
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

    const suffix    = key.slice(prefix.length);
    const fieldName = FIELD_MAP[suffix];
    if (!fieldName) continue;

    for (const item of series[key]) {
      const date = item.asOfDate;
      if (!dateMap[date]) dateMap[date] = { period_end: date };
      const raw = item.reportedValue?.raw ?? null;
      dateMap[date][fieldName] = raw !== undefined ? raw : null;
    }
  }

  // Derive owner_earnings and cash_conversion_ratio
  for (const row of Object.values(dateMap)) {
    const ni  = row.net_income;
    const da  = row.depreciation_amortization;
    const cx  = row.capital_expenditures;
    const ocf = row.operating_cash_flow;
    const fcf = row.free_cash_flow;

    // owner_earnings (Buffett) = net_income + D&A – capex
    // capex from YF is typically negative; subtract it (add abs value)
    if (ni != null && da != null && cx != null) {
      row.owner_earnings = ni + da - Math.abs(cx);
    } else {
      row.owner_earnings = null;
    }

    // cash_conversion_ratio = FCF / net_income (>1 = high quality)
    if (fcf != null && ni != null && ni !== 0) {
      row.cash_conversion_ratio = Math.round((fcf / ni) * 100) / 100;
    } else {
      row.cash_conversion_ratio = null;
    }

    // capex_as_pct_of_ocf (capital intensity)
    if (cx != null && ocf != null && ocf !== 0) {
      row.capex_pct_of_ocf = Math.round((Math.abs(cx) / Math.abs(ocf)) * 10000) / 100;
    } else {
      row.capex_pct_of_ocf = null;
    }
  }

  return Object.values(dateMap)
    .sort((a, b) => b.period_end.localeCompare(a.period_end))
    .slice(0, limit);
}

export default {
  name:  "cash-flow-statement",
  price: "$0.021",

  description:
    "Full cash flow statement history for any US public stock — operating, investing, and financing " +
    "sections. Returns: D&A, stock-based comp, working capital changes, operating CF, capex, " +
    "acquisitions, investing CF, debt issuance/repayment, share buybacks, dividends paid, financing CF, " +
    "free cash flow, beginning/ending cash, owner earnings (net income + D&A – capex), and cash " +
    "conversion ratio. Quarterly default (up to 8 periods); annual returns up to 4 fiscal years. " +
    "Completes the financial statement trilogy alongside income-statements and balance-sheet. " +
    "Critical for FCF quality analysis, capital allocation review, and buyback/dividend tracking. " +
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
        description: "Cash flow periods, most-recent-first. Monetary values in USD.",
        items: {
          type: "object",
          properties: {
            period_end:              { type: "string", description: "Period end date (YYYY-MM-DD)." },
            // Operating
            net_income:              { type: ["number","null"], description: "Net income (starting point of indirect method)." },
            depreciation_amortization: { type: ["number","null"], description: "D&A add-back (non-cash expense)." },
            stock_based_compensation:{ type: ["number","null"], description: "Stock-based compensation add-back." },
            deferred_tax:            { type: ["number","null"], description: "Deferred income tax change." },
            change_in_working_capital: { type: ["number","null"], description: "Net change in operating working capital." },
            other_non_cash_items:    { type: ["number","null"], description: "Other non-cash adjustments." },
            operating_cash_flow:     { type: ["number","null"], description: "Total operating cash flow." },
            // Investing
            capital_expenditures:    { type: ["number","null"], description: "Capital expenditures (typically negative)." },
            net_ppe_purchase_sale:   { type: ["number","null"], description: "Net PP&E purchases and sales." },
            acquisitions_divestitures: { type: ["number","null"], description: "Net business acquisitions and divestitures." },
            net_investment_purchase_sale: { type: ["number","null"], description: "Net investment purchases and sales." },
            investing_cash_flow:     { type: ["number","null"], description: "Total investing cash flow." },
            // Financing
            debt_repayment:          { type: ["number","null"], description: "Debt repayments (typically negative)." },
            debt_issuance:           { type: ["number","null"], description: "New debt issuance proceeds." },
            share_buybacks:          { type: ["number","null"], description: "Share repurchases (typically negative)." },
            dividends_paid:          { type: ["number","null"], description: "Common stock dividends paid (typically negative)." },
            other_financing:         { type: ["number","null"], description: "Other financing cash flows." },
            financing_cash_flow:     { type: ["number","null"], description: "Total financing cash flow." },
            // Summary / derived
            free_cash_flow:          { type: ["number","null"], description: "Free cash flow (operating CF – capex)." },
            owner_earnings:          { type: ["number","null"], description: "Owner earnings: net income + D&A – capex (Buffett metric)." },
            cash_conversion_ratio:   { type: ["number","null"], description: "FCF / net income. >1 = high earnings quality." },
            capex_pct_of_ocf:        { type: ["number","null"], description: "Capex as % of operating CF (capital intensity)." },
            beginning_cash:          { type: ["number","null"], description: "Cash balance at period start." },
            ending_cash:             { type: ["number","null"], description: "Cash balance at period end." },
            net_change_in_cash:      { type: ["number","null"], description: "Net change in cash during period." },
          },
        },
      },
      retrieved_at: { type: "string" },
      related_capabilities: {
        type: "array",
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
      throw new Error(`No ${period} cash flow data found for ${sym}`);
    }

    const periods = pivot(results, period, maxLimit);

    if (!periods.length) {
      throw new Error(`No ${period} cash flow periods found for ${sym}`);
    }

    return {
      ticker:      sym,
      period_type: period,
      currency:    "USD",
      periods,
      retrieved_at: new Date().toISOString(),
      related_capabilities: [
        { cap: "income-statements",   description: "P&L history: revenue, margins, EPS — summary CF lines included.",       price: "$0.015" },
        { cap: "balance-sheet",       description: "Balance sheet: assets, debt, equity, working capital, net cash.",        price: "$0.015" },
        { cap: "equity-fundamentals", description: "Valuation ratios: P/E, EV/EBITDA, P/FCF, ROE, margins.",               price: "$0.020" },
        { cap: "earnings-estimates",  description: "Forward EPS & revenue consensus, revision momentum.",                    price: "$0.012" },
        { cap: "insider-trades",      description: "Recent insider buy/sell transactions (Form 4 data).",                    price: "$0.015" },
      ],
    };
  },
};
