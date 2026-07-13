// capital-allocation-score.js
//
// Stock capital allocation quality assessment for any US company.
// Answers the question any DCF analyst asks AFTER valuing a company:
// "Is management actually good at deploying the capital they generate?"
//
// Five core metrics:
//
//   1. ROIC (Return on Invested Capital)
//      NOPAT = EBIT × (1 − effective tax rate)
//      Invested Capital = Total Equity + Net Debt
//      ROIC = NOPAT / Invested Capital
//      Benchmark: >15% = excellent, >10% = good, >5% = adequate, <0% = destroys value.
//
//   2. FCF Yield
//      FCF = Operating Cash Flow − |CapEx|
//      FCF Yield = FCF / Market Cap
//      Negative = company burning cash relative to size.
//
//   3. Total Shareholder Yield (TSY)
//      Dividend Yield + Buyback Yield
//      Buyback Yield = |Stock Repurchases| / Market Cap
//      High TSY + high ROIC = compounding machine.
//      High TSY + low ROIC = extracting value, not creating it.
//
//   4. CapEx Intensity
//      |CapEx| / Revenue
//      <5% = capital-light; >20% = capital-heavy (think telecom, industrials).
//      High intensity + low ROIC is the danger zone.
//
//   5. Reinvestment Rate
//      Net Investment = CapEx − D&A
//      Reinvestment Rate = Net Investment / NOPAT (clamped [−1, 5])
//      > 0 = growing its asset base; < 0 = harvesting.
//
// Letter grade (A/B/C/D/F) derived from ROIC tier + FCF conversion + TSY.
//
// Runtime-capture seam: DCF and valuation agents chain this AFTER
// equity-fundamentals / income-statements / wacc-calculator to qualify
// management before projecting terminal growth rates. High ROIC + positive
// reinvestment rate → justified above-average terminal growth assumption.
//
// Upstream: Yahoo Finance quoteSummary (free, no API key required).
// Price: $0.020/call.

const UA           = "Mozilla/5.0 (compatible; the-stall/4.66; +https://intuitek.ai)";
const YF_CRUMB_SRC = "https://fc.yahoo.com";
const YF_CRUMB_URL = "https://query2.finance.yahoo.com/v1/test/getcrumb";
const YF_SUMMARY   = "https://query2.finance.yahoo.com/v10/finance/quoteSummary";
const TMO          = 16_000;
const CRUMB_TTL    = 30 * 60 * 1000;

let _crumbCache = null;

function r2(n)  { return n != null ? Math.round(n * 100) / 100 : null; }
function r4(n)  { return n != null ? Math.round(n * 10000) / 10000 : null; }
function pct(n) { return n != null ? r2(n * 100) : null; }

function rawVal(f) {
  if (f == null) return null;
  if (typeof f === "number") return f;
  return f?.raw ?? null;
}

