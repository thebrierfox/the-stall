// short-volume-intel.js — Daily FINRA consolidated short-sale volume for US equities.
//
// Short ratio (short volume / total volume) is one of the cleaner free signals for
// identifying crowded short positions and tracking short-squeeze setups.
//
// Source: FINRA public CDN (cdn.finra.org/equity/regsho/daily/) — no API key, no auth.
// FINRA posts prior-day consolidated data each morning.

const FINRA_BASE = "https://cdn.finra.org/equity/regsho/daily/CNMSshvol";
const UA = "Mozilla/5.0 (compatible; the-stall/0.4; +https://intuitek.ai)";

function prevTradingDays(count) {
  const days = [];
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  // FINRA posts prior-day data — start from yesterday
  d.setUTCDate(d.getUTCDate() - 1);
  while (days.length < count) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const yyyy = d.getUTCFullYear();
      const mm   = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd   = String(d.getUTCDate()).padStart(2, "0");
      days.push(`${yyyy}${mm}${dd}`);
    }
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return days;
}

async function fetchShortForDate(dateStr, ticker) {
  const url = `${FINRA_BASE}${dateStr}.txt`;
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null; // holiday / unavailable
    const text = await resp.text();
    const prefix = `${dateStr}|${ticker}|`;
    const line = text.split("\n").find((l) => l.startsWith(prefix));
    if (!line) return null;
    const parts = line.split("|");
    const shortVol  = parseFloat(parts[2]) || 0;
    const totalVol  = parseFloat(parts[4]) || 0;
    const shortRatio = totalVol > 0 ? shortVol / totalVol : null;
    return {
      date:         `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`,
      short_volume: Math.round(shortVol),
      total_volume: Math.round(totalVol),
      short_ratio:  shortRatio !== null ? Math.round(shortRatio * 1000) / 1000 : null,
      short_pct:    shortRatio !== null ? Math.round(shortRatio * 1000) / 10 : null,
    };
  } catch {
    return null;
  }
}

export default {
  name: "short-volume-intel",
  price: "$0.034",

  description:
    "Daily FINRA consolidated short-sale volume for any US stock ticker: short volume, total volume, and short ratio (short/total) for the last N trading days. Useful for detecting crowded short positions and short-squeeze setups. Free FINRA CDN upstream, no API key.",

  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description: "US stock ticker symbol (e.g. AMD, GME, NVDA). Case-insensitive.",
      },
      days: {
        type: "integer",
        description: "Number of recent trading days to fetch (1–10, default 5).",
        default: 5,
        minimum: 1,
        maximum: 10,
      },
    },
    required: [],
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      ticker: { type: "string" },
      history: {
        type: "array",
        description: "Daily short volume data, most recent first.",
        items: {
          type: "object",
          properties: {
            date:         { type: "string",  description: "Trading date (YYYY-MM-DD)." },
            short_volume: { type: "integer", description: "Short sale share volume." },
            total_volume: { type: "integer", description: "Total consolidated share volume." },
            short_ratio:  { type: "number",  description: "Short volume / total volume (0–1)." },
            short_pct:    { type: "number",  description: "Short percentage (0–100)." },
          },
        },
      },
      avg_short_pct: {
        type: "number",
        description: "Average short percentage across the returned history.",
      },
      trend: {
        type: "string",
        description: "Short ratio trend over the window: INCREASING | DECREASING | FLAT.",
        enum: ["INCREASING", "DECREASING", "FLAT"],
      },
      days_requested: { type: "integer" },
      days_returned:  { type: "integer" },
      source: { type: "string" },
      ts:     { type: "string" },
    },
  },

  async handler(query) {
    const raw = (query.ticker || "AAPL").trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, "");

    const days = Math.min(Math.max(Number(query.days) || 5, 1), 10);
    const dates = prevTradingDays(days + 2); // fetch extra to handle holidays

    const results = await Promise.all(dates.map((d) => fetchShortForDate(d, raw)));
    const history = results.filter(Boolean).slice(0, days);

    if (history.length === 0) {
      throw new Error(`no short volume data found for ticker "${raw}" in recent trading days`);
    }

    const ratios = history.map((h) => h.short_pct).filter((v) => v !== null);
    const avg = ratios.length > 0 ? Math.round(ratios.reduce((a, b) => a + b, 0) / ratios.length * 10) / 10 : null;

    let trend = "FLAT";
    if (ratios.length >= 2) {
      const first = ratios[ratios.length - 1]; // oldest
      const last  = ratios[0];                 // most recent
      if (last - first > 2) trend = "INCREASING";
      else if (first - last > 2) trend = "DECREASING";
    }

    return {
      ticker: raw,
      history,
      avg_short_pct: avg,
      trend,
      days_requested: days,
      days_returned:  history.length,
      source: "FINRA consolidated short-sale volume (public CDN, prior trading day)",
      ts: new Date().toISOString(),
    };
  },
};
