// earnings-quality.js
//
// Stock earnings quality and manipulation-risk screening for any US public company.
// Implements three complementary models that expose the gap between reported
// income and cash reality:
//
//   1. Beneish M-Score (Beneish 1999) — 8-variable accounting manipulation detector.
//      M = -4.84 + 0.920·DSRI + 0.528·GMI + 0.404·AQI + 0.892·SGI
//              + 0.115·DEPI - 0.172·SGAI + 4.679·TATA - 0.327·LVGI
//      M > -1.78: MANIPULATION_RISK (~76% sensitivity on manipulators).
//      -2.22 < M ≤ -1.78: BORDERLINE.  M ≤ -2.22: LIKELY_CLEAN.
//
//      8 components:
//        DSRI  Days Sales in Receivables Index — AR growing faster than revenue?
//        GMI   Gross Margin Index              — margins deteriorating?
//        AQI   Asset Quality Index             — off-balance-sheet assets inflating?
//        SGI   Sales Growth Index              — aggressive revenue growth?
//        DEPI  Depreciation Index              — extending asset lives to inflate earnings?
//        SGAI  SG&A Index                      — overhead creeping relative to sales?
//        LVGI  Leverage Index                  — debt load increasing?
//        TATA  Total Accruals to Total Assets  — cash earnings diverging from reported?
//
//   2. Sloan Accrual Ratio (Sloan 1996): (NI - OCF) / Avg Total Assets.
//      Negative = cash earnings exceed reported (HIGH quality).
//      > +0.10 = potential aggressive revenue recognition.
//
//   3. Cash Conversion Ratio: OCF / NI.
//      > 1.0 = cash-backed; < 0.5 = earnings not translating to cash.
//
// Runtime-capture seam: due-diligence agents, forensic screening workflows, and
// equity-research pipelines call this after income-statements and
// equity-fundamentals to gate on earnings integrity before valuation.
// Designed to chain with equity-quality-screen (Piotroski + Altman).
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

function r4(n)  { return n != null ? Math.round(n * 10000) / 10000 : null; }
function r2(n)  { return n != null ? Math.round(n * 100) / 100 : null; }
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
    "balanceSheetHistory",
    "incomeStatementHistory",
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

// ── Beneish M-Score ──────────────────────────────────────────────────────────

