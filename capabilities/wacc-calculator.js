// wacc-calculator.js
//
// Weighted Average Cost of Capital (WACC) for any US public company.
// Returns CAPM-based cost of equity, after-tax cost of debt, capital structure
// weights (E/V, D/V), and final WACC — the discount rate used in DCF models.
//
// Seam: equity-research agents chain earnings-calendar + equity-fundamentals +
// pre-earnings-brief to build investment theses, but lack a ready discount rate.
// WACC is the single missing input before a DCF model can run. Currently agents
// must compute WACC externally (Damodaran tables, manual formula) or skip it.
// This cap closes that gap in one call.
//
// Methodology (Damodaran standard):
//   Cost of equity (CAPM) = risk_free_rate + beta × ERP
//   Cost of debt (after-tax) = interest_expense / total_debt × (1 - effective_tax_rate)
//   WACC = (E/V) × Re + (D/V) × Rd(1-T)
//
// Data sources (all free, no API key):
//   - Yahoo Finance quoteSummary: beta, market cap, total debt, income statement
//   - Yahoo Finance chart (^TNX): live 10Y Treasury yield as risk-free rate
//   - ERP: Damodaran mature market ERP (default 5.5%, overridable via query param)
//
// Price: $0.025

const UA           = "Mozilla/5.0 (compatible; the-stall/5.0; +https://intuitek.ai)";
const YF_CRUMB_SRC = "https://fc.yahoo.com";
const YF_CRUMB_URL = "https://query2.finance.yahoo.com/v1/test/getcrumb";
const YF_SUMMARY   = "https://query2.finance.yahoo.com/v10/finance/quoteSummary";
const YF_CHART     = "https://query2.finance.yahoo.com/v8/finance/chart";
const TMO          = 14_000;
const CRUMB_TTL    = 30 * 60 * 1000;

let _crumbCache = null;

function r2(n) { return n != null ? Math.round(n * 100) / 100 : null; }
function r4(n) { return n != null ? Math.round(n * 10000) / 10000 : null; }
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
  const cookies = (seedResp.headers.getSetCookie?.() ?? []).map(c => c.split(";")[0]).join("; ");
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

