// polymarket-intel.js
//
// Polymarket prediction market intelligence — search by topic or get top markets.
// Returns market questions, current probabilities (Yes/No prices), 24h volume,
// liquidity, price momentum (1d/1wk change), and resolution date.
//
// Seam: blockrun.ai prediction market chain showed 5 distinct wallets routing
// through PM data over 7+ days. Agents building event-driven strategies,
// political risk models, or consensus trackers need a clean no-auth PM feed.
// Polymarket is the dominant PM with $2B+ cumulative volume; Gamma API is free.
//
// Free upstream: gamma-api.polymarket.com — no API key, no auth, real-time data.
// Priced at $0.008 — with keyword search, substantially more useful than raw top-N.

const GAMMA_URL        = "https://gamma-api.polymarket.com/markets";
const GAMMA_EVENTS_URL = "https://gamma-api.polymarket.com/events";
const UA               = "Mozilla/5.0 (compatible; the-stall/4.40; +https://intuitek.ai)";
const TIMEOUT          = 12_000;

export default {
  name:  "polymarket-intel",
  price: "$0.079",

  description:
    "Polymarket prediction market data. Search by topic keyword (e.g. 'bitcoin', 'election', 'fed rate') or retrieve top markets by trading volume. Returns Yes/No probabilities, volume, liquidity, price momentum, and resolution date. No API keys. Use for event risk, trading signal context, or agent decision support.",

  inputSchema: {
    type:       "object",
    properties: {
      q: {
        type:        "string",
        description: "Topic keyword to search (e.g. 'bitcoin', 'trump', 'recession', 'fed rate'). Omit for top markets by volume.",
      },
      limit: {
        type:        "integer",
        minimum:     1,
        maximum:     25,
        description: "Number of markets to return (1–25). Default: 10.",
      },
      period: {
        type:        "string",
        enum:        ["24h", "1wk", "1mo"],
        description: "Volume period used for ranking (default: 24h).",
      },
      min_liquidity: {
        type:        "number",
        description: "Filter out markets with liquidity below this USD threshold (default: 500).",
      },
    },
    required: [],
  },

  outputSchema: {
    type:       "object",
    properties: {
      markets: {
        type:  "array",
        items: {
          type: "object",
          properties: {
            question:         { type: "string" },
            yes_probability:  { type: "number", description: "Current Yes price (0–1 = 0–100%)" },
            no_probability:   { type: "number" },
            volume_24h:       { type: "number", description: "USD volume in last 24h" },
            volume_total:     { type: "number" },
            liquidity:        { type: "number", description: "Total liquidity in USD" },
            spread:           { type: "number", description: "Bid-ask spread (lower = tighter market)" },
            price_change_1d:  { type: "number", description: "Yes-price change in last 24h (positive = bullish)" },
            price_change_1wk: { type: "number", description: "Yes-price change in last 7 days" },
            end_date:         { type: "string", description: "Resolution date ISO-8601" },
            last_trade_price: { type: "number" },
            url:              { type: "string", description: "Polymarket market URL" },
          },
        },
      },
      fetched_at: { type: "string" },
      total_volume_24h: { type: "number", description: "Sum of 24h volume across returned markets" },
    },
  },

  async handler(query) {
    const q           = (query.q ?? "").trim().toLowerCase();
    const limit       = Math.min(Math.max(parseInt(query.limit ?? "10", 10), 1), 25);
    const period      = query.period ?? "24h";
    const minLiq      = parseFloat(query.min_liquidity ?? "500");

    // Map period to API order field
    const orderField = period === "1mo" ? "volume1mo" : period === "1wk" ? "volume1wk" : "volume24hr";

    // When keyword-searching: fetch a large pool from the events API (better grouping),
    // fall back to markets if no event results found.
    let data = [];

    if (q) {
      // Try events endpoint first — broader pool for keyword matching
      const evUrl = `${GAMMA_EVENTS_URL}?limit=200&active=true&closed=false&order=${orderField}&ascending=false`;
      const evRes = await fetch(evUrl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT) });
      if (evRes.ok) {
        const events = await evRes.json();
        if (Array.isArray(events)) {
          const terms = q.split(/\s+/).filter(Boolean);
          const matchedEvents = events.filter(e => {
            const text = (e.title || "").toLowerCase();
            return terms.every(t => text.includes(t));
          });
          // Expand to individual markets from matched events
          for (const e of matchedEvents) {
            for (const m of (e.markets || [])) {
              data.push(m);
            }
          }
        }
      }
      // If event search found nothing, fall back to markets endpoint
      if (data.length === 0) {
        const mUrl = `${GAMMA_URL}?limit=200&active=true&order=${orderField}&ascending=false`;
        const mRes = await fetch(mUrl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT) });
        if (!mRes.ok) throw new Error(`Polymarket Gamma API HTTP ${mRes.status}`);
        const all = await mRes.json();
        if (!Array.isArray(all)) throw new Error("Unexpected response format");
        const terms = q.split(/\s+/).filter(Boolean);
        data = all.filter(m => {
          const text = (m.question || "").toLowerCase();
          return terms.every(t => text.includes(t));
        });
      }
    } else {
      // No keyword: fetch top markets directly
      const fetchLimit = Math.min(limit * 3, 75);
      const url = `${GAMMA_URL}?limit=${fetchLimit}&active=true&order=${orderField}&ascending=false`;
      const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT) });
      if (!r.ok) throw new Error(`Polymarket Gamma API HTTP ${r.status}`);
      data = await r.json();
      if (!Array.isArray(data)) throw new Error("Unexpected response format");
    }

    // Filter by liquidity and take top N
    const filtered = data
      .filter(m => parseFloat(m.liquidityNum ?? m.liquidity ?? "0") >= minLiq)
      .sort((a, b) => parseFloat(b[orderField === "volume24hr" ? "volume24hr" : "volume"] ?? "0") - parseFloat(a[orderField === "volume24hr" ? "volume24hr" : "volume"] ?? "0"))
      .slice(0, limit);

    const markets = filtered.map(m => {
      // outcomePrices arrives as a JSON-encoded string like '["0.97","0.03"]'
      const rawPrices = m.outcomePrices ?? "[]";
      const prices    = typeof rawPrices === "string" ? JSON.parse(rawPrices) : rawPrices;
      const yesProb   = parseFloat(prices[0] ?? "0.5");
      const noProb   = parseFloat(prices[1] ?? (1 - yesProb).toFixed(4));

      return {
        question:         m.question ?? "",
        yes_probability:  Math.round(yesProb * 10000) / 10000,
        no_probability:   Math.round(noProb  * 10000) / 10000,
        volume_24h:       Math.round(parseFloat(m.volume24hr ?? "0") * 100) / 100,
        volume_total:     Math.round(parseFloat(m.volumeNum   ?? m.volume ?? "0") * 100) / 100,
        liquidity:        Math.round(parseFloat(m.liquidityNum ?? m.liquidity ?? "0") * 100) / 100,
        spread:           m.spread != null ? Math.round(parseFloat(m.spread) * 10000) / 10000 : null,
        price_change_1d:  m.oneDayPriceChange   != null ? Math.round(parseFloat(m.oneDayPriceChange)   * 10000) / 10000 : null,
        price_change_1wk: m.oneWeekPriceChange  != null ? Math.round(parseFloat(m.oneWeekPriceChange)  * 10000) / 10000 : null,
        end_date:         m.endDateIso ?? m.endDate ?? null,
        last_trade_price: m.lastTradePrice != null ? parseFloat(m.lastTradePrice) : null,
        url:              `https://polymarket.com/event/${m.slug ?? m.conditionId ?? ""}`,
      };
    });

    const totalVol24h = markets.reduce((s, m) => s + (m.volume_24h ?? 0), 0);

    return {
      markets,
      fetched_at:       new Date().toISOString(),
      total_volume_24h: Math.round(totalVol24h * 100) / 100,
    };
  },
};
