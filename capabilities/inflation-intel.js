// inflation-intel.js
//
// US CPI inflation snapshot: headline (all-items), core (less food & energy),
// energy, and food — month-over-month and year-over-year % changes, a
// ACCELERATING / DECELERATING / STABLE trend signal derived from 3-month
// core YoY direction, and a plain-English Fed policy implication.
//
// Data source: FRED public CSV (BLS series, no API key, no registration needed).
//   CPIAUCSL — CPI-U All Items, Seasonally Adjusted
//   CPILFESL — CPI Less Food & Energy (Core CPI), SA
//   CPIENGSL — CPI Energy component, SA
//   CPIUFDSL — CPI Food component, SA
//
// Seam: the macro-data layer between fomc-tracker (Fed meeting calendar + rate
// trend) and credit-spreads (market rate expectations). Agents building rate
// scenarios, sector-rotation models, or bond strategies need the current CPI
// picture to calibrate whether the Fed can cut, hold, or must hike.
//
// Pairs with: fomc-tracker, credit-spreads, treasury-yields, sector-rotation.
// Priced at $0.015 — 4-series parallel fetch + trend synthesis.

const FRED_BASE = "https://fred.stlouisfed.org/graph/fredgraph.csv";
const UA        = "Mozilla/5.0 (compatible; the-stall/4.78; +https://intuitek.ai)";
const TMO       = 14_000;
const MONTHS    = 18; // need ≥15 for 3-month trend comparison (15 = 2 YoY comparators)

const SERIES = {
  all_items: "CPIAUCSL",
  core:      "CPILFESL",
  energy:    "CPIENGSL",
  food:      "CPIUFDSL",
};

const r2 = n => (n != null && !isNaN(n) ? Math.round(n * 100) / 100 : null);

async function fetchFredSeries(id) {
  const resp = await fetch(`${FRED_BASE}?id=${id}`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(TMO),
  });
  if (!resp.ok) throw new Error(`FRED ${id} HTTP ${resp.status}`);
  const text = await resp.text();
  if (text.includes("<html") || text.includes("<!DOCTYPE"))
    throw new Error(`FRED ${id} returned HTML — series may be temporarily unavailable`);

  const lines = text.trim().split("\n")
    .filter(l => !l.startsWith("DATE") && l.includes(","));

  const data = [];
  for (let i = lines.length - 1; i >= 0 && data.length < MONTHS; i--) {
    const [date, val] = lines[i].split(",");
    const v = parseFloat(val?.trim());
    if (!isNaN(v) && val?.trim() !== ".") {
      data.unshift({ date: date.trim(), value: v });
    }
  }
  if (data.length < 13) throw new Error(`FRED ${id} returned only ${data.length} data rows`);
  return data;
}

function computeChanges(series) {
  const n = series.length;
  if (n < 13) return null;
  const latest = series[n - 1];
  const prevMo = series[n - 2];
  const prevYr = series[n - 13];
  return {
    date:     latest.date,
    value:    r2(latest.value),
    mom_pct:  r2((latest.value - prevMo.value) / prevMo.value * 100),
    yoy_pct:  r2((latest.value - prevYr.value) / prevYr.value * 100),
  };
}

function computeTrend(series) {
  // Compare core YoY % at current, -1mo, and -2mo to get 3-month direction
  const n = series.length;
  if (n < 15) return "unknown";
  const yoy0 = (series[n - 1].value - series[n - 13].value) / series[n - 13].value * 100;
  const yoy2 = (series[n - 3].value - series[n - 15].value) / series[n - 15].value * 100;
  const delta = yoy0 - yoy2; // positive = accelerating, negative = decelerating
  if (Math.abs(delta) < 0.15) return "STABLE";
  return delta > 0 ? "ACCELERATING" : "DECELERATING";
}