function computeBeneish(bsList, isList, cfList) {
  if (bsList.length < 2 || isList.length < 2 || cfList.length < 2) {
    return {
      m_score: null,
      manipulation_risk: "INSUFFICIENT_DATA",
      components: {},
      components_available: 0,
      note: "Requires at least 2 years of annual financial statements.",
    };
  }

  const bs0 = bsList[0], bs1 = bsList[1];
  const is0 = isList[0], is1 = isList[1];
  const cf0 = cfList[0], cf1 = cfList[1];

  const ar0   = rawVal(bs0.netReceivables);
  const ar1   = rawVal(bs1.netReceivables);
  const rev0  = rawVal(is0.totalRevenue);
  const rev1  = rawVal(is1.totalRevenue);
  const cogs0 = rawVal(is0.costOfRevenue);
  const cogs1 = rawVal(is1.costOfRevenue);
  const ppe0  = rawVal(bs0.propertyPlantEquipment);
  const ppe1  = rawVal(bs1.propertyPlantEquipment);
  const ta0   = rawVal(bs0.totalAssets);
  const ta1   = rawVal(bs1.totalAssets);
  const dep0  = rawVal(cf0.depreciation) ?? rawVal(cf0.depreciationAndAmortization) ?? 0;
  const dep1  = rawVal(cf1.depreciation) ?? rawVal(cf1.depreciationAndAmortization) ?? 0;
  const sga0  = rawVal(is0.sellingGeneralAdministrative);
  const sga1  = rawVal(is1.sellingGeneralAdministrative);
  const cl0   = rawVal(bs0.totalCurrentLiabilities) ?? 0;
  const cl1   = rawVal(bs1.totalCurrentLiabilities) ?? 0;
  const ltd0  = rawVal(bs0.longTermDebt)            ?? 0;
  const ltd1  = rawVal(bs1.longTermDebt)            ?? 0;
  const ca0   = rawVal(bs0.totalCurrentAssets)      ?? 0;
  const ca1   = rawVal(bs1.totalCurrentAssets)      ?? 0;
  const ni0   = rawVal(is0.netIncomeFromContinuingOps) ?? rawVal(is0.netIncome);
  const ocf0  = rawVal(cf0.totalCashFromOperatingActivities);

  const components = {};
  let present = 0;

  // DSRI: (AR/Rev)_t / (AR/Rev)_t-1 — rising = slower collections
  let DSRI = null;
  if (ar0 != null && rev0 && ar1 != null && rev1) {
    DSRI = (ar0 / rev0) / (ar1 / rev1);
    components.DSRI = r4(DSRI);
    present++;
  }

  // GMI: GM%_t-1 / GM%_t — rising = margin deterioration
  let GMI = null;
  if (rev0 && cogs0 != null && rev1 && cogs1 != null) {
    const gm0 = (rev0 - cogs0) / rev0;
    const gm1 = (rev1 - cogs1) / rev1;
    if (Math.abs(gm0) > 1e-10) {
      GMI = gm1 / gm0;
      components.GMI = r4(GMI);
      present++;
    }
  }

  // AQI: (1-(CA+PPE)/TA)_t / (1-(CA+PPE)/TA)_t-1 — rising = more intangibles
  let AQI = null;
  if (ta0 && ta1 && ppe0 != null && ppe1 != null) {
    const aq0 = 1 - (ca0 + ppe0) / ta0;
    const aq1 = 1 - (ca1 + ppe1) / ta1;
    if (Math.abs(aq1) > 1e-10) {
      AQI = aq0 / aq1;
      components.AQI = r4(AQI);
      present++;
    }
  }

  // SGI: Rev_t / Rev_t-1 — high growth amplifies other risk signals
  let SGI = null;
  if (rev0 && rev1) {
    SGI = rev0 / rev1;
    components.SGI = r4(SGI);
    present++;
  }

  // DEPI: depreciation rate change — rising = extending asset lives to inflate earnings
  // Uses (Dep/(PPE+Dep)) as depreciation rate proxy (net PPE available; gross PPE unavailable)
  let DEPI = null;
  if (ppe0 != null && ppe0 > 0 && ppe1 != null && ppe1 > 0) {
    const d0 = dep0 / (ppe0 + Math.abs(dep0));
    const d1 = dep1 / (ppe1 + Math.abs(dep1));
    if (d0 > 1e-10) {
      DEPI = d1 / d0;
      components.DEPI = r4(DEPI);
      present++;
    }
  }

  // SGAI: (SGA/Rev)_t / (SGA/Rev)_t-1 — rising = overhead creep
  let SGAI = null;
  if (sga0 != null && rev0 && sga1 != null && rev1) {
    SGAI = (sga0 / rev0) / (sga1 / rev1);
    components.SGAI = r4(SGAI);
    present++;
  }

  // LVGI: ((CL+LTD)/TA)_t / ((CL+LTD)/TA)_t-1 — rising = increasing debt load
  let LVGI = null;
  if (ta0 && ta1) {
    const lev0 = (cl0 + ltd0) / ta0;
    const lev1 = (cl1 + ltd1) / ta1;
    if (lev1 > 1e-10) {
      LVGI = lev0 / lev1;
      components.LVGI = r4(LVGI);
      present++;
    }
  }

  // TATA: (NI - OCF) / AvgTA — cash-flow accruals approach
  let TATA = null;
  if (ni0 != null && ocf0 != null && ta0 && ta1) {
    TATA = (ni0 - ocf0) / ((ta0 + ta1) / 2);
    components.TATA = r4(TATA);
    present++;
  }

  // M-Score: substitute neutral defaults for unavailable components
  let m_score = null;
  if (present >= 5) {
    m_score = -4.84
      + 0.920 * (DSRI  ?? 1.0)
      + 0.528 * (GMI   ?? 1.0)
      + 0.404 * (AQI   ?? 1.0)
      + 0.892 * (SGI   ?? 1.0)
      + 0.115 * (DEPI  ?? 1.0)
      - 0.172 * (SGAI  ?? 1.0)
      + 4.679 * (TATA  ?? 0.0)
      - 0.327 * (LVGI  ?? 1.0);
    m_score = r4(m_score);
  }

  let manipulation_risk;
  if (m_score === null)        manipulation_risk = "INSUFFICIENT_DATA";
  else if (m_score > -1.78)   manipulation_risk = "MANIPULATION_RISK";
  else if (m_score > -2.22)   manipulation_risk = "BORDERLINE";
  else                         manipulation_risk = "LIKELY_CLEAN";

  return {
    m_score,
    manipulation_risk,
    components,
    components_available: present,
    note: present < 8
      ? `${8 - present} of 8 components unavailable from reported data; neutral defaults used for missing ones.`
      : null,
  };
}

// ── Sloan Accruals ───────────────────────────────────────────────────────────

