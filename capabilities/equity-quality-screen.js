// equity-quality-screen.js
//
// Financial quality screen for any US public company. Returns Stock Piotroski F-Score
// (9 binary signals from profitability, leverage, and efficiency trends) and
// Altman Z-Score (bankruptcy-distress predictor). Together they answer:
//   "Is this company fundamentally sound and improving?"
//
// Piotroski F-Score (Piotroski 2000): 9 signals → integer 0–9.
//   F≥8: strong quality.  F≤2: distress / deterioration.
//   Profitability (4): ROA>0, OCF>0, ΔROA improving, OCF/Assets > ROA
//   Leverage / Liquidity (3): Δleverage ↓, Δcurrent-ratio ↑, no dilution
//   Efficiency (2): Δgross margin ↑, Δasset-turnover ↑
//
// Altman Z-Score (Altman 1968, revised): continuous composite score.
//   Z = 1.2·X1 + 1.4·X2 + 3.3·X3 + 0.6·X4 + 1.0·X5
//   Z>2.99: SAFE.  1.81–2.99: GREY ZONE.  Z<1.81: DISTRESS RISK.
//
// Runtime-capture use: fundamental pipelines and long/short equity agents call
// this as a gate check — one call produces a standardized quality signal without
// assembling multi-module statements manually.
//
// Upstream: Yahoo Finance quoteSummary (crumb-auth, free, no API key).
// Modules: defaultKeyStatistics + financialData + summaryDetail +
//          balanceSheetHistory + incomeStatementHistory + cashflowStatementHistory
// Price: $0.025/call.

const UA           = "Mozilla/5.0 (compatible; the-stall/4.66; +https://intuitek.ai)";
const YF_CRUMB_SRC = "https://fc.yahoo.com";
const YF_CRUMB_URL = "https://query2.finance.yahoo.com/v1/test/getcrumb";
const YF_SUMMARY   = "https://query2.finance.yahoo.com/v10/finance/quoteSummary";
const TMO          = 16_000;
const CRUMB_TTL    = 30 * 60 * 1000;

let _crumbCache = null;

function r2(n)   { return n != null ? Math.round(n * 100) / 100 : null; }
function r4(n)   { return n != null ? Math.round(n * 10000) / 10000 : null; }
function pct(n)  { return n != null ? r2(n * 100) : null; }
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
    "financialData",
    "summaryDetail",
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

// ── Piotroski F-Score ─────────────────────────────────────────────────────────

