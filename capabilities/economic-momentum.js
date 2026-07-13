// economic-momentum.js
//
// Tracks 6 key FRED monthly economic indicators and classifies each as
// ACCELERATING, STABLE, or DECELERATING. Returns a composite economic
// momentum signal used for sector rotation, rate-path modeling, and
// macro-informed DCF scenario selection.
//
// Indicators (all FRED CSV, no API key):
//   1. UNRATE     — Unemployment Rate (%)
//   2. PAYEMS     — Nonfarm Payrolls (MoM change, thousands)
//   3. CPIAUCSL   — CPI All Items YoY (%)
//   4. CPILFESL   — Core CPI (ex food/energy) YoY (%)
//   5. RSAFS      — Advance Retail Sales MoM (%)
//   6. INDPRO     — Industrial Production Index YoY (%)
//
// Composite signal: HOT | WARM | GOLDILOCKS | COOLING | COLD
//   HOT        — strong employment + rising/high inflation (Fed hawkish)
//   WARM       — solid growth, inflation near target
//   GOLDILOCKS — growth + inflation both cooling toward target
//   COOLING    — softening employment + falling inflation (Fed dovish)
//   COLD       — contracting employment and demand
//
// Seam: replaces manual assembly of 6 FRED data pulls + spreadsheet
//       computation for macro research workflows. $0.018/call.
//
// Upstream: FRED CSV (https://fred.stlouisfed.org/graph/fredgraph.csv)
//           No API key. Monthly data. ~15–30 rows needed per call.

const FRED_BASE = "https://fred.stlouisfed.org/graph/fredgraph.csv";
const UA        = "Mozilla/5.0 (compatible; the-stall/4.64; +https://intuitek.ai)";
const FRED_TMO  = 18_000;

const r2 = n => Math.round(n * 100) / 100;
const r1 = n => Math.round(n * 10)  / 10;

