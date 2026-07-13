// global-equity-indices.js
//
// Global equity market snapshot: major indices across Asia, Europe, and
// the US Dollar Index (DXY) as the currency backdrop.
//
// Returns current level, daily % change, and 52-week range context for
// each index, plus region-level posture (bullish / mixed / bearish).
//
// Free upstream: Yahoo Finance public chart API (no API key, no auth).
// Tickers: ^N225, ^HSI, ^AXJO, ^NSEI, 000001.SS, ^FTSE, ^GDAXI, ^FCHI,
//          ^STOXX50E, DX-Y.NYB
//
// Seam: global macro agents and forex agents need overnight market context —
// "what did Asia do while the US slept?" — before building US market posture.
// Fills the non-US gap left by market-overview (US equity + VIX only).
// Pairs with: market-overview, treasury-yields, forex-rates, fomc-tracker,
//             imf-country-outlook, macro-brief.
//
// Price: $0.010

const YF_BASE = "https://query2.finance.yahoo.com/v8/finance/chart";
const UA      = "Mozilla/5.0 (compatible; the-stall/4.2; +https://intuitek.ai)";
const TIMEOUT = 10_000;

const INDICES = [
  { ticker: "^N225",     name: "Nikkei 225",        region: "Asia"   },
  { ticker: "^HSI",      name: "Hang Seng",          region: "Asia"   },
  { ticker: "^AXJO",     name: "ASX 200",            region: "Asia"   },
  { ticker: "^NSEI",     name: "Nifty 50",           region: "Asia"   },
  { ticker: "000001.SS", name: "Shanghai Composite", region: "Asia"   },
  { ticker: "^FTSE",     name: "FTSE 100",           region: "Europe" },
  { ticker: "^GDAXI",    name: "DAX",                region: "Europe" },
  { ticker: "^FCHI",     name: "CAC 40",             region: "Europe" },
  { ticker: "^STOXX50E", name: "Euro Stoxx 50",      region: "Europe" },
  { ticker: "DX-Y.NYB",  name: "US Dollar Index",    region: "FX"     },
];

function r2(n) { return Math.round(n * 100) / 100; }

async function fetchIndex({ ticker, name, region }) {
  const url = `${YF_BASE}/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!resp.ok) return { ticker, name, region, error: `HTTP ${resp.status}` };
    const data   = await resp.json();
    const result = data?.chart?.result?.[0];
    if (!result) return { ticker, name, region, error: "no_data" };

    const meta       = result.meta;
    const price      = meta.regularMarketPrice ?? null;
    const prev       = meta.chartPreviousClose ?? price;
    const change_pct = (price !== null && prev) ? r2(((price - prev) / prev) * 100) : null;
    const w52_high   = meta.fiftyTwoWeekHigh   ?? null;
    const w52_low    = meta.fiftyTwoWeekLow    ?? null;
    const from_high  = (price && w52_high) ? r2(((price - w52_high) / w52_high) * 100) : null;

    return {
      ticker,
      name,
      region,
      price:                   price !== null ? r2(price) : null,
      change_pct,
      w52_high,
      w52_low,
      pct_from_52w_high:       from_high,
      ts: meta.regularMarketTime
        ? new Date(meta.regularMarketTime * 1000).toISOString()
        : null,
    };
  } catch (e) {
    return { ticker, name, region, error: e.message };
  }
}

function regionSummary(results) {
  const acc = {};
  for (const r of results) {
    if (r.error || r.change_pct === null) continue;
    if (!acc[r.region]) acc[r.region] = { advances: 0, declines: 0, flat: 0, sum: 0, count: 0 };
    const a = acc[r.region];
    a.count++;
    a.sum += r.change_pct;
    if      (r.change_pct > 0.05)  a.advances++;
    else if (r.change_pct < -0.05) a.declines++;
    else                           a.flat++;
  }
  const out = {};
  for (const [region, a] of Object.entries(acc)) {
    out[region] = {
      avg_change_pct: r2(a.sum / a.count),
      advances:       a.advances,
      declines:       a.declines,
      flat:           a.flat,
      posture:        a.advances > a.declines ? "bullish"
                    : a.declines > a.advances ? "bearish"
                    : "mixed",
    };
  }
  return out;
}

export default {
  name:  "global-equity-indices",
  price: "$0.059",

  description:
    "Global stock market and equity index snapshot: 9 major indices (Nikkei 225, Hang Seng, ASX 200, Nifty 50, Shanghai, FTSE 100, DAX, CAC 40, Euro Stoxx 50) plus DXY. Returns current level, daily % change, 52-week range context, and region posture (bullish/mixed/bearish). Free Yahoo Finance data. No API key. Overnight context for global macro agents and forex positioning. $0.010/call.",

  inputSchema: {
    type: "object",
    properties: {
      regions: {
        type: "array",
        items: {
          type: "string",
          enum: ["Asia", "Europe", "FX"],
        },
        description: "Limit to specific regions. Omit for all regions.",
      },
    },
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      indices: {
        type: "array",
        description: "Per-index data.",
        items: {
          type: "object",
          properties: {
            ticker:            { type: "string",  description: "Yahoo Finance ticker."        },
            name:              { type: "string",  description: "Index display name."          },
            region:            { type: "string",  description: "Region: Asia, Europe, or FX." },
            price:             { type: "number",  description: "Current index level."         },
            change_pct:        { type: "number",  description: "Intraday % change."           },
            w52_high:          { type: "number",  description: "52-week high."                },
            w52_low:           { type: "number",  description: "52-week low."                 },
            pct_from_52w_high: { type: "number",  description: "% below 52-week high (negative = below high)." },
            ts:                { type: "string",  description: "Data timestamp (ISO-8601)."   },
            error:             { type: "string",  description: "Error message if fetch failed." },
          },
        },
      },
      region_summary: {
        type: "object",
        description: "Aggregated posture per region.",
        additionalProperties: {
          type: "object",
          properties: {
            avg_change_pct: { type: "number", description: "Average % change across region indices." },
            advances:       { type: "integer" },
            declines:       { type: "integer" },
            flat:           { type: "integer" },
            posture:        { type: "string",  description: "bullish / mixed / bearish." },
          },
        },
      },
      ts: { type: "string", description: "Response timestamp (ISO-8601)." },
    },
  },

  async handler(query) {
    const filter  = query?.regions?.length ? query.regions : null;
    const targets = filter ? INDICES.filter(i => filter.includes(i.region)) : INDICES;

    const results = await Promise.all(targets.map(fetchIndex));

    return {
      indices:        results,
      region_summary: regionSummary(results),
      ts:             new Date().toISOString(),
    };
  },
};
