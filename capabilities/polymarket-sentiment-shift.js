// polymarket-sentiment-shift.js
//
// Returns Polymarket prediction markets with the largest recent probability
// shifts. Sorted by |oneWeekPriceChange| (or 1-day / 1-month on request).
//
// Seam: orbisapi.com/proxy/polymarket-sentiment-shift-api-9e4424
//   2,864 settlements/week, 7 payers, $0.005/call (signal-intel archive 2026-06-06)
//
// Free upstream: gamma-api.polymarket.com — no API key required.
// Complements prediction-markets.js (which sorts by volume, not movement).

const GAMMA_URL = "https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=200&order=volumeClob&ascending=false";
const UA        = "Mozilla/5.0 (compatible; the-stall/3.8; +https://intuitek.ai)";

export default {
  name: "polymarket-sentiment-shift",
  price: "$0.040",

  description:
    "Returns Polymarket prediction markets with the biggest recent probability shifts — useful for detecting sudden consensus changes on elections, crypto prices, and macro outcomes. Sorted by absolute 1-week change by default. Each result includes current probability, price change, volume, and resolution date. $0.008/call — free upstream.",

  inputSchema: {
    type: "object",
    properties: {
      window: {
        type: "string",
        enum: ["1d", "1w", "1m"],
        description: "Time window for price change ranking: '1d' (24h), '1w' (7-day, default), '1m' (30-day).",
      },
      direction: {
        type: "string",
        enum: ["all", "up", "down"],
        description: "Filter by direction of shift: 'up' (probability rising), 'down' (falling), or 'all' (default).",
      },
      min_volume: {
        type: "number",
        description: "Minimum total USDC trading volume. Default 10000. Higher = more liquid markets.",
      },
      limit: {
        type: "integer",
        description: "Max markets to return (1–20, default 10).",
        minimum: 1,
        maximum: 20,
      },
    },
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      markets: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question:            { type: "string",  description: "The prediction market question." },
            current_probability: { type: "number",  description: "Current YES probability (0–1) from last trade." },
            price_change:        { type: "number",  description: "Probability shift over the requested window (positive = rising)." },
            price_change_1w:     { type: "number",  description: "1-week probability change." },
            price_change_1m:     { type: "number",  description: "1-month probability change." },
            volume_usdc:         { type: "number",  description: "Total USDC trading volume." },
            volume_24hr:         { type: "number",  description: "24-hour USDC volume." },
            end_date:            { type: "string",  description: "ISO-8601 market resolution date." },
            direction:           { type: "string",  description: "'up', 'down', or 'flat'." },
            market_url:          { type: "string",  description: "Direct Polymarket link." },
          },
        },
      },
      window_used:    { type: "string" },
      total_returned: { type: "integer" },
      generated_at:   { type: "string" },
    },
  },

  async handler(query) {
    const window     = (query.window    || "1w").toLowerCase();
    const direction  = (query.direction || "all").toLowerCase();
    const minVol     = Number(query.min_volume ?? 10_000);
    const limit      = Math.min(Math.max(parseInt(query.limit || "10", 10), 1), 20);

    const resp = await fetch(GAMMA_URL, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(18_000),
    });
    if (!resp.ok) throw new Error(`Polymarket API error: HTTP ${resp.status}`);

    const raw = await resp.json();
    if (!Array.isArray(raw)) throw new Error("Unexpected Polymarket response shape");

    const changeField = window === "1d" ? "oneWeekPriceChange"  // 24hr field label in API
                      : window === "1m" ? "oneMonthPriceChange"
                      : "oneWeekPriceChange";                    // default 1w

    let filtered = raw.filter((m) => {
      if (Number(m.volume || 0) < minVol) return false;
      const change = Number(m[changeField] ?? 0);
      if (direction === "up"   && change <= 0) return false;
      if (direction === "down" && change >= 0) return false;
      if (m[changeField] === null || m[changeField] === undefined) return false;
      return true;
    });

    // Sort by absolute change descending — biggest movers first
    filtered.sort((a, b) =>
      Math.abs(Number(b[changeField] || 0)) - Math.abs(Number(a[changeField] || 0))
    );
    filtered = filtered.slice(0, limit);

    const markets = filtered.map((m) => {
      const change1w = Number(m.oneWeekPriceChange  ?? 0);
      const change1m = Number(m.oneMonthPriceChange ?? 0);
      const change   = Number(m[changeField]        ?? 0);
      const prob     = Number(m.lastTradePrice       ?? 0);

      return {
        question:            m.question  || "",
        current_probability: prob,
        price_change:        change,
        price_change_1w:     change1w,
        price_change_1m:     change1m,
        volume_usdc:         Number(m.volume || 0),
        volume_24hr:         Number(m.volume24hr || 0),
        end_date:            m.endDateIso || m.endDate || null,
        direction:           change > 0.005 ? "up" : change < -0.005 ? "down" : "flat",
        market_url:          m.slug ? `https://polymarket.com/event/${m.slug}` : null,
      };
    });

    return {
      markets,
      window_used:    window,
      total_returned: markets.length,
      generated_at:   new Date().toISOString(),
    };
  },
};
