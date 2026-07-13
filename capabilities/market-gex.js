// Market Gamma Exposure (GEX) — SPY or any US equity
//
// Computes dealer gamma exposure at each strike using free CBOE delayed options data.
// GEX > 0 → dealers net long gamma → price-pinning, suppressed volatility.
// GEX < 0 → dealers net short gamma → price-acceleration, vol expansion.
// Gamma flip level = the strike where net dealer GEX crosses zero.
//
// Free upstream: cdn.cboe.com — no API key, 15-min delay during trading hours.

const CBOE_BASE = "https://cdn.cboe.com/api/global/delayed_quotes/options";
const UA        = "Mozilla/5.0 (compatible; the-stall/3.88; +https://intuitek.ai)";
const TIMEOUT   = 15000;

export default {
  name: "market-gex",
  price: "$0.040",
  description:
    "Dealer gamma exposure (GEX) analysis for any US stock or ETF — returns aggregate GEX, gamma flip level, key pinning strikes, and vol regime signal (positive GEX = pinning, negative = acceleration). Free CBOE delayed data, no API key. Standard SpotGamma-style calculation: calls subtract gamma, puts add gamma. Use with options-snapshot for full options context.",

  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type:        "string",
        description: "US equity or ETF ticker (e.g. SPY, QQQ, AAPL, NVDA). Case-insensitive.",
      },
      days_out: {
        type:        "integer",
        minimum:     0,
        maximum:     90,
        description: "Include only options expiring within this many calendar days. Default: 45 (captures standard monthly + weekly expiries).",
      },
      top_n: {
        type:        "integer",
        minimum:     3,
        maximum:     20,
        description: "Number of top positive and negative GEX strikes to return. Default: 10.",
      },
    },
    required: [],
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      ticker:            { type: "string" },
      spot:              { type: "number",  description: "Current underlying price." },
      total_gex:         { type: "number",  description: "Aggregate dealer gamma exposure in USD. Positive = net long gamma; negative = net short gamma." },
      call_gex:          { type: "number",  description: "Total call-side GEX contribution." },
      put_gex:           { type: "number",  description: "Total put-side GEX contribution." },
      gamma_flip:        { type: ["number","null"],  description: "Strike where net GEX crosses zero (gamma flip level). Null if no crossing found." },
      vol_regime:        { type: "string",  description: "Volatility regime: 'pinned' (GEX > 0), 'acceleration' (GEX < 0), or 'neutral'." },
      key_strikes:       { type: "array",   description: "Top strikes by absolute GEX (both positive and negative), sorted by abs GEX descending." },
      positive_gex_wall: { type: ["number","null"], description: "Highest aggregate positive-GEX strike — acts as upside resistance/pin." },
      negative_gex_wall: { type: ["number","null"], description: "Lowest aggregate negative-GEX strike — acts as downside acceleration level." },
      options_count:     { type: "integer", description: "Number of options included in the analysis." },
      expiry_range:      { type: "string",  description: "Date range of expiries included." },
      data_delay_min:    { type: "integer" },
      ts:                { type: "string"  },
    },
  },

  async handler({ ticker = "SPY", days_out = 45, top_n = 10 }) {
    ticker = ticker.toUpperCase().trim();

    const url  = `${CBOE_BASE}/${encodeURIComponent(ticker)}.json`;
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), TIMEOUT);
    let raw;
    try {
      const res = await fetch(url, {
        signal:  ctrl.signal,
        headers: { "User-Agent": UA },
      });
      if (!res.ok) throw new Error(`CBOE ${res.status}: ${ticker}`);
      raw = await res.json();
    } finally {
      clearTimeout(tid);
    }

    const data    = raw.data || {};
    const spot    = data.current_price || 0;
    const options = data.options || [];

    if (!spot) throw new Error(`No price data for ${ticker}`);

    const tickerLen  = ticker.length;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() + days_out);
    // Build 6-digit YYMMDD for comparison with expiryRaw
    const cy = String(cutoffDate.getFullYear()).slice(2);
    const cm = String(cutoffDate.getMonth() + 1).padStart(2, "0");
    const cd = String(cutoffDate.getDate()).padStart(2, "0");
    const cutoffStr  = `${cy}${cm}${cd}`; // YYMMDD, e.g. "260710"

    // Parse and filter options
    let minExpiry = "999999", maxExpiry = "000000";
    const parsed = [];
    for (const o of options) {
      const sym = o.option || "";
      if (sym.length < tickerLen + 15) continue;

      const expiryRaw = sym.slice(tickerLen, tickerLen + 6); // YYMMDD
      const expiry    = `20${expiryRaw.slice(0,2)}-${expiryRaw.slice(2,4)}-${expiryRaw.slice(4,6)}`;
      if (expiryRaw > cutoffStr) continue;

      const type   = sym[tickerLen + 6] === "C" ? "call" : "put";
      const strike = parseInt(sym.slice(tickerLen + 7), 10) / 1000;

      const gamma = o.gamma != null ? parseFloat(o.gamma) : 0;
      const oi    = parseFloat(o.open_interest) || 0;
      if (!gamma || !oi || strike <= 0) continue;

      // Dealer GEX convention (SpotGamma):
      //   calls: dealers short → negative gamma → gex = -(gamma × OI × 100 × spot)
      //   puts:  dealers long  → positive gamma → gex = +(gamma × OI × 100 × spot)
      const gexContrib = type === "call"
        ? -(gamma * oi * 100 * spot)
        : +(gamma * oi * 100 * spot);

      parsed.push({ sym, type, strike, expiry, gamma, oi, gexContrib });
      if (expiryRaw < minExpiry) minExpiry = expiryRaw;
      if (expiryRaw > maxExpiry) maxExpiry = expiryRaw;
    }

    if (!parsed.length) throw new Error(`No usable options data for ${ticker} within ${days_out} days`);

    // Aggregate GEX by strike
    const byStrike = new Map();
    let totalCallGex = 0, totalPutGex = 0;
    for (const p of parsed) {
      if (!byStrike.has(p.strike)) byStrike.set(p.strike, { strike: p.strike, gex: 0, call_gex: 0, put_gex: 0, oi: 0 });
      const s = byStrike.get(p.strike);
      s.gex      += p.gexContrib;
      s.oi       += p.oi;
      if (p.type === "call") s.call_gex += p.gexContrib;
      else                   s.put_gex  += p.gexContrib;
      if (p.type === "call") totalCallGex += p.gexContrib;
      else                   totalPutGex  += p.gexContrib;
    }

    const strikes    = Array.from(byStrike.values()).sort((a, b) => a.strike - b.strike);
    const totalGex   = totalCallGex + totalPutGex;

    // Find gamma flip level: where cumulative GEX crosses zero
    // Use the strike where net GEX changes sign
    let gammaFlip = null;
    const strikesSorted = strikes.map(s => s.strike);
    // Running sum from lowest strike upward; find crossing near spot
    const nearSpot = strikes.filter(s => Math.abs(s.strike - spot) / spot < 0.20);
    if (nearSpot.length > 1) {
      for (let i = 0; i < nearSpot.length - 1; i++) {
        const a = nearSpot[i];
        const b = nearSpot[i + 1];
        if ((a.gex >= 0 && b.gex < 0) || (a.gex < 0 && b.gex >= 0)) {
          // Linear interpolation
          gammaFlip = parseFloat((a.strike + (b.strike - a.strike) * Math.abs(a.gex) / (Math.abs(a.gex) + Math.abs(b.gex))).toFixed(2));
          break;
        }
      }
    }

    // Key strikes by absolute GEX
    const keyStrikes = strikes
      .sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex))
      .slice(0, top_n)
      .map(s => ({
        strike:   s.strike,
        gex:      parseFloat(s.gex.toFixed(0)),
        call_gex: parseFloat(s.call_gex.toFixed(0)),
        put_gex:  parseFloat(s.put_gex.toFixed(0)),
        oi:       Math.round(s.oi),
        side:     s.gex > 0 ? "positive" : "negative",
      }))
      .sort((a, b) => a.strike - b.strike);

    // GEX walls
    const posStrikes = strikes.filter(s => s.gex > 0).sort((a, b) => b.gex - a.gex);
    const negStrikes = strikes.filter(s => s.gex < 0).sort((a, b) => a.gex - b.gex);
    const posWall    = posStrikes.length ? posStrikes[0].strike : null;
    const negWall    = negStrikes.length ? negStrikes[0].strike : null;

    const volRegime = totalGex > 500000
      ? "pinned"
      : totalGex < -500000
        ? "acceleration"
        : "neutral";

    const fmt6 = d => {
      const y = d.slice(0, 2), m = d.slice(2, 4), dd = d.slice(4, 6);
      return `20${y}-${m}-${dd}`;
    };

    return {
      ticker,
      spot,
      total_gex:         parseFloat(totalGex.toFixed(0)),
      call_gex:          parseFloat(totalCallGex.toFixed(0)),
      put_gex:           parseFloat(totalPutGex.toFixed(0)),
      gamma_flip:        gammaFlip,
      vol_regime:        volRegime,
      key_strikes:       keyStrikes,
      positive_gex_wall: posWall,
      negative_gex_wall: negWall,
      options_count:     parsed.length,
      expiry_range:      minExpiry === "999999" ? "none" : `${fmt6(minExpiry)} → ${fmt6(maxExpiry)}`,
      data_delay_min:    15,
      ts:                new Date().toISOString(),
    };
  },
};