function computePiotroski(bsList, isList, cfList) {
  if (!bsList?.length || !isList?.length || !cfList?.length) {
    return { score: null, signals: {}, note: "No statement data returned" };
  }

  const bs0 = bsList[0], bs1 = bsList[1];  // current year, prior year
  const is0 = isList[0], is1 = isList[1];
  const cf0 = cfList[0], cf1 = cfList[1];

  // Raw extractions
  const ta0  = rawVal(bs0?.totalAssets);
  const ta1  = rawVal(bs1?.totalAssets);
  const ni0  = rawVal(is0?.netIncomeFromContinuingOps) ?? rawVal(is0?.netIncome);
  const ni1  = rawVal(is1?.netIncomeFromContinuingOps) ?? rawVal(is1?.netIncome);
  const ocf0 = rawVal(cf0?.totalCashFromOperatingActivities);
  const ocf1 = rawVal(cf1?.totalCashFromOperatingActivities);
  const gp0  = rawVal(is0?.grossProfit);
  const gp1  = rawVal(is1?.grossProfit);
  const rev0 = rawVal(is0?.totalRevenue);
  const rev1 = rawVal(is1?.totalRevenue);
  const ca0  = rawVal(bs0?.totalCurrentAssets);
  const ca1  = rawVal(bs1?.totalCurrentAssets);
  const cl0  = rawVal(bs0?.totalCurrentLiabilities);
  const cl1  = rawVal(bs1?.totalCurrentLiabilities);
  const ltd0 = rawVal(bs0?.longTermDebt) ?? 0;
  const ltd1 = rawVal(bs1?.longTermDebt) ?? 0;
  // Diluted shares proxy: netIncome / dilutedEps
  const eps0 = rawVal(is0?.dilutedEps);
  const eps1 = rawVal(is1?.dilutedEps);
  const sh0  = (ni0 != null && eps0 && eps0 !== 0) ? ni0 / eps0 : null;
  const sh1  = (ni1 != null && eps1 && eps1 !== 0) ? ni1 / eps1 : null;

  // Derived
  const roa0        = (ni0 != null && ta0)  ? ni0 / ta0          : null;
  const roa1        = (ni1 != null && ta1)  ? ni1 / ta1          : null;
  const ocfPerTA0   = (ocf0 != null && ta0) ? ocf0 / ta0         : null;
  const gm0         = (gp0 != null && rev0) ? gp0 / rev0         : null;
  const gm1         = (gp1 != null && rev1) ? gp1 / rev1         : null;
  const at0         = (rev0 != null && ta0) ? rev0 / ta0         : null;
  const at1         = (rev1 != null && ta1) ? rev1 / ta1         : null;
  const lev0        = ta0 ? ltd0 / ta0 : null;
  const lev1        = ta1 ? ltd1 / ta1 : null;
  const cr0         = (ca0 != null && cl0)  ? ca0 / cl0          : null;
  const cr1         = (ca1 != null && cl1)  ? ca1 / cl1          : null;

  const F1 = roa0      != null             ? (roa0  > 0                     ? 1 : 0) : null;
  const F2 = ocf0      != null             ? (ocf0  > 0                     ? 1 : 0) : null;
  const F3 = (roa0 != null && roa1 != null)? (roa0  > roa1                  ? 1 : 0) : null;
  const F4 = (ocfPerTA0 != null && roa0 != null) ? (ocfPerTA0 > roa0       ? 1 : 0) : null;
  const F5 = (lev0 != null && lev1 != null)? (lev0  < lev1                  ? 1 : 0) : null;
  const F6 = (cr0  != null && cr1  != null)? (cr0   > cr1                   ? 1 : 0) : null;
  const F7 = (sh0  != null && sh1  != null)? (sh0   <= sh1 * 1.02           ? 1 : 0) : null; // 2% tolerance
  const F8 = (gm0  != null && gm1  != null)? (gm0   > gm1                   ? 1 : 0) : null;
  const F9 = (at0  != null && at1  != null)? (at0   > at1                   ? 1 : 0) : null;

  const signals = {
    F1_roa_positive:          F1,
    F2_ocf_positive:          F2,
    F3_roa_improving:         F3,
    F4_quality_earnings:      F4,
    F5_leverage_decreasing:   F5,
    F6_liquidity_improving:   F6,
    F7_no_dilution:           F7,
    F8_gross_margin_improving:F8,
    F9_asset_turnover_improving: F9,
  };

  const scored = Object.values(signals).filter(v => v !== null);
  const sum    = scored.reduce((a, b) => a + b, 0);
  const score  = scored.length >= 6 ? sum : null;

  return {
    score,
    max: 9,
    signals,
    periods_used: bsList?.length ?? 0,
    note: bs1 == null ? "Only 1 year of history — YoY signals set to null" : null,
  };
}

// ── Altman Z-Score ────────────────────────────────────────────────────────────

