// research-synthesis.js
//
// AI-synthesized intelligence report from multiple free public sources.
// Gathers parallel signals from HN, OpenAlex, GDELT, Reddit, arXiv, and
// DuckDuckGo, then distills them into structured findings via OpenAI.
//
// Seam: scout.hugen.tokyo/scout/research — 17+ payers, $0.25/call.
// STALL prices at $0.200 (20% below). Upstream cost: ~$0.001 (gpt-4o-mini).
//
// Upstream: HN Algolia (free), OpenAlex (free), Reddit JSON (free),
//           arXiv (free), DDG Instant Answer (free)
//           + gpt-4o-mini synthesis via OPENAI_API_KEY.
// Note: GDELT excluded — consistently >10s response time in production tests.

const UA          = "Mozilla/5.0 (compatible; the-stall/3.52; +https://intuitek.ai)";
const SRC_TIMEOUT = 8_000;
const SYN_TIMEOUT = 20_000;
const OPENAI_URL  = "https://api.openai.com/v1/chat/completions";
const MODEL       = "gpt-4o-mini";

// ── source fetchers ──────────────────────────────────────────────────────────

async function fetchHN(query) {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=5`;
  const r   = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(SRC_TIMEOUT) });
  if (!r.ok) throw new Error(`HN ${r.status}`);
  const d = await r.json();
  return (d.hits || []).map(h => ({
    source: "Hacker News",
    title:  h.title,
    url:    h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    points: h.points,
    snippet: h.story_text ? h.story_text.slice(0, 300) : null,
  }));
}

async function fetchOpenAlex(query) {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=5&mailto=kyle@intuitek.ai&select=title,abstract_inverted_index,publication_year,cited_by_count,primary_location`;
  const r   = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(SRC_TIMEOUT) });
  if (!r.ok) throw new Error(`OpenAlex ${r.status}`);
  const d = await r.json();
  return (d.results || []).map(w => ({
    source:  "OpenAlex (Academic)",
    title:   w.title,
    year:    w.publication_year,
    cited:   w.cited_by_count,
    url:     w.primary_location?.landing_page_url || null,
    snippet: decodeInvertedIndex(w.abstract_inverted_index)?.slice(0, 300) || null,
  }));
}

function decodeInvertedIndex(inv) {
  if (!inv) return null;
  const words = Object.entries(inv)
    .flatMap(([w, positions]) => positions.map(p => ({ w, p })))
    .sort((a, b) => a.p - b.p)
    .map(x => x.w);
  return words.join(" ");
}

async function fetchReddit(query) {
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance&limit=5&t=month`;
  const r   = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(SRC_TIMEOUT) });
  if (!r.ok) throw new Error(`Reddit ${r.status}`);
  const d = await r.json();
  return ((d.data?.children) || []).map(c => c.data).map(p => ({
    source:    "Reddit",
    title:     p.title,
    url:       `https://reddit.com${p.permalink}`,
    subreddit: p.subreddit,
    score:     p.score,
    snippet:   p.selftext ? p.selftext.slice(0, 300) : null,
  }));
}

async function fetchArxiv(query) {
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=4&sortBy=relevance`;
  const r   = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(SRC_TIMEOUT) });
  if (!r.ok) throw new Error(`arXiv ${r.status}`);
  const text = await r.text();
  // minimal XML parse for entry titles and summaries
  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(text)) !== null) {
    const block   = m[1];
    const title   = (/<title>([\s\S]*?)<\/title>/.exec(block)?.[1] || "").trim().replace(/\n/g, " ");
    const summary = (/<summary>([\s\S]*?)<\/summary>/.exec(block)?.[1] || "").trim().slice(0, 300);
    const link    = /<id>(.*?)<\/id>/.exec(block)?.[1]?.trim() || null;
    if (title) entries.push({ source: "arXiv (Preprint)", title, url: link, snippet: summary });
  }
  return entries;
}

async function fetchDDG(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1`;
  const r   = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(SRC_TIMEOUT) });
  if (!r.ok) throw new Error(`DDG ${r.status}`);
  const d = await r.json();
  const items = [];
  if (d.AbstractText) {
    items.push({ source: "DuckDuckGo Abstract", title: d.Heading, url: d.AbstractURL, snippet: d.AbstractText.slice(0, 400) });
  }
  (d.RelatedTopics || []).slice(0, 3).forEach(t => {
    if (t.Text && t.FirstURL) {
      items.push({ source: "DuckDuckGo", title: t.Text.slice(0, 80), url: t.FirstURL, snippet: t.Text.slice(0, 300) });
    }
  });
  return items;
}

// ── synthesis ────────────────────────────────────────────────────────────────

