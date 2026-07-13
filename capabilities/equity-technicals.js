// equity-technicals.js
//
// Returns standard technical analysis indicators for any US equity:
// RSI(14), MACD(12/26/9), Bollinger Bands(20,2σ), SMAs(20/50/200),
// 20-day volume ratio, price position vs bands, and a consensus signal.
//
// Competes with stocktrends.com ($0.578/call observed, proprietary
// classification) at $0.49 using standard open-methodology TA.
// signal-intel: stocktrends resource $0.578 avg, 108 calls, 1 payer observed.
// Seam context: stocktrends appears downstream in agent equity-research flows.
//
// Free upstream: Yahoo Finance v8/finance/chart (1yr daily OHLCV, no auth).

const YF_BASE = "https://query2.finance.yahoo.com/v8/finance/chart";
const UA = "Mozilla/5.0 (compatible; the-stall/0.9; +https://intuitek.ai)";

function sma(arr, period) {
  const s = arr.slice(-period);
  return Math.round(s.reduce((a, b) => a + b, 0) / s.length * 10000) / 10000;
}

function ema(arr, period) {
  const k = 2 / (period + 1);
  let e = arr[0];
  for (let i = 1; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

function emaFull(arr, period) {
  const k = 2 / (period + 1);
  const out = [arr[0]];
  for (let i = 1; i < arr.length; i++) out.push(arr[i] * k + out[i - 1] * (1 - k));
  return out;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const avgG = gains / period;
  const avgL = losses / period;
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

function macd(closes) {
  if (closes.length < 35) return null;
  const e12 = emaFull(closes, 12);
  const e26 = emaFull(closes, 26);
  const macdLine = e12.map((v, i) => v - e26[i]);
  const sigLine = emaFull(macdLine.slice(25), 9);
  const last = macdLine[macdLine.length - 1];
  const lastSig = sigLine[sigLine.length - 1];
  return {
    macd:      Math.round(last * 10000) / 10000,
    signal:    Math.round(lastSig * 10000) / 10000,
    histogram: Math.round((last - lastSig) * 10000) / 10000,
  };
}

function bollingerBands(closes, period = 20, k = 2) {
  if (closes.length < period) return null;
  const sl = closes.slice(-period);
  const mid = sl.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(sl.reduce((a, b) => a + (b - mid) ** 2, 0) / period);
  return {
    upper:  Math.round((mid + k * std) * 100) / 100,
    middle: Math.round(mid * 100) / 100,
    lower:  Math.round((mid - k * std) * 100) / 100,
  };
}

function consensusSignal(price, rsiVal, macdData, bb) {
  let bullish = 0, bearish = 0;
  if (rsiVal !== null) {
    if (rsiVal < 30) bullish += 2;
    else if (rsiVal > 70) bearish += 2;
    else if (rsiVal < 45) bullish += 1;
    else if (rsiVal > 55) bearish += 1;
  }
  if (macdData) {
    if (macdData.histogram > 0 && macdData.macd > macdData.signal) bullish += 1;
    else if (macdData.histogram < 0 && macdData.macd < macdData.signal) bearish += 1;
  }
  if (bb) {
    if (price < bb.lower) bullish += 2;
    else if (price > bb.upper) bearish += 2;
  }
  if (bullish > bearish + 1) return "BULLISH";
  if (bearish > bullish + 1) return "BEARISH";
  return "NEUTRAL";
}

export default {
  name: "equity-technicals",
  price: "$0.420",

  description:
    "Returns a complete technical analysis package for any US stock: RSI(14) with oversold/overbought signal, MACD(12/26/9) with histogram, Bollinger Bands(20,2σ) with price position, SMA 20/50/200 with crossover state, 20-day volume ratio, and a consensus signal (BULLISH/BEARISH/NEUTRAL) based on indicator agreement. Sourced from 1-year Yahoo Finance daily OHLCV — no API key, live data. Richer than a simple price endpoint: agents use this for entry/exit signal confirmation, momentum screening, and pre-trade context without managing their own TA library.",

  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description: "US stock ticker symbol (e.g. AMD, AAPL, NVDA, STRC). Case-insensitive.",
      },
    },
    required: [],
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      ticker:          { type: "string",  description: "Canonical ticker." },
      price_usd:       { type: "number",  description: "Current market price." },
      change_pct:      { type: "number",  description: "% change from prior close." },
      rsi_14: {
        type: "object",
        description: "RSI(14) indicator.",
        properties: {
          value:  { type: "number", description: "RSI value 0–100." },
          signal: { type: "string", enum: ["OVERSOLD","NEUTRAL","OVERBOUGHT"], description: "RSI zone." },
        },
      },
      macd_12_26_9: {
        type: ["object", "null"],
        description: "MACD(12,26,9). Null if insufficient history.",
        properties: {
          macd:      { type: "number", description: "MACD line." },
          signal:    { type: "number", description: "Signal line (9-period EMA of MACD)." },
          histogram: { type: "number", description: "MACD - signal. Positive = bullish momentum." },
          crossover: { type: "string", enum: ["BULLISH_CROSS","BEARISH_CROSS","NO_CROSS"], description: "Latest crossover state." },
        },
      },
      bollinger_20: {
        type: ["object", "null"],
        description: "Bollinger Bands(20, 2σ).",
        properties: {
          upper:    { type: "number" },
          middle:   { type: "number" },
          lower:    { type: "number" },
          position: { type: "string", enum: ["ABOVE_UPPER","UPPER_HALF","LOWER_HALF","BELOW_LOWER"], description: "Price position relative to bands." },
        },
      },
      sma: {
        type: "object",
        description: "Simple moving averages.",
        properties: {
          sma_20:  { type: "number" },
          sma_50:  { type: "number" },
          sma_200: { type: ["number","null"], description: "Null if < 200 data points." },
          above_20:  { type: "boolean" },
          above_50:  { type: "boolean" },
          above_200: { type: ["boolean","null"] },
          golden_cross: { type: "boolean", description: "SMA50 > SMA200 (long-term bullish alignment)." },
        },
      },
      volume_ratio_20d: {
        type: "number",
        description: "Today's volume divided by 20-day average. > 1.5 = high-volume move.",
      },
      consensus: {
        type: "string",
        enum: ["BULLISH", "BEARISH", "NEUTRAL"],
        description: "Indicator consensus: BULLISH if majority of RSI/MACD/BB signals align upward.",
      },
      data_points: { type: "integer", description: "Number of daily bars used for calculation." },
      ts:          { type: "string",  description: "ISO-8601 response timestamp." },
    },
  },

  async handler(query) {
    const ticker = (query.ticker || "AAPL").trim().toUpperCase();
    if (!ticker || !/^[A-Z0-9.\-^=]{1,12}$/.test(ticker)) {
      throw new Error("ticker must be 1–12 uppercase alphanumeric characters");
    }

    const url = `${YF_BASE}/${encodeURIComponent(ticker)}?range=1y&interval=1d`;
    const resp = await fetch(url, {
      headers: { "User-Agent": UA },
      signal:  AbortSignal.timeout(15_000),
    });
    if (!resp.ok) throw new Error(`Yahoo Finance HTTP ${resp.status} for ${ticker}`);

    const d = await resp.json();
    const result = d?.chart?.result?.[0];
    if (!result) {
      const err = d?.chart?.error;
      throw new Error(err ? `${err.code}: ${err.description}` : `no data returned for ${ticker}`);
    }

    const meta      = result.meta;
    const closes    = result.indicators.quote[0].close.filter(v => v !== null);
    const volumes   = result.indicators.quote[0].volume.filter(v => v !== null);

    if (closes.length < 20) throw new Error(`insufficient history (${closes.length} bars) for ${ticker}`);

    const price     = meta.regularMarketPrice ?? closes[closes.length - 1];
    const prevClose = closes[closes.length - 2];
    const changePct = prevClose ? Math.round((price - prevClose) / prevClose * 10000) / 100 : 0;

    const rsiVal  = rsi(closes);
    const macdVal = macd(closes);
    const bb      = bollingerBands(closes);

    const sma20  = sma(closes, 20);
    const sma50  = closes.length >= 50  ? sma(closes, 50)  : null;
    const sma200 = closes.length >= 200 ? sma(closes, 200) : null;

    const vol20avg = volumes.length >= 20
      ? volumes.slice(-20).reduce((a, b) => a + b, 0) / 20
      : null;
    const todayVol = volumes[volumes.length - 1] ?? 0;
    const volRatio = vol20avg ? Math.round((todayVol / vol20avg) * 100) / 100 : null;

    let rsiSignal;
    if (rsiVal === null)        rsiSignal = "NEUTRAL";
    else if (rsiVal < 30)      rsiSignal = "OVERSOLD";
    else if (rsiVal > 70)      rsiSignal = "OVERBOUGHT";
    else                       rsiSignal = "NEUTRAL";

    let macdCrossover = "NO_CROSS";
    if (macdVal) {
      if (macdVal.histogram > 0 && macdVal.macd > 0) macdCrossover = "BULLISH_CROSS";
      else if (macdVal.histogram < 0 && macdVal.macd < 0) macdCrossover = "BEARISH_CROSS";
    }

    let bbPosition = null;
    if (bb) {
      const range = bb.upper - bb.lower;
      if (price > bb.upper)                bbPosition = "ABOVE_UPPER";
      else if (price > bb.middle)          bbPosition = "UPPER_HALF";
      else if (price >= bb.lower)          bbPosition = "LOWER_HALF";
      else                                 bbPosition = "BELOW_LOWER";
    }

    const goldenCross = sma50 !== null && sma200 !== null ? sma50 > sma200 : false;

    return {
      ticker,
      price_usd:  Math.round(price * 100) / 100,
      change_pct: changePct,
      rsi_14: rsiVal !== null ? { value: rsiVal, signal: rsiSignal } : null,
      macd_12_26_9: macdVal ? { ...macdVal, crossover: macdCrossover } : null,
      bollinger_20: bb ? { ...bb, position: bbPosition } : null,
      sma: {
        sma_20:       sma20,
        sma_50:       sma50,
        sma_200:      sma200,
        above_20:     price > sma20,
        above_50:     sma50 !== null ? price > sma50 : null,
        above_200:    sma200 !== null ? price > sma200 : null,
        golden_cross: goldenCross,
      },
      volume_ratio_20d: volRatio,
      consensus: consensusSignal(price, rsiVal, macdVal, bb),
      data_points: closes.length,
      ts: new Date().toISOString(),
    };
  },
};
