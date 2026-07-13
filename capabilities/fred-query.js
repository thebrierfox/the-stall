// fred-query.js
//
// Pull any FRED (Federal Reserve Bank of St. Louis) economic series by ID.
// Returns the most recent N observations plus summary statistics, trend
// direction, and frequency detection. Covers 800,000+ economic time series
// sourced from 100+ organizations (BLS, BEA, Census, Fed, OECD, etc.).
//
// Source: fred.stlouisfed.org/graph/fredgraph.csv — public endpoint, no API key.
//
// Seam: existing FRED-based caps (macro-indicators, economic-momentum, bonds-brief,
// labor-brief, housing-brief) pull FIXED series. This cap gives agents free-form
// access to any series ID — custom dashboards, one-off research queries, and
// series the pre-built briefs don't cover (M2, Fed balance sheet, truck tonnage,
// margin debt, consumer credit, etc.).
//
// Example series:
//   M2SL      — M2 Money Supply
//   WALCL     — Fed Balance Sheet (Total Assets)
//   ISRATIO   — Business Inventory-to-Sales Ratio
//   TRUCKD11  — ATA Truck Tonnage Index
//   PAYEMS    — Total Nonfarm Payroll Employment
//   DGS30     — 30-Year Treasury Yield
//   T10YIE    — 10-Year Breakeven Inflation Rate
//   VIXCLS    — CBOE Volatility Index
//   DCOILBRENTEU — Brent Crude Oil Spot Price

const FRED_BASE = "https://fred.stlouisfed.org/graph/fredgraph.csv";
const UA        = "Mozilla/5.0 (compatible; the-stall/4.65; +https://intuitek.ai)";
const TIMEOUT   = 12_000;