async function refreshCrumb() {
  const seedResp = await fetch(YF_CRUMB_SRC, {
    headers: { "User-Agent": UA }, redirect: "follow",
    signal: AbortSignal.timeout(TMO),
  });
  const cookies = (seedResp.headers.getSetCookie?.() ?? []).map(c => c.split(";")[0]).join("; ");
  const crumbResp = await fetch(YF_CRUMB_URL, {
    headers: { "User-Agent": UA, "Cookie": cookies },
    signal: AbortSignal.timeout(TMO),
  });
  if (!crumbResp.ok) throw new Error(`crumb fetch ${crumbResp.status}`);
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
  const modules = [
    "defaultKeyStatistics",
    "summaryDetail",
    "financialData",
    "incomeStatementHistory",
    "balanceSheetHistory",
    "cashflowStatementHistory",
  ].join(",");
  const url = `${YF_SUMMARY}/${encodeURIComponent(ticker)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, "Cookie": cookies, "Accept": "application/json" },
    signal: AbortSignal.timeout(TMO),
  });
  if (resp.status === 401 && retry) { _crumbCache = null; return fetchSummary(ticker, false); }
  if (!resp.ok) throw new Error(`Yahoo Finance quoteSummary returned ${resp.status}`);
  return resp.json();
}

// ── ROIC ─────────────────────────────────────────────────────────────────────

function computeRoic(is0, bs0) {
  const ebit       = rawVal(is0?.ebit);
  const taxProv    = rawVal(is0?.taxProvision);
  const preTax     = rawVal(is0?.incomeBeforeTax);
  const equity     = rawVal(bs0?.totalStockholderEquity);
  const ltd        = rawVal(bs0?.longTermDebt) ?? 0;
  const std        = rawVal(bs0?.shortLongTermDebt) ?? 0;
  const cash       = rawVal(bs0?.cash) ?? 0;
  const stInv      = rawVal(bs0?.shortTermInvestments) ?? 0;

  if (ebit == null || equity == null) return { roic_pct: null, nopat: null, invested_capital: null, roic_signal: "INSUFFICIENT_DATA" };

  const eff_tax_rate = (preTax && preTax !== 0 && taxProv != null)
    ? Math.min(Math.max(taxProv / preTax, 0), 0.50)
    : 0.21; // US statutory fallback

  const nopat          = ebit * (1 - eff_tax_rate);
  const net_debt       = (ltd + std) - (cash + stInv);
  const invested_cap   = equity + net_debt;

  if (Math.abs(invested_cap) < 1_000) {
    return { roic_pct: null, nopat: r2(nopat / 1e9), invested_capital: r2(invested_cap / 1e9), roic_signal: "INSUFFICIENT_DATA" };
  }

  const roic = nopat / invested_cap;

  let roic_signal;
  if      (roic > 0.20)  roic_signal = "EXCEPTIONAL";
  else if (roic > 0.15)  roic_signal = "EXCELLENT";
  else if (roic > 0.10)  roic_signal = "GOOD";
  else if (roic > 0.05)  roic_signal = "ADEQUATE";
  else if (roic > 0)     roic_signal = "BELOW_COC";
  else                   roic_signal = "VALUE_DESTROYING";

  return {
    roic_pct:        pct(roic),
    nopat_bn:        r2(nopat / 1e9),
    invested_capital_bn: r2(invested_cap / 1e9),
    effective_tax_rate_pct: pct(eff_tax_rate),
    net_debt_bn:     r2(net_debt / 1e9),
    roic_signal,
  };
}

// ── FCF & Yield ──────────────────────────────────────────────────────────────

function computeFcf(cf0, mktCap) {
  const ocf  = rawVal(cf0?.totalCashFromOperatingActivities);
  const capex = rawVal(cf0?.capitalExpenditures); // typically negative

  if (ocf == null) return { fcf_bn: null, fcf_yield_pct: null, fcf_signal: "INSUFFICIENT_DATA" };

  const capexAbs = capex != null ? Math.abs(capex) : 0;
  const fcf      = ocf - capexAbs;

  let fcf_yield_pct = null;
  if (mktCap && mktCap > 0) fcf_yield_pct = pct(fcf / mktCap);

  let fcf_signal;
  if      (fcf_yield_pct == null)   fcf_signal = "UNKNOWN";
  else if (fcf_yield_pct > 6)       fcf_signal = "STRONG";
  else if (fcf_yield_pct > 3)       fcf_signal = "HEALTHY";
  else if (fcf_yield_pct > 0)       fcf_signal = "POSITIVE";
  else                               fcf_signal = "NEGATIVE";

  return {
    operating_cf_bn: r2(ocf / 1e9),
    capex_bn:        r2(capexAbs / 1e9),
    fcf_bn:          r2(fcf / 1e9),
    fcf_yield_pct,
    fcf_signal,
  };
}

// ── Shareholder Yield ─────────────────────────────────────────────────────────

function computeShareholderYield(cf0, mktCap, divYieldFromSummary) {
  const dividendsPaid    = rawVal(cf0?.dividendsPaid);         // negative
  const repurchaseOfStock = rawVal(cf0?.repurchaseOfStock);    // negative

  const divPaid    = dividendsPaid    != null ? Math.abs(dividendsPaid)    : 0;
  const buybacks   = repurchaseOfStock != null ? Math.abs(repurchaseOfStock) : 0;
  const totalReturn = divPaid + buybacks;

  let div_yield_pct    = null;
  let buyback_yield_pct = null;
  let total_shareholder_yield_pct = null;

  if (mktCap && mktCap > 0) {
    div_yield_pct    = pct(divPaid  / mktCap);
    buyback_yield_pct = pct(buybacks / mktCap);
    total_shareholder_yield_pct = pct(totalReturn / mktCap);
  } else if (divYieldFromSummary != null) {
    div_yield_pct = pct(divYieldFromSummary);
  }

  let shareholder_return_signal;
  const tsy = total_shareholder_yield_pct ?? 0;
  if      (tsy > 8)  shareholder_return_signal = "AGGRESSIVE_RETURN";
  else if (tsy > 4)  shareholder_return_signal = "GENEROUS_RETURN";
  else if (tsy > 1)  shareholder_return_signal = "MODEST_RETURN";
  else               shareholder_return_signal = "MINIMAL_RETURN";

  return {
    dividends_paid_bn:           r2(divPaid / 1e9),
    buybacks_bn:                 r2(buybacks / 1e9),
    div_yield_pct,
    buyback_yield_pct,
    total_shareholder_yield_pct,
    shareholder_return_signal,
  };
}

// ── CapEx & Reinvestment ──────────────────────────────────────────────────────

function computeCapex(cf0, is0) {
  const capex    = rawVal(cf0?.capitalExpenditures);
  const da       = rawVal(cf0?.depreciation) ?? rawVal(cf0?.depreciationAndAmortization) ?? 0;
  const revenue  = rawVal(is0?.totalRevenue);
  const ebit     = rawVal(is0?.ebit);
  const taxProv  = rawVal(is0?.taxProvision);
  const preTax   = rawVal(is0?.incomeBeforeTax);

  if (capex == null) return { capex_intensity_pct: null, reinvestment_rate: null, reinvestment_signal: "INSUFFICIENT_DATA" };

  const capexAbs = Math.abs(capex);
  const capex_intensity_pct = (revenue && revenue > 0) ? pct(capexAbs / revenue) : null;

  const eff_tax = (preTax && preTax !== 0 && taxProv != null) ? Math.min(Math.max(taxProv / preTax, 0), 0.50) : 0.21;
  const nopat   = ebit != null ? ebit * (1 - eff_tax) : null;
  const net_inv  = capexAbs - Math.abs(da);

  let reinvestment_rate  = null;
  let reinvestment_signal = "INSUFFICIENT_DATA";

  if (nopat != null && Math.abs(nopat) > 1_000) {
    reinvestment_rate = r4(Math.min(Math.max(net_inv / nopat, -1), 5));

    if      (reinvestment_rate > 1.0)  reinvestment_signal = "GROWTH_MODE";
    else if (reinvestment_rate > 0.3)  reinvestment_signal = "REINVESTING";
    else if (reinvestment_rate > 0)    reinvestment_signal = "MAINTENANCE";
    else                               reinvestment_signal = "HARVESTING";
  }

  return {
    capex_bn:              r2(capexAbs / 1e9),
    da_bn:                 r2(Math.abs(da) / 1e9),
    capex_intensity_pct,
    reinvestment_rate,
    reinvestment_signal,
  };
}

// ── Letter Grade ──────────────────────────────────────────────────────────────

function computeGrade(roicData, fcfData, tsyData) {
  const roic_sig = roicData.roic_signal;
  const fcf_sig  = fcfData.fcf_signal;
  const fcf_pos  = fcfData.fcf_bn != null ? fcfData.fcf_bn >= 0 : null;

  if (roic_sig === "INSUFFICIENT_DATA") return { grade: "N/A", grade_rationale: "Insufficient financial data." };

  let score = 0;

  // ROIC component (0–5 points)
  if      (roic_sig === "EXCEPTIONAL")      score += 5;
  else if (roic_sig === "EXCELLENT")        score += 4;
  else if (roic_sig === "GOOD")             score += 3;
  else if (roic_sig === "ADEQUATE")         score += 2;
  else if (roic_sig === "BELOW_COC")        score += 1;
  // VALUE_DESTROYING → 0

  // FCF component (0–2 points)
  if      (fcf_sig === "STRONG")  score += 2;
  else if (fcf_sig === "HEALTHY") score += 2;
  else if (fcf_sig === "POSITIVE") score += 1;
  // NEGATIVE → 0

  // TSY component (0–1 point) — only bonus if ROIC is already good
  const tsy = tsyData.total_shareholder_yield_pct ?? 0;
  if (score >= 3 && tsy >= 2) score += 1;

  let grade, grade_rationale;
  if      (score >= 7) { grade = "A"; grade_rationale = "Capital compounder — high ROIC, strong FCF generation, and meaningful shareholder returns."; }
  else if (score >= 5) { grade = "B"; grade_rationale = "Good capital allocator — above-cost-of-capital returns with solid free cash flow."; }
  else if (score >= 3) { grade = "C"; grade_rationale = "Adequate allocator — positive returns but limited FCF or near cost-of-capital performance."; }
  else if (score >= 1) { grade = "D"; grade_rationale = "Marginal allocator — ROIC near zero or FCF negative; capital deployed below cost."; }
  else                 { grade = "F"; grade_rationale = "Value destroyer — ROIC negative with no FCF support; each dollar reinvested erodes equity."; }

  return { grade, grade_score: score, grade_rationale };
}

// ── Export ────────────────────────────────────────────────────────────────────

export default {
  name:  "capital-allocation-score",
  price: "$0.025",

  description:
    "Stock capital allocation quality assessment for any US company. Returns ROIC (Return on Invested Capital), FCF yield, total shareholder yield (dividends + buybacks), CapEx intensity, and reinvestment rate. Synthesizes these into a letter grade (A–F) that answers: is management good at deploying the capital they generate? Designed to chain after equity-fundamentals and wacc-calculator to qualify management quality before setting DCF terminal growth assumptions.",

  outputSchema: {
    type: "object",
    properties: {
      ticker:        { type: "string" },
      grade:         { type: "string",          description: "Capital allocation quality: A (compounder) / B (good) / C (adequate) / D (marginal) / F (value destroyer) / N/A (insufficient data)." },
      grade_score:   { type: ["integer","null"], description: "Raw score 0–8 underlying the letter grade." },
      grade_rationale: { type: "string",        description: "One-sentence explanation of the grade." },
      roic: {
        type: "object",
        description: "Return on Invested Capital breakdown.",
        properties: {
          roic_pct:             { type: ["number","null"], description: "ROIC % (NOPAT / Invested Capital). >15% excellent, >10% good, >5% adequate, <0% value-destroying." },
          roic_signal:          { type: "string",          description: "EXCEPTIONAL | EXCELLENT | GOOD | ADEQUATE | BELOW_COC | VALUE_DESTROYING | INSUFFICIENT_DATA" },
          nopat_bn:             { type: ["number","null"], description: "Net Operating Profit After Tax in $B." },
          invested_capital_bn:  { type: ["number","null"], description: "Invested Capital ($B) = Equity + Net Debt." },
          net_debt_bn:          { type: ["number","null"], description: "Net Debt ($B) = Total Debt − Cash." },
          effective_tax_rate_pct: { type: ["number","null"], description: "Effective tax rate used in NOPAT calculation (%)." },
        },
      },
      fcf: {
        type: "object",
        description: "Free cash flow and FCF yield.",
        properties: {
          operating_cf_bn:  { type: ["number","null"], description: "Operating cash flow in $B." },
          capex_bn:         { type: ["number","null"], description: "Capital expenditures (absolute) in $B." },
          fcf_bn:           { type: ["number","null"], description: "Free cash flow in $B (OCF − CapEx)." },
          fcf_yield_pct:    { type: ["number","null"], description: "FCF yield % (FCF / Market Cap)." },
          fcf_signal:       { type: "string",          description: "STRONG (>6%) | HEALTHY (3–6%) | POSITIVE (0–3%) | NEGATIVE | UNKNOWN" },
        },
      },
      shareholder_yield: {
        type: "object",
        description: "Cash returned to shareholders via dividends and buybacks.",
        properties: {
          dividends_paid_bn:          { type: ["number","null"], description: "Cash dividends paid in $B." },
          buybacks_bn:                { type: ["number","null"], description: "Stock repurchases in $B." },
          div_yield_pct:              { type: ["number","null"], description: "Dividend yield % (Dividends / Market Cap)." },
          buyback_yield_pct:          { type: ["number","null"], description: "Buyback yield % (Repurchases / Market Cap)." },
          total_shareholder_yield_pct:{ type: ["number","null"], description: "Total shareholder yield % = Dividend Yield + Buyback Yield." },
          shareholder_return_signal:  { type: "string",          description: "AGGRESSIVE_RETURN (>8%) | GENEROUS_RETURN (4–8%) | MODEST_RETURN (1–4%) | MINIMAL_RETURN (<1%)" },
        },
      },
      capex_reinvestment: {
        type: "object",
        description: "Capital expenditure intensity and net reinvestment rate.",
        properties: {
          capex_bn:            { type: ["number","null"], description: "Absolute CapEx in $B." },
          da_bn:               { type: ["number","null"], description: "D&A in $B (maintenance capex proxy)." },
          capex_intensity_pct: { type: ["number","null"], description: "CapEx as % of revenue. <5% capital-light; >20% capital-heavy." },
          reinvestment_rate:   { type: ["number","null"], description: "Net Investment / NOPAT. >0 growing asset base; <0 harvesting." },
          reinvestment_signal: { type: "string",          description: "GROWTH_MODE (>1.0) | REINVESTING (0.3–1.0) | MAINTENANCE (0–0.3) | HARVESTING (<0) | INSUFFICIENT_DATA" },
        },
      },
      market_cap_bn:  { type: ["number","null"], description: "Market capitalization in $B." },
      statement_period: { type: ["string","null"], description: "Most recent annual statement end date (YYYY-MM-DD)." },
      retrieved_at:   { type: "string" },
    },
  },

  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type:        "string",
        description: "US stock ticker symbol (e.g. AAPL, MSFT, AMZN). Case-insensitive.",
      },
    },
    required: ["ticker"],
  },

  async handler({ ticker }) {
    if (!ticker) throw new Error("ticker is required");
    ticker = ticker.toUpperCase().trim().replace(/[^A-Z0-9.\-]/g, "");

    const raw    = await fetchSummary(ticker);
    const result = raw?.quoteSummary?.result?.[0];
    if (!result) throw new Error(`No data for ${ticker} — check ticker symbol`);

    const is0 = result.incomeStatementHistory?.incomeStatementHistory?.[0] ?? null;
    const bs0 = result.balanceSheetHistory?.balanceSheetStatements?.[0]   ?? null;
    const cf0 = result.cashflowStatementHistory?.cashflowStatements?.[0]  ?? null;

    const mktCapRaw      = rawVal(result.summaryDetail?.marketCap)
                        ?? rawVal(result.defaultKeyStatistics?.marketCap);
    const mktCap         = mktCapRaw;
    const market_cap_bn  = mktCap ? r2(mktCap / 1e9) : null;
    const divYield       = rawVal(result.summaryDetail?.dividendYield)
                        ?? rawVal(result.summaryDetail?.trailingAnnualDividendYield);

    const roic              = computeRoic(is0, bs0);
    const fcf               = computeFcf(cf0, mktCap);
    const shareholder_yield = computeShareholderYield(cf0, mktCap, divYield);
    const capex_reinvestment = computeCapex(cf0, is0);
    const { grade, grade_score, grade_rationale } = computeGrade(roic, fcf, shareholder_yield);

    const periodTs = rawVal(bs0?.endDate);
    const statement_period = periodTs ? new Date(periodTs * 1000).toISOString().slice(0, 10) : null;

    return {
      ticker,
      grade,
      grade_score: grade_score ?? null,
      grade_rationale,
      roic,
      fcf,
      shareholder_yield,
      capex_reinvestment,
      market_cap_bn,
      statement_period,
      retrieved_at: new Date().toISOString(),
    };
  },
};
