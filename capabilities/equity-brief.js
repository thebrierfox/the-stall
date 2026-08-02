// equity-brief.js
//
// AI-synthesized equity situation brief for any US stock.
//
// Gathers four signal layers from free public APIs in parallel, then uses
// gpt-4o-mini to synthesize a structured actionable brief. One call replaces
// the agent chain: us-stock-price + equity-technicals + insider-trades +
// options-snapshot + earnings-calendar — collapsed at $0.350, below the
// summed cost of separate calls and manual synthesis.
//
// Signal layers assembled:
//   1. Price context   — current price, intraday change, 52w high/low (Yahoo Finance v8)
//   2. Technicals      — RSI(14), SMA20/50/200, trend regime (1yr OHLCV, Yahoo Finance)
//   3. Insider signal  — net buy/sell last 60 days via SEC EDGAR Form 4 (free, no auth)
//   4. Options context — IV30 + put/call ratio via CBOE delayed quotes (free, when available)
//   5. Earnings date   — next expected report + consensus EPS (Yahoo Finance quoteSummary)
//
// Seam: equity-research agents currently chain equity-technicals + us-stock-price
// + insider-trades + options-snapshot — observed pattern in signal-intel.
// This cap collapses that 4-call workflow into one AI-synthesized output at $0.350.
//
// Upstreams: Yahoo Finance public chart/quoteSummary APIs (free, no auth),
//            SEC EDGAR company_tickers + submissions + Archives (free, no auth),
//            CBOE delayed options quotes (free, no auth),
//            gpt-4o-mini via OPENAI_API_KEY.

const YF_CHART   = "https://query2.finance.yahoo.com/v8/finance/chart";
const YF_SUMMARY = "https://query2.finance.yahoo.com/v10/finance/quoteSummary";
const CBOE_BASE  = "https://cdn.cboe.com/api/global/delayed_quotes/options";
const SEC_MAP    = "https://www.sec.gov/files/company_tickers.json";
const SEC_SUBS   = "https://data.sec.gov/submissions/CIK";
const SEC_ARCH   = "https://www.sec.gov/Archives/edgar/data";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL      = "gpt-4o-mini";

const YF_UA  = "Mozilla/5.0 (compatible; the-stall/3.94; +https://intuitek.ai)";
const SEC_UA = "the-stall/3.94 equity-brief (kyle@intuitek.ai)";
const CHART_TMO   = 12_000;
const SEC_TMO     = 12_000;
const CBOE_TMO    = 10_000;
const GPT_TMO     = 30_000;

// ─── Shared in-process caches ────────────────────────────────────────────────
let _tickerMap = null;
let _tickerMapTs = 0;
const CACHE_TTL = 6 * 60 * 60 * 1000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function r2(n) { return Math.round(n * 100) / 100; }
function r4(n) { return Math.round(n * 10000) / 10000; }

