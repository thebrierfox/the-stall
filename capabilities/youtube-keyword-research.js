// youtube-keyword-research.js
//
// YouTube keyword research via Google's YouTube autocomplete API.
// Returns keyword suggestions and intent clusters (questions, tutorials,
// comparisons, trending) for a seed topic.
//
// Demand signal: youtube-intel is STALL's #1 organic cap (59 calls / 72h,
// 12 wallets). These callers do YouTube content and competitive research;
// keyword discovery is the natural upstream step before youtube-niche-intel
// (competition check) and youtube-channel-intel (competitor deep-dive).
//
// Upstream: Google YouTube autocomplete — undocumented but stable, no auth,
// same endpoint YouTube's own search uses. Proven live 2026-06-25.
//
// Price: $0.012 — cheap entry point that drives workflow attachment.
// Workflow: youtube-keyword-research → youtube-niche-intel → youtube-intel
//           → youtube-channel-analytics → youtube-channel-intel

const AC_BASE  = "https://suggestqueries.google.com/complete/search";
const UA       = "Mozilla/5.0 (compatible; the-stall/4.10; +https://intuitek.ai)";
const TIMEOUT  = 8_000;

function parseAC(raw) {
  // Response: window.google.ac.h(["query", [["suggestion", 0, [flags...]], ...], ...])
  const match = raw.match(/window\.google\.ac\.h\((\[.*\])\)/s);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    // parsed = ["query", [["suggestion", 0, [flags]], ...], ...]
    const items = parsed[1];
    if (!Array.isArray(items)) return [];
    return items
      .filter(item => Array.isArray(item) && typeof item[0] === "string")
      .map(item => item[0].toLowerCase().trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function fetchSuggestions(query, lang, country) {
  const url = new URL(AC_BASE);
  url.searchParams.set("client", "youtube");
  url.searchParams.set("ds", "yt");
  url.searchParams.set("q", query);
  url.searchParams.set("hl", lang);
  url.searchParams.set("gl", country);

  const resp = await fetch(url.toString(), {
    headers: { "User-Agent": UA },
    signal:  AbortSignal.timeout(TIMEOUT),
  });
  if (!resp.ok) throw new Error(`Autocomplete returned ${resp.status}`);
  return parseAC(await resp.text());
}

// Intent matchers
const Q_RE     = /^(how|what|why|when|is|are|can|does|do|will|which|where|who)\b/i;
const TUT_RE   = /\b(how to|tutorial|guide|learn|course|for beginners|beginner|step by step|tips|tricks|basics|intro|introduction|101|masterclass)\b/i;
const CMP_RE   = /\b(vs\.?|versus|compare|or |alternative|alternatives|best |better|difference|differences|review)\b/i;
const YEAR_RE  = /\b(2024|2025|2026)\b/;

export default {
  name: "youtube-keyword-research",
  price: "$0.059",

  description:
    "YouTube keyword research using Google's autocomplete API. For a seed topic, returns suggested search phrases plus intent clusters: questions people ask, tutorial/learning queries, comparison queries, and year-tagged trending terms. No API key. Upstream of youtube-niche-intel (competition scoring) and youtube-intel (video search). Use when mapping a YouTube content strategy, finding keyword gaps, or building a channel topic plan.",

  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Seed keyword or topic (e.g. 'passive income', 'python for beginners', 'meal prep 2026').",
      },
      expand: {
        type: "boolean",
        description: "Probe query+a through query+z for deeper coverage (26 extra lookups, ~2–3 s added latency). Default false.",
        default: false,
      },
      language: {
        type: "string",
        description: "BCP-47 language code. Default 'en'.",
        default: "en",
      },
      country: {
        type: "string",
        description: "ISO 3166-1 alpha-2 country code. Default 'us'.",
        default: "us",
      },
    },
    required: ["query"],
  },

  outputSchema: {
    type: "object",
    properties: {
      seed_query:           { type: "string",  description: "Normalized input query." },
      top_suggestions:      { type: "array",   items: { type: "string" }, description: "Up to 10 highest-ranked autocomplete suggestions." },
      all_suggestions:      { type: "array",   items: { type: "string" }, description: "All unique suggestions collected (base + expanded if requested)." },
      question_variants:    { type: "array",   items: { type: "string" }, description: "Question-intent keywords (how, what, why, when, is, can…)." },
      tutorial_variants:    { type: "array",   items: { type: "string" }, description: "Tutorial/learning keywords (how to, tutorial, guide, beginner…)." },
      comparison_variants:  { type: "array",   items: { type: "string" }, description: "Comparison keywords (vs, versus, best, alternative, review…)." },
      trending_variants:    { type: "array",   items: { type: "string" }, description: "Year-tagged keywords (2024, 2025, 2026) indicating recency demand." },
      total_count:          { type: "number",  description: "Total unique suggestions collected." },
      expanded:             { type: "boolean", description: "Whether expand mode was used." },
    },
  },

  async handler({ query, expand = false, language = "en", country = "us" }) {
    if (!query?.trim()) throw new Error("query is required");

    const q   = query.trim().toLowerCase();
    const seen = new Set();
    const ordered = []; // first-seen order → base suggestions first (highest rank)

    // Base fetch
    const base = await fetchSuggestions(q, language, country);
    for (const kw of base) {
      if (!seen.has(kw)) { seen.add(kw); ordered.push(kw); }
    }

    // Expanded: query + each letter (a–z) in parallel
    if (expand) {
      const letters = "abcdefghijklmnopqrstuvwxyz".split("");
      const settled = await Promise.allSettled(
        letters.map(l => fetchSuggestions(`${q} ${l}`, language, country))
      );
      for (const result of settled) {
        if (result.status === "fulfilled") {
          for (const kw of result.value) {
            if (!seen.has(kw)) { seen.add(kw); ordered.push(kw); }
          }
        }
      }
    }

    const top_suggestions      = ordered.slice(0, 10);
    const question_variants    = ordered.filter(k => Q_RE.test(k));
    const tutorial_variants    = ordered.filter(k => TUT_RE.test(k));
    const comparison_variants  = ordered.filter(k => CMP_RE.test(k));
    const trending_variants    = ordered.filter(k => YEAR_RE.test(k));

    return {
      seed_query:          q,
      top_suggestions,
      all_suggestions:     ordered,
      question_variants,
      tutorial_variants,
      comparison_variants,
      trending_variants,
      total_count:         ordered.length,
      expanded:            expand,
    };
  },
};
