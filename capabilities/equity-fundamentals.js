// equity-fundamentals.js
//
// Stock fundamental valuation metrics for any US company (stock analysis) — P/E TTM,
// forward P/E, PEG ratio, P/B, EV/EBITDA, enterprise value, market cap,
// profit/operating/gross margins, ROE, ROA, revenue TTM, earnings growth,
// revenue growth, debt/equity, free cash flow, beta.
//
// Fills the valuation gap between us-stock-price (price only) and equity-brief
// (AI-synthesized narrative). Agents doing valuation screening, DCF inputs,
// or comparable company analysis need raw fundamentals without paying for
// synthesis. Single call replaces manual Yahoo Finance quoteSummary parsing.
//
// Upstream: Yahoo Finance quoteSummary (crumb-auth, free, no API key).
// Modules: defaultKeyStatistics + financialData + summaryDetail.
// Priced at $0.059.

const UA           = "Mozilla/5.0 (compatible; the-stall/4.7; +https://intuitek.ai)";
const YF_CRUMB_SRC = "https://fc.yahoo.com";
const YF_CRUMB_URL = "https://query2.finance.yahoo.com/v1/test/getcrumb";
const YF_SUMMARY   = "https://query2.finance.yahoo.com/v10/finance/quoteSummary";
const TMO          = 12_000;
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