async function fetchJson(url, headers = {}) {
  const r = await fetch(url, {
    headers: { "User-Agent": YF_UA, Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(CHART_TMO),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.json();
}

// ─── Price + OHLCV (Yahoo Finance v8 chart, 1yr daily) ───────────────────────

async function fetchPriceAndHistory(ticker) {
  const url = `${YF_CHART}/${encodeURIComponent(ticker)}?interval=1d&range=1y`;
  const data = await fetchJson(url);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No chart data for ${ticker}`);

  const meta    = result.meta || {};
  const closes  = (result.indicators?.quote?.[0]?.close || []).filter(v => v != null);
  const volumes = (result.indicators?.quote?.[0]?.volume || []).filter(v => v != null);

  if (closes.length < 20) throw new Error(`Insufficient history for ${ticker}`);

  return {
    ticker:        meta.symbol || ticker,
    price:         r2(meta.regularMarketPrice || closes[closes.length - 1]),
    prev_close:    r2(meta.chartPreviousClose || meta.previousClose || 0),
    change_pct:    r2(((meta.regularMarketPrice - (meta.chartPreviousClose || meta.previousClose)) /
                       (meta.chartPreviousClose || meta.previousClose)) * 100 || 0),
    volume:        meta.regularMarketVolume || volumes[volumes.length - 1] || 0,
    high_52w:      r2(meta["52WeekHigh"] || Math.max(...closes)),
    low_52w:       r2(meta["52WeekLow"]  || Math.min(...closes)),
    currency:      meta.currency || "USD",
    market_state:  meta.marketState || "unknown",
    closes,
  };
}

// ─── Technical indicators ─────────────────────────────────────────────────────

function sma(arr, n) {
  if (arr.length < n) return null;
  const sl = arr.slice(-n);
  return r4(sl.reduce((a, b) => a + b, 0) / sl.length);
}

function rsi14(closes) {
  if (closes.length < 15) return null;
  const slice = closes.slice(-15);
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i] - slice[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const avgGain = gains / 14;
  const avgLoss = losses / 14;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return r2(100 - 100 / (1 + rs));
}

function computeTechnicals(priceData) {
  const { closes, price } = priceData;
  const rsi  = rsi14(closes);
  const s20  = sma(closes, 20);
  const s50  = sma(closes, 50);
  const s200 = sma(closes, 200);

  const above20  = s20  != null && price > s20;
  const above50  = s50  != null && price > s50;
  const above200 = s200 != null && price > s200;

  let trend_regime = "unknown";
  if (above20 && above50 && above200)       trend_regime = "strong_uptrend";
  else if (above50 && above200)             trend_regime = "uptrend";
  else if (!above50 && !above200)           trend_regime = "downtrend";
  else if (above200 && !above50)            trend_regime = "correction_in_uptrend";
  else                                      trend_regime = "mixed";

  const rsi_signal = rsi == null ? "unknown" :
                     rsi < 30 ? "oversold" : rsi > 70 ? "overbought" : "neutral";

  return {
    rsi14: rsi,
    rsi_signal,
    sma20: s20,
    sma50: s50,
    sma200: s200,
    price_vs_sma20_pct: s20 ? r2(((price - s20) / s20) * 100) : null,
    price_vs_sma50_pct: s50 ? r2(((price - s50) / s50) * 100) : null,
    price_vs_sma200_pct: s200 ? r2(((price - s200) / s200) * 100) : null,
    trend_regime,
  };
}

// ─── Insider trades (SEC EDGAR, last 60 days) ────────────────────────────────

async function fetchInsiderSummary(ticker) {
  try {
    // Step 1: CIK lookup with in-process cache
    const now = Date.now();
    if (!_tickerMap || now - _tickerMapTs > CACHE_TTL) {
      const r = await fetch(SEC_MAP, {
        headers: { "User-Agent": SEC_UA },
        signal: AbortSignal.timeout(SEC_TMO),
      });
      if (!r.ok) return null;
      const raw = await r.json();
      _tickerMap = {};
      for (const v of Object.values(raw)) {
        _tickerMap[v.ticker.toUpperCase()] = String(v.cik_str).padStart(10, "0");
      }
      _tickerMapTs = now;
    }

    const cik = _tickerMap[ticker.toUpperCase()];
    if (!cik) return { error: "ticker not in SEC registry" };

    // Step 2: Recent Form 4 filings
    const subs = await fetch(`${SEC_SUBS}${cik}.json`, {
      headers: { "User-Agent": SEC_UA },
      signal: AbortSignal.timeout(SEC_TMO),
    });
    if (!subs.ok) return null;
    const subData = await subs.json();

    const recent = subData.filings?.recent;
    if (!recent) return null;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 60);
    const cutoffStr = cutoff.toISOString().split("T")[0];

    const form4Filings = [];
    for (let i = 0; i < recent.form.length; i++) {
      if ((recent.form[i] === "4" || recent.form[i] === "4/A") &&
          recent.filingDate[i] >= cutoffStr) {
        form4Filings.push({
          acc: recent.accessionNumber[i].replace(/-/g, ""),
          doc: recent.primaryDocument[i],
          date: recent.filingDate[i],
        });
      }
    }

    if (form4Filings.length === 0) return { buy_count: 0, sell_count: 0, net_signal: "no_activity", filings_checked: 0 };

    // Step 3: Parse top 8 Form 4 XMLs for buy/sell codes
    let buys = 0, sells = 0, awards = 0;
    const toCheck = form4Filings.slice(0, 8);

    await Promise.allSettled(toCheck.map(async (f) => {
      try {
        const xmlUrl = `${SEC_ARCH}/${parseInt(cik, 10)}/${f.acc}/${f.doc}`;
        const r = await fetch(xmlUrl, {
          headers: { "User-Agent": SEC_UA },
          signal: AbortSignal.timeout(SEC_TMO),
        });
        if (!r.ok) return;
        const xml = await r.text();
        const codeMatches = xml.matchAll(/<transactionCode>([\s\S]*?)<\/transactionCode>/g);
        for (const m of codeMatches) {
          const code = m[1].trim();
          if (code === "P") buys++;
          else if (code === "S") sells++;
          else if (code === "A") awards++;
        }
      } catch { /* skip malformed */ }
    }));

    const net_signal = buys > sells * 2 ? "strong_buy" :
                       buys > sells     ? "mild_buy"   :
                       sells > buys * 2 ? "strong_sell" :
                       sells > buys     ? "mild_sell"   :
                       "neutral";

    return { buy_count: buys, sell_count: sells, award_count: awards, net_signal, filings_checked: toCheck.length };
  } catch {
    return null;
  }
}

// ─── Options IV30 + P/C ratio (CBOE delayed) ─────────────────────────────────

async function fetchOptionsContext(ticker) {
  try {
    const url = `${CBOE_BASE}/${ticker.toUpperCase()}.json`;
    const r = await fetch(url, {
      headers: { "User-Agent": YF_UA },
      signal: AbortSignal.timeout(CBOE_TMO),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const snap = data?.data?.options?.[0];
    const iv30  = data?.data?.current_price_iv30_rv30;
    if (!snap && iv30 == null) return null;

    // Compute aggregate P/C ratio from options data
    let callVol = 0, putVol = 0;
    const opts = data?.data?.options || [];
    for (const expiry of opts) {
      for (const opt of (expiry.calls || [])) callVol += (opt.volume || 0);
      for (const opt of (expiry.puts  || [])) putVol  += (opt.volume || 0);
    }

    return {
      iv30:     iv30 != null ? r2(iv30) : null,
      pc_ratio: callVol > 0 ? r2(putVol / callVol) : null,
      sentiment: (callVol > 0 && putVol / callVol > 1.2) ? "bearish_hedging" :
                 (callVol > 0 && putVol / callVol < 0.7) ? "bullish_speculation" : "balanced",
    };
  } catch {
    return null;
  }
}

// ─── Earnings date + EPS (Yahoo Finance quoteSummary) ────────────────────────

async function fetchEarningsContext(ticker) {
  try {
    const url = `${YF_SUMMARY}/${encodeURIComponent(ticker)}?modules=calendarEvents,defaultKeyStatistics`;
    const data = await fetchJson(url);
    const cal    = data?.quoteSummary?.result?.[0]?.calendarEvents;
    const stats  = data?.quoteSummary?.result?.[0]?.defaultKeyStatistics;
    if (!cal) return null;

    const earningsDates = cal.earnings?.earningsDate || [];
    const nextEarnings  = earningsDates.length > 0
      ? new Date(earningsDates[0].raw * 1000).toISOString().split("T")[0]
      : null;

    const epsEst = cal.earnings?.earningsAverage?.raw ?? null;
    const fwdPE  = stats?.forwardPE?.raw ?? null;
    const beta   = stats?.beta?.raw ?? null;

    const today = new Date();
    const daysToEarnings = nextEarnings
      ? Math.ceil((new Date(nextEarnings) - today) / 86400000)
      : null;

    return {
      next_earnings: nextEarnings,
      days_to_earnings: daysToEarnings,
      eps_estimate: epsEst != null ? r2(epsEst) : null,
      forward_pe: fwdPE != null ? r2(fwdPE) : null,
      beta: beta != null ? r2(beta) : null,
    };
  } catch {
    return null;
  }
}

// ─── GPT-4o-mini synthesis ───────────────────────────────────────────────────

async function synthesize(ticker, price, technicals, insider, options, earnings, style) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const lines = [
    `Ticker: ${ticker} | Price: $${price.price} | Change today: ${price.change_pct}% | 52w high: $${price.high_52w} | 52w low: $${price.low_52w}`,
    `Trend regime: ${technicals.trend_regime} | RSI-14: ${technicals.rsi14 ?? "N/A"} (${technicals.rsi_signal})`,
    `vs SMA20: ${technicals.price_vs_sma20_pct ?? "N/A"}% | vs SMA50: ${technicals.price_vs_sma50_pct ?? "N/A"}% | vs SMA200: ${technicals.price_vs_sma200_pct ?? "N/A"}%`,
    insider
      ? `Insider activity (60d): ${insider.buy_count} buys, ${insider.sell_count} sells — ${insider.net_signal}`
      : "Insider activity: not available",
    options
      ? `Options context: IV30=${options.iv30 ?? "N/A"} | P/C ratio=${options.pc_ratio ?? "N/A"} | sentiment=${options.sentiment}`
      : "Options context: not available for this ticker",
    earnings
      ? `Next earnings: ${earnings.next_earnings ?? "unknown"} (${earnings.days_to_earnings ?? "?"} days) | EPS est: ${earnings.eps_estimate != null ? "$" + earnings.eps_estimate : "N/A"} | Fwd P/E: ${earnings.forward_pe ?? "N/A"} | Beta: ${earnings.beta ?? "N/A"}`
      : "Earnings context: not available",
  ];

  const toneClause = style === "concise"
    ? "Be concise — narrative should be 80–110 words."
    : "Write clearly — narrative should be 150–190 words.";

  const prompt = `You are a quantitative equity analyst writing a situation brief for an AI trading agent. Synthesize the signal data below into a structured, actionable assessment.

SIGNAL DATA (${new Date().toISOString().split("T")[0]}):
${lines.join("\n")}

${toneClause} Focus on: (1) what the combined signals say about the current setup, (2) the single most important risk, and (3) one concrete implication for agent decision-making.

Write in direct professional prose. Do not use bullet points. Do not start with "Based on". Do not repeat all raw numbers.

Respond ONLY with a JSON object (no markdown, no text outside JSON):
{
  "regime_label": "momentum" | "consolidation" | "breakdown" | "reversal_watch" | "distribution" | "accumulation" | "overbought_extension" | "oversold_bounce",
  "signal_summary": "one sentence: core equity setup",
  "bull_case": "one sentence",
  "bear_case": "one sentence",
  "dominant_risk": "one sentence: single biggest risk",
  "agent_implication": "one sentence: concrete action relevance for AI agents",
  "narrative": "the full brief paragraph",
  "confidence": 0.0 to 1.0
}`;

  const resp = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(GPT_TMO),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI ${resp.status}: ${err.slice(0, 120)}`);
  }

  const data = await resp.json();
  const raw  = data.choices?.[0]?.message?.content || "";
  const clean = raw.replace(/```json\n?|\n?```/g, "").trim();
  return JSON.parse(clean);
}

// ─── Export ───────────────────────────────────────────────────────────────────

export default {
  name: "equity-brief",
  price: "$0.370",
  tags: ["equity-research", "stocks", "analysis", "evidence"],

  description:
    "AI-synthesized equity situation brief for any US stock. Gathers five signal layers in parallel — current price/52w range, RSI-14 + SMA20/50/200 trend regime, insider buy/sell activity (SEC EDGAR Form 4, last 60 days), options IV30 + put/call ratio (CBOE), and next earnings date + EPS estimate (Yahoo Finance) — then uses GPT-4o-mini to produce a structured brief: regime label, bull/bear case, dominant risk, agent implication, and a 160-word narrative. Replaces a 4-call agent chain (equity-technicals + us-stock-price + insider-trades + options-snapshot) at $0.350. Free upstreams (no API keys required for data gathering).",

  inputSchema: {
    type: "object",
    required: [],
    properties: {
      ticker: {
        type: "string",
        description: "US stock ticker symbol (e.g. AAPL, MSFT, NVDA, TSLA). Case-insensitive.",
      },
      style: {
        type: "string",
        enum: ["standard", "concise"],
        description: "'standard' = 160-word narrative (default). 'concise' = 90-word summary.",
      },
    },
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      ticker:            { type: "string"  },
      regime_label:      { type: "string", description: "momentum | consolidation | breakdown | reversal_watch | distribution | accumulation | overbought_extension | oversold_bounce" },
      signal_summary:    { type: "string", description: "One-sentence core equity setup." },
      bull_case:         { type: "string" },
      bear_case:         { type: "string" },
      dominant_risk:     { type: "string" },
      agent_implication: { type: "string", description: "Concrete action relevance for AI agents." },
      narrative:         { type: "string", description: "Full situational brief." },
      confidence:        { type: "number" },
      signals: {
        type: "object",
        description: "Raw signal data used in synthesis.",
        properties: {
          price:           { type: "number" },
          change_pct:      { type: "number" },
          high_52w:        { type: "number" },
          low_52w:         { type: "number" },
          rsi14:           { type: "number" },
          rsi_signal:      { type: "string" },
          trend_regime:    { type: "string" },
          sma20:           { type: "number" },
          sma50:           { type: "number" },
          sma200:          { type: "number" },
          insider_net:     { type: "string" },
          insider_buys:    { type: "number" },
          insider_sells:   { type: "number" },
          iv30:            { type: "number" },
          pc_ratio:        { type: "number" },
          options_sentiment: { type: "string" },
          next_earnings:   { type: "string" },
          days_to_earnings: { type: "number" },
          eps_estimate:    { type: "number" },
          forward_pe:      { type: "number" },
        },
      },
      generated_at: { type: "string" },
    },
  },

  async handler(query) {
    const ticker = (query.ticker || "AAPL").toUpperCase().trim();
    if (!ticker) throw new Error("ticker is required");
    const style = query.style || "standard";

    // Gather all signals in parallel — wall time = slowest upstream
    const [priceData, insiderRaw, optionsRaw, earningsRaw] = await Promise.all([
      fetchPriceAndHistory(ticker),
      fetchInsiderSummary(ticker).catch(() => null),
      fetchOptionsContext(ticker).catch(() => null),
      fetchEarningsContext(ticker).catch(() => null),
    ]);

    const technicals = computeTechnicals(priceData);
    const { closes: _closes, ...priceClean } = priceData; // strip raw OHLCV from output

    const synth = await synthesize(ticker, priceClean, technicals, insiderRaw, optionsRaw, earningsRaw, style);

    return {
      ticker,
      ...synth,
      signals: {
        price:           priceClean.price,
        change_pct:      priceClean.change_pct,
        high_52w:        priceClean.high_52w,
        low_52w:         priceClean.low_52w,
        rsi14:           technicals.rsi14,
        rsi_signal:      technicals.rsi_signal,
        trend_regime:    technicals.trend_regime,
        sma20:           technicals.sma20,
        sma50:           technicals.sma50,
        sma200:          technicals.sma200,
        insider_net:     insiderRaw?.net_signal ?? null,
        insider_buys:    insiderRaw?.buy_count ?? null,
        insider_sells:   insiderRaw?.sell_count ?? null,
        iv30:            optionsRaw?.iv30 ?? null,
        pc_ratio:        optionsRaw?.pc_ratio ?? null,
        options_sentiment: optionsRaw?.sentiment ?? null,
        next_earnings:   earningsRaw?.next_earnings ?? null,
        days_to_earnings: earningsRaw?.days_to_earnings ?? null,
        eps_estimate:    earningsRaw?.eps_estimate ?? null,
        forward_pe:      earningsRaw?.forward_pe ?? null,
      },
      generated_at: new Date().toISOString(),
    };
  },
};
