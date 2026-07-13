// strategy-signal.js
//
// Technical analysis signal for any US equity or crypto asset.
// Computes RSI(14), MACD(12/26/9), Bollinger Bands(20), and volume trend
// from public OHLCV data, then outputs a directional posture + key levels.
//
// Seam: api.minebean.com/api/strategy/decide — 32K+ sett/wk, $0.100/call
// (observed 2026-06-07 via signal-intel). This cap provides richer signal
// (RSI+MACD+BB+volume) at $0.090 — 10% undercut, from public APIs.
//
// Upstreams:
//   US equities/ETFs: Yahoo Finance v8 chart API (public, no auth)
//   Crypto (BTC/ETH/SOL/etc): CoinGecko public API v3 (free, 30 req/min)

const YF_BASE     = "https://query2.finance.yahoo.com/v8/finance/chart";
const CG_BASE     = "https://api.coingecko.com/api/v3";
const UA          = "Mozilla/5.0 (compatible; the-stall/3.24; +https://intuitek.ai)";
const TIMEOUT_MS  = 15000;

// --- Math helpers ---

function closes(bars) { return bars.map((b) => b.close); }

function rsi(prices, period = 14) {
  if (prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain  = gains  / period;
  let avgLoss  = losses / period;
  for (let i = period + 1; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    avgGain  = (avgGain  * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss  = (avgLoss  * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function ema(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let val = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) val = prices[i] * k + val * (1 - k);
  return val;
}

function macd(prices) {
  if (prices.length < 35) return null;
  const ema12 = ema(prices, 12);
  const ema26 = ema(prices, 26);
  if (ema12 === null || ema26 === null) return null;
  const line    = ema12 - ema26;
  // Signal line needs 9 more periods — approximate with last 9 MACD values
  const macds   = [];
  for (let i = prices.length - 9; i <= prices.length; i++) {
    const e12 = ema(prices.slice(0, i), 12);
    const e26 = ema(prices.slice(0, i), 26);
    if (e12 !== null && e26 !== null) macds.push(e12 - e26);
  }
  const signal = macds.length >= 9 ? ema(macds, 9) : line;
  return { line: round4(line), signal: round4(signal), histogram: round4(line - signal) };
}

function bollingerBands(prices, period = 20, mult = 2) {
  if (prices.length < period) return null;
  const slice  = prices.slice(-period);
  const mean   = slice.reduce((a, b) => a + b, 0) / period;
  const std    = Math.sqrt(slice.reduce((s, p) => s + (p - mean) ** 2, 0) / period);
  return {
    upper:  round4(mean + mult * std),
    middle: round4(mean),
    lower:  round4(mean - mult * std),
    width:  round4((mult * 2 * std) / mean),
  };
}

function round4(n) { return Math.round(n * 10000) / 10000; }

function volumeTrend(bars) {
  if (bars.length < 5) return "insufficient_data";
  const recent = bars.slice(-5).reduce((s, b) => s + b.volume, 0) / 5;
  const prior  = bars.slice(-10, -5).reduce((s, b) => s + b.volume, 0) / 5;
  if (prior === 0) return "unknown";
  const ratio  = recent / prior;
  if (ratio > 1.3) return "rising";
  if (ratio < 0.7) return "falling";
  return "stable";
}

function derivePosture(rsiVal, macdData, price, bb) {
  let score = 0;
  const signals = [];

  if (rsiVal !== null) {
    if (rsiVal > 70)      { score -= 2; signals.push("RSI overbought"); }
    else if (rsiVal < 30) { score += 2; signals.push("RSI oversold"); }
    else if (rsiVal > 55) { score += 1; signals.push("RSI bullish"); }
    else if (rsiVal < 45) { score -= 1; signals.push("RSI bearish"); }
  }

  if (macdData) {
    if (macdData.histogram > 0) { score += 1; signals.push("MACD positive"); }
    else                        { score -= 1; signals.push("MACD negative"); }
    if (macdData.line > 0)      { score += 1; signals.push("MACD above zero"); }
    else                        { score -= 1; signals.push("MACD below zero"); }
  }

  if (bb && price) {
    if (price > bb.upper)      { score -= 1; signals.push("price above upper BB"); }
    else if (price < bb.lower) { score += 1; signals.push("price below lower BB"); }
    else if (price > bb.middle){ score += 1; signals.push("price above BB midline"); }
    else                       { score -= 1; signals.push("price below BB midline"); }
  }

  const posture = score >= 3 ? "STRONG_BUY"
                : score >= 1 ? "BUY"
                : score <= -3 ? "STRONG_SELL"
                : score <= -1 ? "SELL"
                : "NEUTRAL";

  const strength = Math.min(Math.abs(score) / 5, 1.0);
  return { posture, score, strength: round4(strength), signals };
}

// --- Data fetchers ---

const CRYPTO_IDS = {
  btc: "bitcoin", eth: "ethereum", sol: "solana", bnb: "binancecoin",
  xrp: "ripple", ada: "cardano", avax: "avalanche-2", dot: "polkadot",
  doge: "dogecoin", link: "chainlink", uni: "uniswap", matic: "matic-network",
  atom: "cosmos", ltc: "litecoin", bch: "bitcoin-cash",
};

function isCrypto(symbol) {
  return symbol.toLowerCase() in CRYPTO_IDS || symbol.toUpperCase().endsWith("USD")
      || symbol.toUpperCase().endsWith("USDT") || symbol.toUpperCase().endsWith("USDC");
}

async function fetchYF(symbol) {
  const url = `${YF_BASE}/${encodeURIComponent(symbol)}?interval=1d&range=3mo`;
  const r = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`Yahoo Finance HTTP ${r.status} for ${symbol}`);
  const data = await r.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No data returned for ${symbol}`);

  const ts     = result.timestamp || [];
  const q      = result.indicators?.quote?.[0] || {};
  const closes_ = q.close || [];
  const highs   = q.high  || [];
  const lows    = q.low   || [];
  const volumes = q.volume || [];
  const opens   = q.open   || [];

  const bars = ts.map((t, i) => ({
    ts: new Date(t * 1000).toISOString().slice(0, 10),
    open:   closes_[i], close: closes_[i], high: highs[i],
    low:    lows[i],    volume: volumes[i],
  })).filter((b) => b.close != null && !isNaN(b.close));

  const meta       = result.meta || {};
  const currentPx  = meta.regularMarketPrice ?? bars[bars.length - 1]?.close;
  const name       = meta.shortName || symbol;
  const currency   = meta.currency || "USD";

  return { bars, currentPrice: currentPx, name, currency, exchange: meta.exchangeName };
}

async function fetchCG(symbol) {
  const key = symbol.toLowerCase().replace(/usd[tc]?$/, "").trim();
  const id  = CRYPTO_IDS[key] || key;
  const url = `${CG_BASE}/coins/${id}/market_chart?vs_currency=usd&days=90&interval=daily`;
  const r   = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`CoinGecko HTTP ${r.status} for ${id}`);
  const data = await r.json();
  const prices  = data.prices  || [];
  const volumes = data.total_volumes || [];

  const bars = prices.map(([ts, close], i) => ({
    ts:     new Date(ts).toISOString().slice(0, 10),
    close,
    volume: volumes[i]?.[1] ?? 0,
    open: close, high: close, low: close,
  }));

  const priceUrl = `${CG_BASE}/simple/price?ids=${id}&vs_currencies=usd`;
  const pr = await fetch(priceUrl, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(8000),
  });
  const prData = await pr.json();
  const currentPrice = prData[id]?.usd ?? bars[bars.length - 1]?.close;

  return { bars, currentPrice, name: id, currency: "USD", exchange: "crypto" };
}

// --- Main export ---

export default {
  name: "strategy-signal",
  price: "$0.110",

  description:
    "Technical analysis signal for any US stock, ETF, or crypto. Returns RSI(14), MACD(12/26/9), Bollinger Bands(20), volume trend, directional posture (STRONG_BUY/BUY/NEUTRAL/SELL/STRONG_SELL), and key price levels. Richer output than comparable services at $0.090. Free upstream: Yahoo Finance (equities), CoinGecko (crypto).",

  inputSchema: {
    type: "object",
    properties: {
      symbol: {
        type: "string",
        description: "Ticker or crypto symbol. Examples: AAPL, SPY, QQQ, BTC, ETH, SOL, NVDA.",
      },
      include_bars: {
        type: "boolean",
        description: "If true, include last 5 OHLCV bars in response. Default false.",
      },
    },
    required: [],
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      symbol:        { type: "string" },
      name:          { type: "string" },
      price:         { type: "number", description: "Current price." },
      currency:      { type: "string" },
      posture:       { type: "string", enum: ["STRONG_BUY","BUY","NEUTRAL","SELL","STRONG_SELL"] },
      strength:      { type: "number", description: "Signal strength 0–1." },
      score:         { type: "integer" },
      signals:       { type: "array",  description: "Contributing signal labels." },
      rsi:           { type: "number", description: "RSI(14)." },
      macd:          { type: "object", description: "MACD line, signal, histogram." },
      bollinger:     { type: "object", description: "Upper, middle, lower bands + width." },
      volume_trend:  { type: "string", enum: ["rising","stable","falling","unknown","insufficient_data"] },
      data_source:   { type: "string" },
      bars:          { type: "array" },
      generated_at:  { type: "string" },
    },
  },

  async handler(query) {
    const symbol  = (query.symbol || "AAPL").toUpperCase().trim();
    if (!symbol) throw new Error("'symbol' is required");

    let data;
    try {
      data = isCrypto(symbol) ? await fetchCG(symbol) : await fetchYF(symbol);
    } catch (e) {
      // Fallback: try Yahoo if CoinGecko fails
      if (isCrypto(symbol)) data = await fetchYF(symbol);
      else throw e;
    }

    const { bars, currentPrice, name, currency, exchange } = data;
    if (bars.length < 20) throw new Error(`Insufficient history for ${symbol} (${bars.length} bars)`);

    const px      = closes(bars);
    const rsiVal  = rsi(px);
    const macdVal = macd(px);
    const bbVal   = bollingerBands(px);
    const volTrend = volumeTrend(bars);

    const { posture, score, strength, signals } = derivePosture(rsiVal, macdVal, currentPrice, bbVal);

    const out = {
      symbol,
      name,
      price:        currentPrice != null ? round4(currentPrice) : null,
      currency,
      posture,
      strength,
      score,
      signals,
      rsi:          rsiVal !== null ? round4(rsiVal) : null,
      macd:         macdVal,
      bollinger:    bbVal,
      volume_trend: volTrend,
      data_source:  exchange === "crypto" ? "coingecko" : "yahoo_finance",
      generated_at: new Date().toISOString(),
    };

    if (query.include_bars) {
      out.bars = bars.slice(-5);
    }

    return out;
  },
};