async function synthesize(query, focus, results) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const sources = results.flatMap(r => r.items || []);
  const sourceText = sources.slice(0, 20).map((s, i) =>
    `[${i + 1}] ${s.source}: ${s.title}` +
    (s.snippet ? `\n    → ${s.snippet}` : "") +
    (s.url ? `\n    URL: ${s.url}` : "")
  ).join("\n\n");

  const focusClause = focus ? ` Focus particularly on: ${focus}.` : "";
  const prompt = `You are an AI intelligence analyst. Synthesize the following source snippets into a structured intelligence report for the query: "${query}".${focusClause}

SOURCES GATHERED:
${sourceText}

Respond ONLY with a JSON object (no markdown, no prose outside the JSON) with this exact structure:
{
  "summary": "2-3 sentence executive synthesis of the key findings",
  "key_findings": ["finding 1", "finding 2", "finding 3", "finding 4"],
  "sentiment": "positive | negative | neutral | mixed",
  "trends": ["trend 1", "trend 2", "trend 3"],
  "recommendations": ["recommendation 1", "recommendation 2"]
}`;

  const resp = await fetch(OPENAI_URL, {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: 1024,
      messages:   [
        { role: "system", content: "You are an intelligence analyst. Always respond with valid JSON only." },
        { role: "user",   content: prompt },
      ],
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(SYN_TIMEOUT),
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => resp.status);
    throw new Error(`OpenAI API ${resp.status}: ${String(err).slice(0, 200)}`);
  }

  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || "";
  try {
    return JSON.parse(text);
  } catch {
    const m = /\{[\s\S]*\}/.exec(text);
    if (m) return JSON.parse(m[0]);
    throw new Error("Synthesis did not return valid JSON");
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

export default {
  name:  "research-synthesis",
  price: "$2.50",

  description:
    "AI-synthesized intelligence report on any topic — aggregates Hacker News, OpenAlex academic papers, Reddit, arXiv preprints, and DuckDuckGo in parallel, then distills into a structured report: executive summary, key findings, market sentiment, emerging trends, and recommendations. Works across domains: financial markets, macroeconomics, technology, life sciences, geopolitics, and more. Pass ?query=your+topic for targeted research. Omit query for a default AI agents & autonomous systems report.",

  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Research query or topic — works across any domain: financial markets (e.g. 'S&P 500 earnings outlook Q3 2026'), macroeconomics ('Fed rate policy impact on equities'), technology ('AI agent protocols 2025'), and more. Omit for default AI agents report.",
      },
      focus: {
        type: "string",
        description: "Optional focus direction for synthesis (e.g. 'technical implementation details', 'market adoption', 'risks and challenges'). Narrows the analytical lens.",
      },
    },
    required: [],
  },

  outputSchema: {
    type: "object",
    properties: {
      query:            { type: "string" },
      focus:            { type: ["string", "null"] },
      summary:          { type: "string" },
      key_findings:     { type: "array", items: { type: "string" } },
      sentiment:        { type: "string" },
      trends:           { type: "array", items: { type: "string" } },
      recommendations:  { type: "array", items: { type: "string" } },
      sources_queried:  { type: "integer" },
      sources_responded:{ type: "integer" },
      source_breakdown: { type: "object" },
      generated_at:     { type: "string", description: "ISO-8601 timestamp of when this report was synthesized (report is fetched live, never cached)." },
    },
  },

  async handler({ query, focus }) {
    const DEFAULT_QUERY = "AI agents autonomous systems 2025";
    const q = (query && query.trim().length >= 3 ? query.trim() : DEFAULT_QUERY).slice(0, 200);
    const f = focus ? focus.trim().slice(0, 100) : null;

    // Fetch all sources in parallel, failing gracefully per source
    const sourceNames = ["hn", "openalex", "reddit", "arxiv", "ddg"];
    const fetchers    = [
      fetchHN(q).then(items => ({ name: "hn",       ok: true,  items })).catch(e => ({ name: "hn",       ok: false, items: [], error: e.message })),
      fetchOpenAlex(q).then(items => ({ name: "openalex", ok: true, items })).catch(e => ({ name: "openalex", ok: false, items: [], error: e.message })),
      fetchReddit(q).then(items => ({ name: "reddit",   ok: true,  items })).catch(e => ({ name: "reddit",   ok: false, items: [], error: e.message })),
      fetchArxiv(q).then(items => ({ name: "arxiv",    ok: true,  items })).catch(e => ({ name: "arxiv",    ok: false, items: [], error: e.message })),
      fetchDDG(q).then(items => ({ name: "ddg",      ok: true,  items })).catch(e => ({ name: "ddg",      ok: false, items: [], error: e.message })),
    ];

    const results = await Promise.all(fetchers);
    const responded = results.filter(r => r.ok && r.items.length > 0);

    if (responded.length === 0) {
      return { error: "no_sources", message: "All source fetches failed. The query may be too unusual or sources may be temporarily unavailable." };
    }

    let synthesis;
    try {
      synthesis = await synthesize(q, f, responded);
    } catch (err) {
      return { error: "synthesis_failed", message: err.message };
    }

    const breakdown = {};
    for (const r of results) {
      breakdown[r.name] = r.ok ? r.items.length : `error: ${r.error}`;
    }

    return {
      query:             q,
      focus:             f,
      summary:           synthesis.summary           || "",
      key_findings:      synthesis.key_findings      || [],
      sentiment:         synthesis.sentiment         || "neutral",
      trends:            synthesis.trends            || [],
      recommendations:   synthesis.recommendations   || [],
      sources_queried:   sourceNames.length,
      sources_responded: responded.length,
      source_breakdown:  breakdown,
      generated_at:      new Date().toISOString(),
    };
  },
};