// ── FRED CSV fetch — returns array of {date, value} sorted ascending ─────────
async function fetchFREDHistory(series, monthsBack = 14) {
  const url  = `${FRED_BASE}?id=${series}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(FRED_TMO),
  });
  if (!resp.ok) throw new Error(`FRED ${series} HTTP ${resp.status}`);
  const text  = await resp.text();
  const lines = text.trim().split("\n").filter(l => l.match(/^\d{4}-\d{2}-\d{2},/));
  const rows  = [];
  for (const line of lines) {
    const [date, val] = line.split(",");
    const v = parseFloat(val?.trim());
    if (!isNaN(v)) rows.push({ date: date.trim(), value: v });
  }
  // Return last N months only
  return rows.slice(-monthsBack);
}

// ── Indicator analysis ────────────────────────────────────────────────────────
function trendDir(current, prior) {
  if (prior == null) return "UNKNOWN";
  const delta = current - prior;
  if (Math.abs(delta) < 0.01) return "STABLE";
  return delta > 0 ? "RISING" : "FALLING";
}

function momentum3m(vals) {
  // vals: array of {date, value} most recent last
  if (vals.length < 4) return null;
  const recent = vals.slice(-3).map(v => v.value);
  const older  = vals.slice(-6, -3).map(v => v.value);
  const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
  const avgOlder  = older.reduce((a, b) => a + b, 0)  / older.length;
  if (avgOlder === 0) return null;
  return r2(((avgRecent - avgOlder) / Math.abs(avgOlder)) * 100);
}

// ── Main analysis functions ───────────────────────────────────────────────────
function analyzeUnrate(rows) {
  if (rows.length < 2) return null;
  const cur  = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const m3   = momentum3m(rows);
  const signal = cur.value <= 4.0 ? "LABOR_TIGHT"
    : cur.value <= 4.5             ? "LABOR_MODERATE"
    : cur.value <= 5.5             ? "LABOR_SOFTENING"
    :                                "LABOR_WEAK";
  return {
    current:    r2(cur.value),
    prior:      r2(prev.value),
    date:       cur.date,
    mom_change: r2(cur.value - prev.value),
    trend:      trendDir(cur.value, prev.value),
    momentum_3m_pct: m3,
    signal,
  };
}

function analyzePayems(rows) {
  if (rows.length < 2) return null;
  const cur  = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const momDelta = cur.value - prev.value;  // thousands of jobs added MoM
  // Trend across last 3 changes
  const changes = [];
  for (let i = rows.length - 3; i < rows.length; i++) {
    if (i > 0) changes.push(rows[i].value - rows[i - 1].value);
  }
  const avgChange = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : null;
  const signal = momDelta >= 200  ? "JOBS_HOT"
    : momDelta >= 100              ? "JOBS_SOLID"
    : momDelta >= 0                ? "JOBS_WEAK"
    :                                "JOBS_CONTRACTING";
  return {
    current_level: Math.round(cur.value),
    date:          cur.date,
    mom_added_k:   Math.round(momDelta),
    avg_3m_added_k: avgChange != null ? Math.round(avgChange) : null,
    signal,
  };
}

function analyzeCPI(rows, label) {
  if (rows.length < 14) return null;
  const cur   = rows[rows.length - 1];
  const prev  = rows[rows.length - 2];
  const yr_ago = rows[rows.length - 13];
  if (!yr_ago) return null;
  const yoy     = r2(((cur.value - yr_ago.value) / yr_ago.value) * 100);
  const yoyPrev = r2(((prev.value - rows[rows.length - 14]?.value) / rows[rows.length - 14]?.value) * 100);
  const signal = yoy >= 4.0   ? "INFLATION_HOT"
    : yoy >= 3.0               ? "INFLATION_ELEVATED"
    : yoy >= 2.0               ? "INFLATION_NEAR_TARGET"
    :                            "INFLATION_BELOW_TARGET";
  return {
    current_index: r2(cur.value),
    date:          cur.date,
    yoy_pct:       yoy,
    prior_yoy_pct: yoyPrev,
    trend:         trendDir(yoy, yoyPrev),
    signal,
  };
}

function analyzeRetailSales(rows) {
  if (rows.length < 3) return null;
  const cur  = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const mom  = r2(((cur.value - prev.value) / prev.value) * 100);
  const prev2 = rows[rows.length - 3];
  const momPrev = r2(((prev.value - prev2.value) / prev2.value) * 100);
  const signal = mom >= 1.0   ? "CONSUMER_STRONG"
    : mom >= 0                 ? "CONSUMER_MODERATE"
    :                            "CONSUMER_WEAK";
  return {
    current_bn:   r2(cur.value / 1000),
    date:         cur.date,
    mom_pct:      mom,
    prior_mom_pct: momPrev,
    trend:        trendDir(mom, momPrev),
    signal,
  };
}

function analyzeINDPRO(rows) {
  if (rows.length < 14) return null;
  const cur    = rows[rows.length - 1];
  const prev   = rows[rows.length - 2];
  const yr_ago = rows[rows.length - 13];
  if (!yr_ago) return null;
  const yoy    = r2(((cur.value - yr_ago.value) / yr_ago.value) * 100);
  const yoyPrev = rows[rows.length - 14]
    ? r2(((prev.value - rows[rows.length - 14].value) / rows[rows.length - 14].value) * 100)
    : null;
  const signal = yoy >= 2.0   ? "INDUSTRIAL_EXPANDING"
    : yoy >= 0                 ? "INDUSTRIAL_FLAT"
    :                            "INDUSTRIAL_CONTRACTING";
  return {
    current_index: r2(cur.value),
    date:          cur.date,
    yoy_pct:       yoy,
    prior_yoy_pct: yoyPrev,
    trend:         yoyPrev != null ? trendDir(yoy, yoyPrev) : "UNKNOWN",
    signal,
  };
}

// ── Composite momentum classification ─────────────────────────────────────────
function compositeSignal(unrate, payems, cpi, coreCpi, retail, indpro) {
  let score = 0; // +ve = hot, -ve = cold
  const details = [];

  // Employment weight: 30%
  if (unrate) {
    if (unrate.signal === "LABOR_TIGHT")     { score += 3; details.push("labor:tight"); }
    else if (unrate.signal === "LABOR_MODERATE") { score += 1; details.push("labor:moderate"); }
    else if (unrate.signal === "LABOR_SOFTENING") { score -= 1; details.push("labor:softening"); }
    else { score -= 3; details.push("labor:weak"); }
  }
  if (payems) {
    if (payems.signal === "JOBS_HOT")          { score += 2; details.push("jobs:hot"); }
    else if (payems.signal === "JOBS_SOLID")   { score += 1; details.push("jobs:solid"); }
    else if (payems.signal === "JOBS_WEAK")    { score -= 1; details.push("jobs:weak"); }
    else { score -= 3; details.push("jobs:contracting"); }
  }

  // Inflation weight: 30% (hot = hawkish = high score)
  if (cpi) {
    if (cpi.signal === "INFLATION_HOT")             { score += 3; details.push("cpi:hot"); }
    else if (cpi.signal === "INFLATION_ELEVATED")   { score += 1; details.push("cpi:elevated"); }
    else if (cpi.signal === "INFLATION_NEAR_TARGET") { score += 0; details.push("cpi:target"); }
    else { score -= 1; details.push("cpi:low"); }
  }

  // Demand weight: 20%
  if (retail) {
    if (retail.signal === "CONSUMER_STRONG")    { score += 2; details.push("retail:strong"); }
    else if (retail.signal === "CONSUMER_MODERATE") { score += 0; details.push("retail:moderate"); }
    else { score -= 2; details.push("retail:weak"); }
  }

  // Supply weight: 20%
  if (indpro) {
    if (indpro.signal === "INDUSTRIAL_EXPANDING")    { score += 2; details.push("indpro:expanding"); }
    else if (indpro.signal === "INDUSTRIAL_FLAT")    { score += 0; details.push("indpro:flat"); }
    else { score -= 2; details.push("indpro:contracting"); }
  }

  const momentum = score >= 8  ? "HOT"
    : score >= 4               ? "WARM"
    : score >= 0               ? "GOLDILOCKS"
    : score >= -4              ? "COOLING"
    :                            "COLD";

  const fed_signal = momentum === "HOT"        ? "HAWKISH_BIAS"
    : momentum === "WARM"                       ? "HOLD_BIAS"
    : momentum === "GOLDILOCKS"                 ? "NEUTRAL"
    : momentum === "COOLING"                    ? "DOVISH_BIAS"
    :                                             "DOVISH_STRONG";

  const sector_bias = momentum === "HOT" || momentum === "WARM"
    ? "CYCLICALS_OVER_DEFENSIVES"
    : momentum === "GOLDILOCKS"
    ? "BALANCED"
    : "DEFENSIVES_OVER_CYCLICALS";

  return { momentum, score, fed_signal, sector_bias, drivers: details };
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default {
  name: "economic-momentum",
  price: "$0.021",

  description:
    "Tracks 6 key US economic indicators (unemployment, nonfarm payrolls, CPI, core CPI, retail sales, industrial production) from FRED and classifies each as accelerating/stable/decelerating. Returns a composite momentum signal (HOT/WARM/GOLDILOCKS/COOLING/COLD) for sector rotation and rate-path modeling. Free FRED data, no API key required.",

  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },

  outputSchema: {
    type: "object",
    properties: {
      unemployment:    { type: "object", description: "Unemployment rate: current %, MoM change, trend, signal." },
      nonfarm_payrolls: { type: "object", description: "Nonfarm payrolls: MoM jobs added (thousands), 3-month average, signal." },
      cpi:             { type: "object", description: "CPI All Items: YoY %, trend, inflation signal." },
      core_cpi:        { type: "object", description: "Core CPI (ex food/energy): YoY %, trend, inflation signal." },
      retail_sales:    { type: "object", description: "Advance retail sales: MoM %, trend, consumer signal." },
      industrial_production: { type: "object", description: "Industrial production index: YoY %, trend, supply signal." },
      composite:       { type: "object", description: "Composite: momentum (HOT/WARM/GOLDILOCKS/COOLING/COLD), score, Fed signal, sector bias." },
      ts:              { type: "string",  description: "ISO-8601 timestamp of this response." },
    },
  },

  async handler(_query) {
    const [urRows, payRows, cpiRows, coreCpiRows, retailRows, indproRows] = await Promise.all([
      fetchFREDHistory("UNRATE",   6),
      fetchFREDHistory("PAYEMS",   5),
      fetchFREDHistory("CPIAUCSL", 14),
      fetchFREDHistory("CPILFESL", 14),
      fetchFREDHistory("RSAFS",    4),
      fetchFREDHistory("INDPRO",   14),
    ]);

    const unemployment         = analyzeUnrate(urRows);
    const nonfarm_payrolls     = analyzePayems(payRows);
    const cpi                  = analyzeCPI(cpiRows,    "CPI");
    const core_cpi             = analyzeCPI(coreCpiRows, "CoreCPI");
    const retail_sales         = analyzeRetailSales(retailRows);
    const industrial_production = analyzeINDPRO(indproRows);

    const composite = compositeSignal(
      unemployment, nonfarm_payrolls, cpi, core_cpi, retail_sales, industrial_production
    );

    return {
      unemployment,
      nonfarm_payrolls,
      cpi,
      core_cpi,
      retail_sales,
      industrial_production,
      composite,
      ts: new Date().toISOString(),
    };
  },
};