function computeAccruals(bsList, isList, cfList) {
  const bs0 = bsList[0], bs1 = bsList[1];
  const is0 = isList[0];
  const cf0 = cfList[0];

  const ni0  = rawVal(is0?.netIncomeFromContinuingOps) ?? rawVal(is0?.netIncome);
  const ocf0 = rawVal(cf0?.totalCashFromOperatingActivities);
  const ta0  = rawVal(bs0?.totalAssets);
  const ta1  = rawVal(bs1?.totalAssets);

  if (ni0 == null || ocf0 == null || !ta0 || !ta1) {
    return { sloan_accrual_ratio: null, cash_conversion_ratio: null, accrual_signal: "INSUFFICIENT_DATA" };
  }

  const avg_ta = (ta0 + ta1) / 2;
  const sloan  = (ni0 - ocf0) / avg_ta;
  const ccr    = ni0 !== 0 ? ocf0 / ni0 : null;

  let accrual_signal;
  if      (sloan > 0.10)  accrual_signal = "HIGH_ACCRUALS";
  else if (sloan > 0.05)  accrual_signal = "MODERATE_ACCRUALS";
  else if (sloan < -0.05) accrual_signal = "CASH_BACKED";
  else                    accrual_signal = "NEUTRAL";

  return {
    sloan_accrual_ratio:   r4(sloan),
    cash_conversion_ratio: r2(ccr),
    accrual_signal,
  };
}

// ── Revenue Quality ──────────────────────────────────────────────────────────

function computeRevenueQuality(bsList, isList) {
  if (bsList.length < 2 || isList.length < 2) return null;

  const bs0 = bsList[0], bs1 = bsList[1];
  const is0 = isList[0], is1 = isList[1];

  const ar0  = rawVal(bs0?.netReceivables);
  const ar1  = rawVal(bs1?.netReceivables);
  const rev0 = rawVal(is0?.totalRevenue);
  const rev1 = rawVal(is1?.totalRevenue);

  if (ar0 == null || ar1 == null || !rev0 || !rev1 || ar1 === 0 || rev1 === 0) return null;

  const ar_growth  = (ar0 - ar1) / Math.abs(ar1);
  const rev_growth = (rev0 - rev1) / Math.abs(rev1);
  const spread     = ar_growth - rev_growth;

  let signal;
  if      (spread >  0.10) signal = "AR_GROWING_FASTER_THAN_REVENUE";
  else if (spread >  0.05) signal = "MILD_AR_DIVERGENCE";
  else if (spread < -0.05) signal = "REVENUE_GROWING_FASTER_THAN_AR";
  else                     signal = "ALIGNED";

  return {
    revenue_growth_pct:          pct(rev_growth),
    receivables_growth_pct:      pct(ar_growth),
    ar_vs_revenue_spread_pct:    pct(spread),
    signal,
  };
}

// ── Export ───────────────────────────────────────────────────────────────────

