// revenue-growth-intel.js
//
// Revenue growth quality analysis for any US public company.
// Answers the question equity-research agents ask BEFORE projecting DCF growth rates:
// "Is this company's revenue growth reliable, consistent, and accelerating or decelerating?"
//
// Five computed metrics:
//
//   1. Revenue CAGR (1yr, 3yr, 5yr)
//      Compound annual growth rates over trailing periods.
//      Benchmarks: >20% high-growth, 10–20% solid, 5–10% moderate, <5% slow.
//
//   2. Growth Consistency Score
//      Coefficient of variation (σ/μ) of annual YoY growth rates.
//      < 0.3 = HIGHLY_CONSISTENT (commands premium multiple)
//      0.3–0.6 = MODERATE
//      > 0.6 = VOLATILE (DCF growth inputs need wide scenario range)
//
//   3. Revenue Acceleration Index
//      2yr CAGR vs best available long-run CAGR.
//      ACCELERATING / STABLE / DECELERATING — leading indicator for
//      upward/downward EPS revisions.
//
//   4. Gross Margin Trend
//      5-year direction of gross margin.
//      EXPANDING = pricing power or scale leverage.
//      CONTRACTING = commoditization or cost pressure.
//
//   5. Operating Leverage Score
//      Rate of operating income growth vs revenue growth over full history.
//      Ratio > 1.5 = strong leverage (volume flowing through to profit).
//      < 1.0 = fixed-cost drag or reinvestment headwind.
//
// Composite grade (A–F) from CAGR quality + consistency + acceleration + margin.
//
// Runtime-capture seam: equity-research pipelines chain earnings-calendar +
// income-statements + equity-fundamentals, but lack a structured growth quality
// score to anchor DCF growth rate assumptions. This cap fills that gap —
// positioned after income-statements and before dcf-valuation.
//
// Upstream: Yahoo Finance fundamentals timeseries v1 (free, no API key).
// Price: $0.020/call.

const UA           = "Mozilla/5.0 (compatible; the-stall/4.70; +https://intuitek.ai)";
const YF_CRUMB_SRC = "https://fc.yahoo.com";
const YF_CRUMB_URL = "https://query2.finance.yahoo.com/v1/test/getcrumb";
const YF_TS_URL    = "https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries";
const TMO          = 18_000;
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

function cagr(startVal, endVal, years) {
  if (!startVal || !endVal || years <= 0 || startVal <= 0) return null;
  return r4(Math.pow(endVal / startVal, 1 / years) - 1);
}

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + Math.pow(v - m, 2), 0) / (arr.length - 1));
}

function letterGrade(score) {
  if (score >= 80) return "A";
  if (score >= 65) return "B";
  if (score >= 50) return "C";
  if (score >= 35) return "D";
  return "F";
}

const GRADE_INTERP = {
  A: "High-quality, consistent, accelerating revenue growth — DCF growth assumptions can be aggressive",
  B: "Solid growth with good consistency or improving trajectory — standard DCF growth inputs appropriate",
  C: "Moderate or inconsistent growth — apply a conservative haircut to DCF growth rate assumptions",
  D: "Weak or volatile revenue — wide scenario range required; thesis-risk is high",
  F: "Revenue declining or severely deteriorating — DCF requires explicit turnaround assumptions",
};