async function fetchSeries(seriesId, limit) {
  const url = `${FRED_BASE}?id=${encodeURIComponent(seriesId.toUpperCase())}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/csv, */*" },
    signal:  AbortSignal.timeout(TIMEOUT),
  });

  if (res.status === 400 || res.status === 404) {
    throw Object.assign(
      new Error(`FRED series '${seriesId}' not found. Verify the series ID at fred.stlouisfed.org.`),
      { status: 404 }
    );
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    // FRED sometimes returns HTML with an error page for invalid series
    if (txt.includes("<!DOCTYPE") || txt.includes("<html")) {
      throw Object.assign(
        new Error(`FRED series '${seriesId}' not found or not publicly available.`),
        { status: 404 }
      );
    }
    throw new Error(`FRED HTTP ${res.status} for series ${seriesId}`);
  }

  const text = await res.text();
  const lines = text.trim().split("\n");

  if (lines.length < 2) throw new Error(`FRED returned no data for series ${seriesId}`);

  // Parse header and rows
  const header = lines[0].split(",").map(h => h.trim());
  const dateCol = header.indexOf("observation_date") !== -1
    ? header.indexOf("observation_date")
    : 0;
  const valCol = header.length > 1 ? (dateCol === 0 ? 1 : 0) : 1;

  const observations = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    const date  = parts[dateCol]?.trim();
    const raw   = parts[valCol]?.trim();
    if (!date || !raw || raw === "." || raw === "") continue;
    const value = parseFloat(raw);
    if (!isNaN(value)) observations.push({ date, value });
  }

  if (!observations.length) {
    throw new Error(`FRED series '${seriesId}' returned no numeric data.`);
  }

  // Return the most recent N observations
  const recent = observations.slice(-Math.min(limit, observations.length));
  return { all: observations, recent };
}

function detectFrequency(observations) {
  if (observations.length < 2) return "unknown";
  const dates = observations.slice(-12).map(o => new Date(o.date));
  const gaps  = [];
  for (let i = 1; i < dates.length; i++) {
    gaps.push((dates[i] - dates[i - 1]) / (1000 * 60 * 60 * 24));
  }
  const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  if (avg <= 2)   return "daily";
  if (avg <= 10)  return "weekly";
  if (avg <= 35)  return "monthly";
  if (avg <= 100) return "quarterly";
  return "annual";
}

function computeStats(observations) {
  if (!observations.length) return {};
  const values  = observations.map(o => o.value);
  const current = values[values.length - 1];
  const prev    = values.length > 1 ? values[values.length - 2] : null;
  const first   = values[0];

  const changeFromPrev   = prev !== null ? current - prev : null;
  const pctChangePrev    = prev !== null && prev !== 0 ? ((current - prev) / Math.abs(prev)) * 100 : null;
  const pctChangeOverall = first !== 0 ? ((current - first) / Math.abs(first)) * 100 : null;

  const sorted  = [...values].sort((a, b) => a - b);
  const min     = sorted[0];
  const max     = sorted[sorted.length - 1];
  const mean    = values.reduce((s, v) => s + v, 0) / values.length;

  // Trend: last quarter of observations vs prior quarter
  let trend = "stable";
  if (values.length >= 4) {
    const half     = Math.floor(values.length / 2);
    const recentHalf = values.slice(-half);
    const priorHalf  = values.slice(0, half);
    const recentMean = recentHalf.reduce((s, v) => s + v, 0) / recentHalf.length;
    const priorMean  = priorHalf.reduce((s, v) => s + v, 0) / priorHalf.length;
    if (priorMean !== 0) {
      const pctDiff = ((recentMean - priorMean) / Math.abs(priorMean)) * 100;
      if (pctDiff > 2)  trend = "rising";
      if (pctDiff < -2) trend = "falling";
    }
  }

  const r2 = n => n !== null ? Math.round(n * 100) / 100 : null;

  return {
    current:               r2(current),
    previous:              prev !== null ? r2(prev) : null,
    change_from_previous:  r2(changeFromPrev),
    pct_change_previous:   r2(pctChangePrev),
    pct_change_over_period: r2(pctChangeOverall),
    min_over_period:       r2(min),
    max_over_period:       r2(max),
    mean_over_period:      r2(mean),
    trend,
    observations_count:    values.length,
  };
}

export default {
  name:  "fred-query",
  price: "$0.021",

  description:
    "Pull any FRED (St. Louis Fed) economic series by ID. Returns recent observations, trend, and summary stats. Covers 800,000+ series: M2, Fed balance sheet, truck tonnage, payrolls, yields, CPI, consumer credit, and more. Free public data, no API key.",

  outputSchema: {
    type: "object",
    properties: {
      series_id:    { type: "string",  description: "FRED series ID queried (uppercased)." },
      frequency:    { type: "string",  description: "Detected data frequency: daily, weekly, monthly, quarterly, or annual." },
      date_range:   { type: "object",  description: "First/last available dates and total observation count for the series." },
      returned:     { type: "integer", description: "Number of observations returned in this response." },
      observations: { type: "array",   description: "Array of {date, value} objects for the most recent N observations." },
      stats:        { type: "object",  description: "Summary: current, previous, change, pct_change, min, max, mean, trend over the returned window." },
      source:       { type: "string",  description: "Data source attribution." },
      coverage:     { type: "string",  description: "Scope of available FRED data." },
      tip:          { type: "string",  description: "How to find additional FRED series IDs." },
    },
  },

  inputSchema: {
    type: "object",
    properties: {
      series_id: {
        type:        "string",
        description: "FRED series ID (case-insensitive). Examples: M2SL (M2 money supply), WALCL (Fed balance sheet), PAYEMS (nonfarm payrolls), ISRATIO (inventory/sales ratio), TRUCKD11 (truck tonnage), T10YIE (10Y breakeven inflation), VIXCLS (VIX). Find series at fred.stlouisfed.org.",
      },
      limit: {
        type:        "integer",
        description: "Number of most recent observations to return (1–60). Default: 12.",
        minimum:     1,
        maximum:     60,
        default:     12,
      },
    },
    required: ["series_id"],
  },

  async handler({ series_id, limit = 12 }) {
    if (!series_id || !series_id.trim()) {
      throw Object.assign(new Error("series_id is required. Example: 'M2SL', 'PAYEMS', 'WALCL'."), { status: 400 });
    }

    const id  = series_id.trim().toUpperCase();
    const n   = Math.min(Math.max(parseInt(limit) || 12, 1), 60);

    const { all, recent } = await fetchSeries(id, n);

    const frequency = detectFrequency(all);
    const stats     = computeStats(recent);

    return {
      series_id:  id,
      frequency,
      date_range: {
        first_available: all[0].date,
        last_available:  all[all.length - 1].date,
        total_observations: all.length,
      },
      returned:     recent.length,
      observations: recent,
      stats,
      source:       "FRED — Federal Reserve Bank of St. Louis (fred.stlouisfed.org)",
      coverage:     "800,000+ economic series from BLS, BEA, Census, Federal Reserve, OECD, World Bank, and more",
      tip:          "Find series IDs at fred.stlouisfed.org/search — search for any economic indicator and copy the FRED Series ID.",
    };
  },
};