function fedImplication(coreYoY, trend) {
  if (coreYoY == null) return "Insufficient data to assess";
  if (coreYoY > 3.5 && trend === "ACCELERATING")
    return "Core CPI re-accelerating above 3.5% — rate cuts off the table; hike risk rising";
  if (coreYoY > 3.5)
    return "Core CPI well above 2% target; Fed likely on hold, easing not imminent";
  if (coreYoY > 2.5 && trend === "ACCELERATING")
    return "Core inflation above target and rising; Fed maintaining restrictive stance";
  if (coreYoY > 2.5 && trend === "DECELERATING")
    return "Core inflation elevated but cooling; Fed monitoring for sustained progress before cutting";
  if (coreYoY > 2.5)
    return "Core inflation above target; Fed in wait-and-see mode";
  if (coreYoY <= 2.5 && trend === "DECELERATING")
    return "Core inflation near target and decelerating — supports gradual rate cuts";
  if (coreYoY <= 2.5)
    return "Core inflation at or near 2% target — Fed has room to ease";
  return "Inflation data inconclusive";
}

export default {
  name: "inflation-intel",
  price: "$0.021",

  description:
    "US CPI inflation: headline (all-items), core (less food & energy), energy, and food — MoM and YoY % changes, ACCELERATING/DECELERATING/STABLE trend signal, and Fed policy implication. BLS data via FRED public CSV, no API key needed. Pairs with fomc-tracker, credit-spreads, treasury-yields, sector-rotation.",

  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      all_items: {
        type: "object",
        description: "CPI-U All Items, Seasonally Adjusted. Standard 'headline CPI'.",
        properties: {
          date:    { type: "string",  description: "Observation date (YYYY-MM-01, monthly)." },
          value:   { type: "number",  description: "CPI index value (1982-84=100 base)." },
          mom_pct: { type: "number",  description: "Month-over-month % change." },
          yoy_pct: { type: "number",  description: "Year-over-year % change — the headline inflation rate." },
        },
      },
      core: {
        type: "object",
        description: "Core CPI (Less Food & Energy), SA. The Fed's primary inflation signal — strips volatile food and energy.",
        properties: {
          date:    { type: "string" },
          value:   { type: "number" },
          mom_pct: { type: "number", description: "Month-over-month % change." },
          yoy_pct: { type: "number", description: "Year-over-year % change — the core inflation rate the Fed targets." },
        },
      },
      energy: {
        type: "object",
        description: "CPI Energy component, SA. High-volatility driver of headline CPI divergence from core.",
        properties: {
          date:    { type: "string" },
          value:   { type: "number" },
          mom_pct: { type: "number" },
          yoy_pct: { type: "number" },
        },
      },
      food: {
        type: "object",
        description: "CPI Food component, SA.",
        properties: {
          date:    { type: "string" },
          value:   { type: "number" },
          mom_pct: { type: "number" },
          yoy_pct: { type: "number" },
        },
      },
      trend_signal: {
        type: "string",
        description: "Direction of core CPI YoY over the last 3 months: ACCELERATING (rising), DECELERATING (falling), STABLE (< 0.15pp delta), or unknown.",
      },
      fed_implication: {
        type: "string",
        description: "Plain-English Fed policy implication derived from current core CPI level and trend.",
      },
      ts: { type: "string", description: "ISO-8601 timestamp of this response." },
    },
  },

  async handler(_query) {
    const [allResult, coreResult, energyResult, foodResult] = await Promise.allSettled([
      fetchFredSeries(SERIES.all_items),
      fetchFredSeries(SERIES.core),
      fetchFredSeries(SERIES.energy),
      fetchFredSeries(SERIES.food),
    ]);

    // Core and all-items are required; energy and food degrade gracefully
    if (coreResult.status === "rejected")    throw coreResult.reason;
    if (allResult.status === "rejected")     throw allResult.reason;

    const allData  = allResult.value;
    const coreData = coreResult.value;
    const engData  = energyResult.status === "fulfilled" ? energyResult.value : null;
    const foodData = foodResult.status === "fulfilled" ? foodResult.value : null;

    const allChanges  = computeChanges(allData);
    const coreChanges = computeChanges(coreData);
    const engChanges  = engData  ? computeChanges(engData)  : null;
    const foodChanges = foodData ? computeChanges(foodData) : null;

    const trend = computeTrend(coreData);
    const impl  = fedImplication(coreChanges?.yoy_pct ?? null, trend);

    return {
      all_items:       allChanges,
      core:            coreChanges,
      energy:          engChanges,
      food:            foodChanges,
      trend_signal:    trend,
      fed_implication: impl,
      ts:              new Date().toISOString(),
    };
  },
};