export default {
  name:  "revenue-growth-intel",
  price: "$0.021",

  description:
    "Revenue growth quality analysis for any US public company. Computes 1/3/5-year revenue CAGRs, growth consistency (coefficient of variation), acceleration vs long-run trend, gross margin direction, and operating leverage. Returns a composite letter grade (A–F) that anchors DCF growth rate assumptions. Chain after income-statements and before dcf-valuation.",

  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type:        "string",
        description: "US stock ticker symbol (e.g. AAPL, MSFT, NVDA). Case-insensitive.",
      },
    },
    required: ["ticker"],
  },

  outputSchema: {
    type: "object",
    properties: {
      ticker:         { type: "string" },
      periods:        { type: "integer",          description: "Number of annual periods available." },
      latest_revenue: { type: ["number","null"],   description: "Most recent full-year revenue ($)." },
      cagr_1y:        { type: ["number","null"],   description: "1-year revenue CAGR (decimal)." },
      cagr_3y:        { type: ["number","null"],   description: "3-year revenue CAGR (decimal)." },
      cagr_5y:        { type: ["number","null"],   description: "5-year revenue CAGR (decimal)." },
      best_available_cagr: { type: ["number","null"], description: "Longest available CAGR (5y > 3y > 1y)." },
      yoy_growth_rates: { type: "array", items: { type: ["number","null"] }, description: "Year-over-year revenue growth rates, oldest to most recent (decimal)." },
      growth_consistency: {
        type: "object",
        properties: {
          coefficient_of_variation: { type: ["number","null"], description: "σ/μ of YoY growth rates. <0.3 consistent, 0.3–0.6 moderate, >0.6 volatile." },
          label: { type: "string", description: "HIGHLY_CONSISTENT | MODERATE | VOLATILE | INSUFFICIENT_DATA" },
        },
      },
      acceleration: {
        type: "object",
        properties: {
          cagr_2y:        { type: ["number","null"], description: "2-year CAGR (recent momentum)." },
          delta_vs_longrun: { type: ["number","null"], description: "2yr CAGR minus long-run CAGR. Positive = accelerating." },
          label:          { type: "string", description: "ACCELERATING | STABLE | DECELERATING" },
        },
      },
      margin_trend:   { type: ["string","null"], description: "Gross margin 5-year direction: EXPANDING | STABLE | CONTRACTING" },
      operating_leverage: {
        type: "object",
        properties: {
          score: { type: ["number","null"], description: "Op-income growth / revenue growth over full history. >1.5 strong, 1.0–1.5 moderate, <1.0 weak." },
          label: { type: ["string","null"], description: "STRONG | MODERATE | WEAK | NEGATIVE | INSUFFICIENT_DATA" },
        },
      },
      composite_score: { type: "integer",  description: "Raw score 0–100 underlying the letter grade." },
      grade:           { type: "string",   description: "Revenue growth quality: A / B / C / D / F." },
      grade_interpretation: { type: "string", description: "One-sentence interpretation of the grade for DCF use." },
      annual_series: {
        type: "array",
        description: "Year-by-year revenue and margin data, oldest to most recent.",
        items: {
          type: "object",
          properties: {
            fiscal_year:      { type: "string" },
            total_revenue:    { type: ["number","null"] },
            gross_profit:     { type: ["number","null"] },
            gross_margin_pct: { type: ["number","null"] },
            operating_income: { type: ["number","null"] },
            op_margin_pct:    { type: ["number","null"] },
            yoy_growth_pct:   { type: ["number","null"] },
          },
        },
      },
      retrieved_at: { type: "string" },
    },
  },

  async handler({ ticker } = {}) {
    if (!ticker) throw Object.assign(new Error("ticker is required"), { status: 400 });
    const sym = ticker.toUpperCase().trim().replace(/[^A-Z0-9.\-]/g, "");
    if (!sym) throw Object.assign(new Error("invalid ticker"), { status: 400 });

    const { crumb, cookies } = await getCrumb();

    const types = [
      "annualTotalRevenue",
      "annualGrossProfit",
      "annualOperatingIncome",
    ].join(",");

    const start = Math.floor((Date.now() - 7 * 365.25 * 24 * 3600 * 1000) / 1000);
    const end   = Math.floor(Date.now() / 1000);
    const url   = `${YF_TS_URL}/${encodeURIComponent(sym)}?type=${encodeURIComponent(types)}&period1=${start}&period2=${end}&crumb=${encodeURIComponent(crumb)}`;

    const resp = await fetch(url, {
      headers: { "User-Agent": UA, "Cookie": cookies, "Accept": "application/json" },
      signal: AbortSignal.timeout(TMO),
    });
    if (resp.status === 401) {
      _crumbCache = null;
      throw Object.assign(new Error("Yahoo Finance auth expired — retry"), { status: 502 });
    }
    if (!resp.ok) throw new Error(`Yahoo Finance timeseries returned ${resp.status}`);

    const data = await resp.json();
    const result = data?.timeseries?.result ?? [];

    const revMap = {};
    const gpMap  = {};
    const opMap  = {};

    for (const item of result) {
      const key = item.meta?.type?.[0] ?? "";
      const rows = item[key] ?? [];
      for (const r of rows) {
        const val = r?.reportedValue?.raw;
        if (val == null) continue;
        if (key === "annualTotalRevenue")   revMap[r.asOfDate] = val;
        else if (key === "annualGrossProfit")   gpMap[r.asOfDate] = val;
        else if (key === "annualOperatingIncome") opMap[r.asOfDate] = val;
      }
    }

    const revDates = Object.keys(revMap).sort();
    if (revDates.length < 2) {
      throw Object.assign(
        new Error(`Insufficient revenue history for ${sym} (≥2 annual periods required)`),
        { status: 422 }
      );
    }

    const revVals = revDates.map(d => revMap[d]);
    const n       = revVals.length;

    // --- CAGR calculations ---
    const latestRev = revVals[n - 1];
    const cagr1     = n >= 2 ? cagr(revVals[n - 2], revVals[n - 1], 1)  : null;
    const cagr3     = n >= 4 ? cagr(revVals[n - 4], revVals[n - 1], 3)  : null;
    const cagr5     = n >= 6 ? cagr(revVals[n - 6], revVals[n - 1], 5)  : null;
    const bestCagr  = cagr5 ?? cagr3 ?? cagr1;

    // --- YoY growth rates ---
    const yoyRates = [];
    for (let i = 1; i < n; i++) {
      if (revVals[i - 1] > 0) yoyRates.push(r4((revVals[i] - revVals[i - 1]) / revVals[i - 1]));
    }

    // --- Growth consistency (coefficient of variation) ---
    const growthMean   = mean(yoyRates);
    const growthStddev = stddev(yoyRates);
    const cv = (growthMean != null && growthStddev != null && growthMean !== 0)
      ? r4(Math.abs(growthStddev / growthMean))
      : null;
    let consistencyLabel = "INSUFFICIENT_DATA";
    if (cv !== null) {
      consistencyLabel = cv < 0.30 ? "HIGHLY_CONSISTENT"
                       : cv < 0.60 ? "MODERATE"
                       : "VOLATILE";
    }

    // --- Revenue acceleration vs long-run ---
    const cagrLongRun = bestCagr;
    const cagr2y = n >= 3 ? cagr(revVals[n - 3], revVals[n - 1], 2) : null;
    let accelerationLabel = null;
    let accelerationDelta = null;
    if (cagr2y != null && cagrLongRun != null) {
      accelerationDelta = r4(cagr2y - cagrLongRun);
      accelerationLabel = accelerationDelta > 0.02 ? "ACCELERATING"
                        : accelerationDelta < -0.02 ? "DECELERATING"
                        : "STABLE";
    }

    // --- Gross margin trend (5-year direction) ---
    const gpDates = Object.keys(gpMap).sort();
    let marginTrend = null;
    if (gpDates.length >= 3) {
      const margins = gpDates
        .filter(d => revMap[d] > 0 && gpMap[d] != null)
        .map(d => gpMap[d] / revMap[d]);
      if (margins.length >= 3) {
        const earlyMargin  = (margins[0] + margins[1]) / 2;
        const recentMargin = (margins[margins.length - 2] + margins[margins.length - 1]) / 2;
        const delta = recentMargin - earlyMargin;
        marginTrend = delta > 0.02 ? "EXPANDING"
                    : delta < -0.02 ? "CONTRACTING"
                    : "STABLE";
      }
    }

    // --- Operating leverage score ---
    const opDates = Object.keys(opMap).sort();
    let opLeverageScore = null;
    let opLeverageLabel = null;
    const sharedDates   = opDates.filter(d => revMap[d] != null);
    if (sharedDates.length >= 3) {
      const n2       = sharedDates.length;
      const earlyRev = revMap[sharedDates[0]];
      const recentRev = revMap[sharedDates[n2 - 1]];
      const earlyOp  = opMap[sharedDates[0]];
      const recentOp = opMap[sharedDates[n2 - 1]];
      if (earlyRev > 0 && earlyOp > 0) {
        const revChg = (recentRev - earlyRev) / earlyRev;
        const opChg  = (recentOp  - earlyOp)  / earlyOp;
        opLeverageScore = revChg !== 0 ? r4(opChg / revChg) : null;
        if (opLeverageScore != null) {
          opLeverageLabel = opLeverageScore >= 1.5 ? "STRONG"
                          : opLeverageScore >= 1.0 ? "MODERATE"
                          : opLeverageScore >= 0   ? "WEAK"
                          : "NEGATIVE";
        }
      } else {
        opLeverageLabel = "INSUFFICIENT_DATA";
      }
    }

    // --- Composite grade (0–100) ---
    // CAGR quality: 0–40 pts
    // Consistency:  0–25 pts
    // Acceleration: 0–20 pts
    // Margin trend: 0–15 pts
    let pts = 0;

    if (bestCagr != null) {
      if      (bestCagr >= 0.25) pts += 40;
      else if (bestCagr >= 0.15) pts += 32;
      else if (bestCagr >= 0.10) pts += 24;
      else if (bestCagr >= 0.05) pts += 14;
      else if (bestCagr >= 0)    pts += 6;
      // negative CAGR = 0 pts
    }

    if (cv !== null) {
      if      (cv < 0.20) pts += 25;
      else if (cv < 0.30) pts += 20;
      else if (cv < 0.45) pts += 13;
      else if (cv < 0.60) pts += 7;
      // cv >= 0.60 = 0 pts
    }

    if (accelerationLabel) {
      if      (accelerationLabel === "ACCELERATING") pts += 20;
      else if (accelerationLabel === "STABLE")        pts += 12;
      // DECELERATING = 0 pts
    }

    if (marginTrend) {
      if      (marginTrend === "EXPANDING")   pts += 15;
      else if (marginTrend === "STABLE")       pts += 10;
      // CONTRACTING = 0 pts
    }

    const compositeGrade = letterGrade(pts);

    // --- Annual series ---
    const annual_series = revDates.map((d, i) => {
      const rev = revVals[i];
      const gp  = gpMap[d]  ?? null;
      const op  = opMap[d]  ?? null;
      return {
        fiscal_year:      d.slice(0, 4),
        total_revenue:    rev,
        gross_profit:     gp,
        gross_margin_pct: (gp != null && rev > 0) ? r2(gp / rev * 100) : null,
        operating_income: op,
        op_margin_pct:    (op != null && rev > 0) ? r2(op / rev * 100) : null,
        yoy_growth_pct:   (i > 0 && revVals[i - 1] > 0)
          ? r2((rev - revVals[i - 1]) / revVals[i - 1] * 100)
          : null,
      };
    });

    return {
      ticker:              sym,
      periods:             n,
      latest_revenue:      latestRev,
      cagr_1y:             cagr1,
      cagr_3y:             cagr3,
      cagr_5y:             cagr5,
      best_available_cagr: bestCagr,
      yoy_growth_rates:    yoyRates,
      growth_consistency: {
        coefficient_of_variation: cv,
        label: consistencyLabel,
      },
      acceleration: {
        cagr_2y:           cagr2y,
        delta_vs_longrun:  accelerationDelta,
        label:             accelerationLabel,
      },
      margin_trend:        marginTrend,
      operating_leverage: {
        score: opLeverageScore,
        label: opLeverageLabel ?? "INSUFFICIENT_DATA",
      },
      composite_score:        pts,
      grade:                  compositeGrade,
      grade_interpretation:   GRADE_INTERP[compositeGrade],
      annual_series,
      retrieved_at: new Date().toISOString(),
    };
  },
};