async function fetchSummary(ticker, retry = true) {
  const { crumb, cookies } = await getCrumb();
  const modules = "defaultKeyStatistics,financialData,summaryDetail";
  const url = `${YF_SUMMARY}/${encodeURIComponent(ticker)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, "Cookie": cookies, "Accept": "application/json" },
    signal: AbortSignal.timeout(TMO),
  });
  if (resp.status === 401 && retry) {
    _crumbCache = null;
    return fetchSummary(ticker, false);
  }
  if (!resp.ok) throw new Error(`Yahoo Finance returned ${resp.status}`);
  return resp.json();
}

function formatLargeNum(n) {
  if (n == null) return null;
  if (Math.abs(n) >= 1e12) return `${r2(n / 1e12)}T`;
  if (Math.abs(n) >= 1e9)  return `${r2(n / 1e9)}B`;
  if (Math.abs(n) >= 1e6)  return `${r2(n / 1e6)}M`;
  return String(n);
}

export default {
  name:  "equity-fundamentals",
  price: "$0.059",

  description:
    "Stock fundamental valuation metrics for any US company — P/E TTM, forward P/E, PEG, P/B, EV/EBITDA, margins, ROE, ROA, revenue TTM, earnings/revenue growth, free cash flow, market cap, beta. Raw data for valuation screening and DCF inputs. No API key.",

  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description: "US stock ticker symbol (e.g. AAPL, NVDA, MSFT). Case-insensitive.",
      },
    },
    required: [],
  },

  outputSchema: {
    type: "object",
    properties: {
      ticker:               { type: "string",  description: "Canonical ticker symbol." },
      name:                 { type: "string",  description: "Company name." },
      market_cap:           { type: "string",  description: "Market capitalization (e.g. '3.01T')." },
      enterprise_value:     { type: "string",  description: "Enterprise value including debt." },
      valuation: {
        type: "object",
        properties: {
          trailing_pe:        { type: "number", description: "Trailing 12-month P/E ratio." },
          forward_pe:         { type: "number", description: "Forward P/E based on next year earnings estimate." },
          peg_ratio:          { type: "number", description: "Price/Earnings-to-Growth ratio." },
          price_to_book:      { type: "number", description: "Price-to-book ratio." },
          ev_to_ebitda:       { type: "number", description: "Enterprise value / EBITDA." },
          ev_to_revenue:      { type: "number", description: "Enterprise value / trailing 12-month revenue." },
          price_to_sales:     { type: "number", description: "Price-to-sales (TTM)." },
        },
      },
      profitability: {
        type: "object",
        properties: {
          gross_margin_pct:     { type: "number", description: "Gross profit margin %." },
          operating_margin_pct: { type: "number", description: "Operating income margin %." },
          profit_margin_pct:    { type: "number", description: "Net profit margin %." },
          return_on_equity_pct: { type: "number", description: "Return on equity %." },
          return_on_assets_pct: { type: "number", description: "Return on assets %." },
        },
      },
      growth: {
        type: "object",
        properties: {
          revenue_growth_pct:   { type: "number", description: "Year-over-year revenue growth %." },
          earnings_growth_pct:  { type: "number", description: "Year-over-year earnings growth %." },
          trailing_eps:         { type: "number", description: "Trailing 12-month EPS." },
          forward_eps:          { type: "number", description: "Forward EPS estimate." },
        },
      },
      financials: {
        type: "object",
        properties: {
          revenue_ttm:        { type: "string", description: "Trailing 12-month revenue (formatted)." },
          free_cash_flow:     { type: "string", description: "Annual free cash flow (formatted)." },
          total_cash:         { type: "string", description: "Total cash and equivalents." },
          total_debt:         { type: "string", description: "Total debt." },
          debt_to_equity:     { type: "number", description: "Total debt / total equity." },
          current_ratio:      { type: "number", description: "Current assets / current liabilities." },
        },
      },
      market: {
        type: "object",
        properties: {
          beta:               { type: "number", description: "5-year monthly beta vs S&P 500." },
          shares_outstanding: { type: "string", description: "Total shares outstanding." },
          float_shares:       { type: "string", description: "Shares in public float." },
          short_ratio:        { type: "number", description: "Short interest / average daily volume." },
          dividend_yield_pct: { type: "number", description: "Forward annual dividend yield %." },
          payout_ratio_pct:   { type: "number", description: "Dividend payout ratio %." },
        },
      },
      retrieved_at: { type: "string", description: "ISO-8601 timestamp of data retrieval." },
    },
  },

  async handler({ ticker = "AAPL" }) {
    const sym = ticker.trim().toUpperCase();

    const data = await fetchSummary(sym);
    const result = data?.quoteSummary?.result?.[0];
    if (!result) {
      const err = data?.quoteSummary?.error?.description || "no data returned";
      throw new Error(`No fundamentals for ${sym}: ${err}`);
    }

    const ks = result.defaultKeyStatistics  || {};
    const fd = result.financialData         || {};
    const sd = result.summaryDetail         || {};
    const qi = result.quoteType             || {};

    const name = qi.longName || qi.shortName || sym;

    const mktCap = rawVal(sd.marketCap) ?? rawVal(ks.enterpriseValue);
    const ev     = rawVal(ks.enterpriseValue);

    return {
      ticker: sym,
      name,
      market_cap:       formatLargeNum(rawVal(sd.marketCap)),
      enterprise_value: formatLargeNum(ev),

      valuation: {
        trailing_pe:    r2(rawVal(sd.trailingPE)  ?? rawVal(ks.trailingPE)),
        forward_pe:     r2(rawVal(sd.forwardPE)   ?? rawVal(ks.forwardPE)),
        peg_ratio:      r4(rawVal(ks.pegRatio)),
        price_to_book:  r2(rawVal(ks.priceToBook)),
        ev_to_ebitda:   r2(rawVal(ks.enterpriseToEbitda)),
        ev_to_revenue:  r2(rawVal(ks.enterpriseToRevenue)),
        price_to_sales: r2(rawVal(sd.priceToSalesTrailingTwelveMonths)),
      },

      profitability: {
        gross_margin_pct:     pct(rawVal(fd.grossMargins)),
        operating_margin_pct: pct(rawVal(fd.operatingMargins)),
        profit_margin_pct:    pct(rawVal(fd.profitMargins) ?? rawVal(ks.profitMargins)),
        return_on_equity_pct: pct(rawVal(fd.returnOnEquity)),
        return_on_assets_pct: pct(rawVal(fd.returnOnAssets)),
      },

      growth: {
        revenue_growth_pct:  pct(rawVal(fd.revenueGrowth)),
        earnings_growth_pct: pct(rawVal(fd.earningsGrowth)),
        trailing_eps:        r4(rawVal(ks.trailingEps)),
        forward_eps:         r4(rawVal(ks.forwardEps)),
      },

      financials: {
        revenue_ttm:    formatLargeNum(rawVal(fd.totalRevenue)),
        free_cash_flow: formatLargeNum(rawVal(fd.freeCashflow)),
        total_cash:     formatLargeNum(rawVal(fd.totalCash)),
        total_debt:     formatLargeNum(rawVal(fd.totalDebt)),
        debt_to_equity: r2(rawVal(fd.debtToEquity)),
        current_ratio:  r2(rawVal(fd.currentRatio)),
      },

      market: {
        beta:               r4(rawVal(ks.beta)         ?? rawVal(sd.beta)),
        shares_outstanding: formatLargeNum(rawVal(ks.sharesOutstanding)),
        float_shares:       formatLargeNum(rawVal(ks.floatShares)),
        short_ratio:        r2(rawVal(ks.shortRatio)),
        dividend_yield_pct: pct(rawVal(sd.dividendYield)),
        payout_ratio_pct:   pct(rawVal(sd.payoutRatio)),
      },

      retrieved_at: new Date().toISOString(),
    };
  },
};