export default {
  name:  "earnings-quality",
  price: "$0.079",

  description:
    "Stock earnings quality and manipulation-risk screen for any US public company. Returns Beneish M-Score (8-component manipulation detector: M > -1.78 = manipulation risk), Sloan Accrual Ratio, cash conversion ratio, and AR vs revenue quality signal. Designed to chain after income-statements and equity-fundamentals to gate on earnings integrity before valuation.",

  outputSchema: {
    type: "object",
    properties: {
      ticker: { type: "string" },
      beneish: {
        type: "object",
        description: "Beneish M-Score analysis (Beneish 1999).",
        properties: {
          m_score:              { type: ["number", "null"], description: "Beneish M-Score. > -1.78: manipulation risk. -2.22 to -1.78: borderline. < -2.22: likely clean." },
          manipulation_risk:    { type: "string",           description: "MANIPULATION_RISK | BORDERLINE | LIKELY_CLEAN | INSUFFICIENT_DATA" },
          components:           { type: "object",           description: "8 M-Score component values: DSRI, GMI, AQI, SGI, DEPI, SGAI, LVGI, TATA." },
          components_available: { type: "integer",          description: "Number of components computed from available data (max 8)." },
          note:                 { type: ["string", "null"], description: "Caveat when components substituted with neutral defaults." },
        },
      },
      accruals: {
        type: "object",
        description: "Sloan accrual ratio and cash conversion quality.",
        properties: {
          sloan_accrual_ratio:   { type: ["number", "null"], description: "(NI - OCF) / Avg Total Assets. Negative = cash-backed. > 0.10 = high accruals." },
          cash_conversion_ratio: { type: ["number", "null"], description: "OCF / NI. > 1.0 = cash-backed. < 0.5 = earnings not converting to cash." },
          accrual_signal:        { type: "string",           description: "HIGH_ACCRUALS | MODERATE_ACCRUALS | NEUTRAL | CASH_BACKED | INSUFFICIENT_DATA" },
        },
      },
      revenue_quality: {
        type: ["object", "null"],
        description: "Receivables growth vs revenue growth divergence. Null if data unavailable.",
        properties: {
          revenue_growth_pct:        { type: "number", description: "Year-over-year revenue growth %." },
          receivables_growth_pct:    { type: "number", description: "Year-over-year AR growth %." },
          ar_vs_revenue_spread_pct:  { type: "number", description: "AR growth minus revenue growth %. Positive = AR growing faster (warning)." },
          signal:                    { type: "string", description: "AR_GROWING_FASTER_THAN_REVENUE | MILD_AR_DIVERGENCE | ALIGNED | REVENUE_GROWING_FASTER_THAN_AR" },
        },
      },
      overall_quality: { type: "string", description: "Composite verdict: HIGH | MEDIUM | LOW | INSUFFICIENT_DATA" },
      risk_flags:      { type: "array",  items: { type: "string" }, description: "Triggered quality warnings (BENEISH_MANIPULATION_RISK, HIGH_ACCRUAL_RATIO, AR_OUTPACING_REVENUE, etc.)." },
      statement_period:{ type: ["string", "null"], description: "Fiscal year end of most recent annual statements (YYYY-MM-DD)." },
      retrieved_at:    { type: "string" },
    },
  },

  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type:        "string",
        description: "US stock ticker symbol (e.g. AAPL, MSFT, ENRN). Case-insensitive.",
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

    const bsList = result.balanceSheetHistory?.balanceSheetStatements   ?? [];
    const isList = result.incomeStatementHistory?.incomeStatementHistory ?? [];
    const cfList = result.cashflowStatementHistory?.cashflowStatements  ?? [];

    const beneish         = computeBeneish(bsList, isList, cfList);
    const accruals        = computeAccruals(bsList, isList, cfList);
    const revenue_quality = computeRevenueQuality(bsList, isList);

    // Risk flags
    const risk_flags = [];
    if (beneish.manipulation_risk === "MANIPULATION_RISK")                                           risk_flags.push("BENEISH_MANIPULATION_RISK");
    if (beneish.manipulation_risk === "BORDERLINE")                                                  risk_flags.push("BENEISH_BORDERLINE");
    if (accruals.accrual_signal   === "HIGH_ACCRUALS")                                               risk_flags.push("HIGH_ACCRUAL_RATIO");
    if (accruals.cash_conversion_ratio != null && accruals.cash_conversion_ratio >= 0 && accruals.cash_conversion_ratio < 0.5) risk_flags.push("LOW_CASH_CONVERSION");
    if (accruals.cash_conversion_ratio != null && accruals.cash_conversion_ratio < 0)               risk_flags.push("NEGATIVE_OPERATING_CASHFLOW");
    if (revenue_quality?.signal === "AR_GROWING_FASTER_THAN_REVENUE")                               risk_flags.push("AR_OUTPACING_REVENUE");
    if ((beneish.components?.DSRI  ?? 0) > 1.5)  risk_flags.push("RAPID_RECEIVABLES_GROWTH");
    if ((beneish.components?.SGI   ?? 0) > 1.3)  risk_flags.push("AGGRESSIVE_REVENUE_GROWTH");
    if ((beneish.components?.TATA  ?? 0) > 0.08) risk_flags.push("ELEVATED_ACCRUALS");
    if ((beneish.components?.GMI   ?? 0) > 1.2)  risk_flags.push("DETERIORATING_GROSS_MARGINS");
    if ((beneish.components?.LVGI  ?? 0) > 1.2)  risk_flags.push("INCREASING_LEVERAGE");

    // Composite quality verdict
    let overall_quality;
    const noData    = beneish.manipulation_risk === "INSUFFICIENT_DATA" && accruals.accrual_signal === "INSUFFICIENT_DATA";
    const manipRisk = beneish.manipulation_risk === "MANIPULATION_RISK";
    const borderline = beneish.manipulation_risk === "BORDERLINE";
    const highAcc   = accruals.accrual_signal === "HIGH_ACCRUALS";
    const cashBacked = accruals.accrual_signal === "CASH_BACKED";
    const likelyClean = beneish.manipulation_risk === "LIKELY_CLEAN";

    if      (noData)                         overall_quality = "INSUFFICIENT_DATA";
    else if (manipRisk && highAcc)           overall_quality = "LOW";
    else if (manipRisk)                      overall_quality = "LOW";
    else if (borderline && highAcc)          overall_quality = "LOW";
    else if (borderline || highAcc)          overall_quality = "MEDIUM";
    else if (likelyClean && cashBacked)      overall_quality = "HIGH";
    else if (likelyClean)                    overall_quality = "MEDIUM";
    else                                     overall_quality = "MEDIUM";

    const periodTs = rawVal(bsList[0]?.endDate);
    const statement_period = periodTs ? new Date(periodTs * 1000).toISOString().slice(0, 10) : null;

    return {
      ticker,
      beneish,
      accruals,
      revenue_quality,
      overall_quality,
      risk_flags,
      statement_period,
      retrieved_at: new Date().toISOString(),
    };
  },
};