async function fetchSummary(ticker, retry = true) {
  const { crumb, cookies } = await getCrumb();
  const modules = "defaultKeyStatistics,financialData,summaryDetail,incomeStatementHistory";
  const url = `${YF_SUMMARY}/${encodeURIComponent(ticker)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, "Cookie": cookies, "Accept": "application/json" },
    signal: AbortSignal.timeout(TMO),
  });
  if (resp.status === 401 && retry) {
    _crumbCache = null;
    return fetchSummary(ticker, false);
  }
  if (!resp.ok) throw new Error(`Yahoo Finance quoteSummary returned ${resp.status}`);
  return resp.json();
}

async function fetch10YYield() {
  const url = `${YF_CHART}/${encodeURIComponent("^TNX")}?interval=1d&range=1d`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
  return price != null ? price / 100 : null;
}

export default {
  name:  "wacc-calculator",
  price: "$0.025",

  description:
    "Computes stock WACC (Weighted Average Cost of Capital) for any US company using CAPM cost of equity (live 10Y Treasury + beta × ERP), after-tax cost of debt (interest expense / total debt), and market-value capital structure weights. The discount rate needed to run a DCF model.",

  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description: "US stock ticker symbol (e.g. AAPL, NVDA, MSFT). Case-insensitive.",
      },
      erp: {
        type: "number",
        description: "Equity risk premium assumption in % (default 5.5 — Damodaran mature market estimate). Override for emerging markets or sector adjustments.",
      },
    },
    required: [],
  },

  outputSchema: {
    type: "object",
    properties: {
      ticker:              { type: "string", description: "Canonical ticker symbol." },
      name:                { type: "string", description: "Company name." },
      wacc_pct:            { type: "number", description: "WACC as a percentage (e.g. 8.43 = 8.43%). Use as discount rate in DCF model." },
      cost_of_equity_pct:  { type: "number", description: "CAPM cost of equity in %: risk_free_rate + beta × ERP." },
      cost_of_debt_pct:    { type: "number", description: "After-tax cost of debt in %: (interest_expense / total_debt) × (1 - effective_tax_rate)." },
      capital_structure: {
        type: "object",
        properties: {
          equity_weight_pct: { type: "number", description: "Equity as % of total capital (E/V)." },
          debt_weight_pct:   { type: "number", description: "Debt as % of total capital (D/V)." },
          market_cap_usd:    { type: "number", description: "Market capitalization in USD." },
          total_debt_usd:    { type: "number", description: "Total debt in USD." },
        },
      },
      inputs: {
        type: "object",
        properties: {
          risk_free_rate_pct:    { type: "number", description: "10Y Treasury yield used as risk-free rate (%)." },
          beta:                  { type: "number", description: "5-year monthly beta vs S&P 500." },
          equity_risk_premium_pct: { type: "number", description: "ERP assumption used (%)." },
          pretax_cost_of_debt_pct: { type: "number", description: "Pre-tax interest rate on debt (%)." },
          effective_tax_rate_pct:  { type: "number", description: "Effective tax rate used (%)." },
        },
      },
      notes: { type: "array", items: { type: "string" }, description: "Fallback assumptions applied (e.g. beta defaulted to 1.0, tax rate defaulted to 21%)." },
      retrieved_at: { type: "string", description: "ISO-8601 timestamp of data retrieval." },
    },
  },

  async handler({ ticker = "AAPL", erp = 5.5 }) {
    const sym = ticker.trim().toUpperCase();
    const erpFrac = erp / 100;
    const notes = [];

    // Fetch fundamentals and 10Y yield in parallel
    const [summaryData, rfRateRaw] = await Promise.all([
      fetchSummary(sym),
      fetch10YYield(),
    ]);

    const result = summaryData?.quoteSummary?.result?.[0];
    if (!result) {
      const err = summaryData?.quoteSummary?.error?.description || "no data returned";
      throw new Error(`No data for ${sym}: ${err}`);
    }

    const ks  = result.defaultKeyStatistics  || {};
    const fd  = result.financialData         || {};
    const sd  = result.summaryDetail         || {};
    const qi  = result.quoteType             || {};
    const ish = result.incomeStatementHistory?.incomeStatementHistory?.[0] || {};

    const name = qi.longName || qi.shortName || sym;

    // --- Risk-free rate ---
    let rfRate = rfRateRaw;
    if (rfRate == null) {
      rfRate = 0.044; // fallback: ~4.4% approximation if ^TNX unavailable
      notes.push("10Y Treasury yield unavailable — using 4.4% fallback risk-free rate.");
    }

    // --- Beta ---
    let beta = rawVal(ks.beta) ?? rawVal(sd.beta);
    if (beta == null) {
      beta = 1.0;
      notes.push("Beta unavailable — defaulted to 1.0 (market beta).");
    }

    // --- Market cap ---
    const marketCap = rawVal(sd.marketCap);
    if (marketCap == null) throw new Error(`Market cap unavailable for ${sym}`);

    // --- Total debt ---
    let totalDebt = rawVal(fd.totalDebt) ?? 0;

    // --- Interest expense and tax rate ---
    // incomeStatementHistory returns most recent annual statement
    const interestExpense = Math.abs(rawVal(ish.interestExpense) ?? 0);
    const incomeTax       = rawVal(ish.incomeTaxExpense);
    const pretaxIncome    = rawVal(ish.incomeBeforeTax);

    let taxRate = null;
    if (incomeTax != null && pretaxIncome != null && pretaxIncome > 0) {
      taxRate = incomeTax / pretaxIncome;
      taxRate = Math.max(0, Math.min(taxRate, 0.50)); // clamp to [0%, 50%]
    }
    if (taxRate == null) {
      taxRate = 0.21; // US statutory corporate tax rate
      notes.push("Effective tax rate unavailable — using 21% US statutory rate.");
    }

    // --- Cost of equity (CAPM) ---
    const costOfEquity = rfRate + beta * erpFrac;

    // --- Pre-tax cost of debt ---
    let pretaxCostOfDebt = 0;
    if (totalDebt > 0 && interestExpense > 0) {
      pretaxCostOfDebt = interestExpense / totalDebt;
      pretaxCostOfDebt = Math.min(pretaxCostOfDebt, 0.30); // sanity cap at 30%
    } else if (totalDebt === 0) {
      notes.push("No debt on balance sheet — company is all-equity financed. WACC = cost of equity.");
    } else {
      pretaxCostOfDebt = rfRate + 0.015; // default: risk-free + 150bps investment-grade spread
      notes.push("Interest expense unavailable — cost of debt approximated as risk-free rate + 1.5% spread.");
    }
    const afterTaxCostOfDebt = pretaxCostOfDebt * (1 - taxRate);

    // --- Capital structure weights ---
    const V = marketCap + totalDebt;
    const weightEquity = marketCap / V;
    const weightDebt   = totalDebt / V;

    // --- WACC ---
    const wacc = weightEquity * costOfEquity + weightDebt * afterTaxCostOfDebt;

    return {
      ticker:             sym,
      name,
      wacc_pct:           r4(wacc * 100),
      cost_of_equity_pct: r4(costOfEquity * 100),
      cost_of_debt_pct:   r4(afterTaxCostOfDebt * 100),

      capital_structure: {
        equity_weight_pct: r2(weightEquity * 100),
        debt_weight_pct:   r2(weightDebt * 100),
        market_cap_usd:    marketCap,
        total_debt_usd:    totalDebt,
      },

      inputs: {
        risk_free_rate_pct:       r4(rfRate * 100),
        beta:                     r4(beta),
        equity_risk_premium_pct:  r2(erp),
        pretax_cost_of_debt_pct:  r4(pretaxCostOfDebt * 100),
        effective_tax_rate_pct:   r2(taxRate * 100),
      },

      notes,
      retrieved_at: new Date().toISOString(),
    };
  },
};