function computeAltmanZ(bs0, is0, ks, sd) {
  const ta   = rawVal(bs0?.totalAssets);
  if (!ta || ta === 0) return { z_score: null, zone: null, components: null };

  const ca   = rawVal(bs0?.totalCurrentAssets);
  const cl   = rawVal(bs0?.totalCurrentLiabilities);
  const re   = rawVal(bs0?.retainedEarnings);
  const tl   = rawVal(bs0?.totalLiab);
  const rev  = rawVal(is0?.totalRevenue);
  const ebit = rawVal(is0?.ebit) ?? rawVal(is0?.operatingIncome);
  const mktCap = rawVal(ks?.marketCap) ?? rawVal(sd?.marketCap);

  const X1 = (ca != null && cl != null) ? (ca - cl) / ta : null;
  const X2 = re  != null ? re  / ta : null;
  const X3 = ebit != null ? ebit / ta : null;
  const X4 = (mktCap != null && tl) ? mktCap / tl : null;
  const X5 = rev != null ? rev / ta : null;

  const nullCount = [X1, X2, X3, X4, X5].filter(v => v === null).length;
  if (nullCount > 2) return { z_score: null, zone: "INSUFFICIENT_DATA", components: { X1, X2, X3, X4, X5 } };

  const Z = 1.2*(X1??0) + 1.4*(X2??0) + 3.3*(X3??0) + 0.6*(X4??0) + 1.0*(X5??0);
  const zone = Z > 2.99 ? "SAFE" : Z > 1.81 ? "GREY" : "DISTRESS";

  return {
    z_score: r4(Z),
    zone,
    components: { X1: r4(X1), X2: r4(X2), X3: r4(X3), X4: r4(X4), X5: r4(X5) },
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default {
  name:  "equity-quality-screen",
  price: "$0.025",
  description:
    "Stock Piotroski F-Score (0–9 quality composite: profitability+leverage+efficiency trends) " +
    "and Altman Z-Score (distress predictor) for any US public company. One call replaces " +
    "manual assembly of 3 years of annual statements. $0.025/call.",

  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description: "US stock ticker symbol (e.g. AAPL, NVDA, MSFT). Case-insensitive.",
      },
    },
    required: ["ticker"],
  },

  outputSchema: {
    type: "object",
    properties: {
      ticker:        { type: "string",  description: "Canonical ticker." },
      quality_tier:  { type: "string",  description: "STRONG | GOOD | NEUTRAL | WEAK | VERY_WEAK | INSUFFICIENT_DATA" },
      composite_signal: { type: "string", description: "BUY_QUALITY | WATCH | AVOID | UNKNOWN — synthesized from F-Score + Z-Score." },
      piotroski: {
        type: "object",
        properties: {
          score:  { type: "number", description: "F-Score 0–9. ≥8 = strong, ≤2 = distress." },
          max:    { type: "number" },
          signals:{ type: "object", description: "9 binary signals (1=pass, 0=fail, null=no data)." },
          periods_used: { type: "number" },
          note:   { type: "string" },
        },
      },
      altman: {
        type: "object",
        properties: {
          z_score: { type: "number", description: "Composite Z. >2.99 SAFE, 1.81–2.99 GREY, <1.81 DISTRESS." },
          zone:    { type: "string", description: "SAFE | GREY | DISTRESS | INSUFFICIENT_DATA" },
          components: { type: "object", description: "X1–X5 component ratios." },
        },
      },
      risk_flags: { type: "array", items: { type: "string" } },
      moat_signals: {
        type: "object",
        description: "High-level moat indicators from current financials.",
        properties: {
          gross_margin_pct:      { type: "number" },
          return_on_equity_pct:  { type: "number" },
          return_on_assets_pct:  { type: "number" },
          operating_margin_pct:  { type: "number" },
          debt_to_equity:        { type: "number" },
          current_ratio:         { type: "number" },
          gross_margin_tier:     { type: "string", description: "HIGH(>40%) | MEDIUM(20-40%) | LOW(<20%)" },
          roe_tier:              { type: "string", description: "EXCELLENT(>20%) | GOOD(10-20%) | WEAK(<10%)" },
        },
      },
      statement_period: { type: "string",  description: "Fiscal year end of most recent annual statement used." },
      retrieved_at:     { type: "string" },
    },
  },

  async handler({ ticker }) {
    if (!ticker) throw new Error("ticker is required");
    ticker = ticker.toUpperCase().trim().replace(/[^A-Z0-9.\-]/g, "");

    const raw     = await fetchSummary(ticker);
    const result  = raw?.quoteSummary?.result?.[0];
    if (!result)  throw new Error(`No data for ${ticker} — check ticker symbol`);

    const ks  = result.defaultKeyStatistics ?? {};
    const fd  = result.financialData        ?? {};
    const sd  = result.summaryDetail        ?? {};
    const bsList = result.balanceSheetHistory?.balanceSheetStatements   ?? [];
    const isList = result.incomeStatementHistory?.incomeStatementHistory ?? [];
    const cfList = result.cashflowStatementHistory?.cashflowStatements  ?? [];

    const piotroski = computePiotroski(bsList, isList, cfList);
    const altman    = computeAltmanZ(bsList[0] ?? {}, isList[0] ?? {}, ks, sd);

    // Quality tier from F-Score
    let quality_tier;
    if (piotroski.score === null) quality_tier = "INSUFFICIENT_DATA";
    else if (piotroski.score >= 8) quality_tier = "STRONG";
    else if (piotroski.score >= 6) quality_tier = "GOOD";
    else if (piotroski.score >= 4) quality_tier = "NEUTRAL";
    else if (piotroski.score >= 2) quality_tier = "WEAK";
    else quality_tier = "VERY_WEAK";

    // Composite signal
    let composite_signal = "UNKNOWN";
    if (piotroski.score != null && altman.zone) {
      const goodScore = piotroski.score >= 6;
      const safe      = altman.zone === "SAFE";
      const distress  = altman.zone === "DISTRESS";
      if (goodScore && safe)                   composite_signal = "BUY_QUALITY";
      else if (distress || piotroski.score <= 2) composite_signal = "AVOID";
      else                                     composite_signal = "WATCH";
    }

    // Risk flags
    const sig = piotroski.signals;
    const risk_flags = [];
    if (altman.zone === "DISTRESS")       risk_flags.push("ALTMAN_DISTRESS");
    if (altman.zone === "GREY")           risk_flags.push("ALTMAN_GREY_ZONE");
    if (sig.F1_roa_positive === 0)        risk_flags.push("NEGATIVE_ROA");
    if (sig.F2_ocf_positive === 0)        risk_flags.push("NEGATIVE_OPERATING_CASHFLOW");
    if (sig.F7_no_dilution === 0)         risk_flags.push("SHARE_DILUTION_DETECTED");
    if (sig.F5_leverage_decreasing === 0) risk_flags.push("LEVERAGE_INCREASING");
    if (sig.F3_roa_improving === 0)       risk_flags.push("DETERIORATING_PROFITABILITY");

    // Moat signals (current data)
    const grossMargPct = pct(rawVal(fd.grossMargins));
    const roePct       = pct(rawVal(fd.returnOnEquity));
    const roaPct       = pct(rawVal(fd.returnOnAssets));
    const opMargPct    = pct(rawVal(fd.operatingMargins));
    const de           = r2(rawVal(fd.debtToEquity));
    const cr           = r2(rawVal(fd.currentRatio));

    const moat_signals = {
      gross_margin_pct:     grossMargPct,
      return_on_equity_pct: roePct,
      return_on_assets_pct: roaPct,
      operating_margin_pct: opMargPct,
      debt_to_equity:       de,
      current_ratio:        cr,
      gross_margin_tier: grossMargPct == null ? null : grossMargPct >= 40 ? "HIGH" : grossMargPct >= 20 ? "MEDIUM" : "LOW",
      roe_tier:          roePct        == null ? null : roePct >= 20 ? "EXCELLENT" : roePct >= 10 ? "GOOD" : "WEAK",
    };

    // Period label
    const periodTs = rawVal(bsList[0]?.endDate);
    const statement_period = periodTs ? new Date(periodTs * 1000).toISOString().slice(0, 10) : null;

    return {
      ticker,
      quality_tier,
      composite_signal,
      piotroski,
      altman,
      risk_flags,
      moat_signals,
      statement_period,
      retrieved_at: new Date().toISOString(),
    };
  },
};
