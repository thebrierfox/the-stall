// fact-check.js
//
// Factual claim verification using Wikipedia search + GPT-4o-mini synthesis.
//
// Extracts the core factual assertions from a claim, queries Wikipedia for
// relevant primary-source content, and returns a structured verdict with
// supporting evidence and confidence score. Best for verifiable factual claims
// (statistics, historical events, attributions, dates, definitions). Not
// suitable for subjective or predictive claims.
//
// Pipeline:
//   1. GPT-4o-mini identifies search terms from the claim
//   2. Wikipedia search API → top matching article titles
//   3. Wikipedia REST API → page summaries for top-3 articles
//   4. GPT-4o-mini synthesizes verdict from claim + evidence corpus
//
// Data: Wikipedia (free, no auth). LLM: gpt-4o-mini (OPENAI_API_KEY).
//
// Price: $0.10

const WIKI_SEARCH = "https://en.wikipedia.org/w/api.php";
const WIKI_REST   = "https://en.wikipedia.org/api/rest_v1/page/summary";
const OPENAI_URL  = "https://api.openai.com/v1/chat/completions";
const MODEL       = "gpt-4o-mini";
const UA          = "the-stall/5.0 fact-check (kyle@intuitek.ai; +https://intuitek.ai)";
const TMO         = 15_000;

async function wikiSearch(query) {
  const url = `${WIKI_SEARCH}?action=opensearch&search=${encodeURIComponent(query)}&limit=5&namespace=0&format=json&origin=*`;
  const resp = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TMO) });
  if (!resp.ok) return [];
  const [, titles] = await resp.json();
  return titles ?? [];
}

async function wikiSummary(title) {
  const url = `${WIKI_REST}/${encodeURIComponent(title)}`;
  const resp = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" }, signal: AbortSignal.timeout(TMO) });
  if (!resp.ok) return null;
  const data = await resp.json();
  return { title: data.title, extract: data.extract, url: data.content_urls?.desktop?.page ?? null };
}

async function extractSearchTerms(claim, openaiKey) {
  const resp = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${openaiKey}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: `Extract 2 Wikipedia search queries that would find evidence for or against this claim. Return JSON: {"queries": ["query1", "query2"]}\n\nClaim: ${claim}` }],
      temperature: 0,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) return [claim.slice(0, 80)];
  const data = await resp.json();
  try {
    const parsed = JSON.parse(data.choices[0].message.content);
    return parsed.queries?.slice(0, 2) ?? [claim.slice(0, 80)];
  } catch { return [claim.slice(0, 80)]; }
}

async function synthesizeVerdict(claim, evidenceChunks, openaiKey) {
  const evidenceText = evidenceChunks
    .map(e => `[${e.title}]\n${e.extract?.slice(0, 600)}`)
    .join("\n\n");

  const prompt = `You are a fact-checker. Assess whether the following claim is factually accurate based on the Wikipedia evidence provided.

CLAIM: "${claim}"

EVIDENCE:
${evidenceText || "(No Wikipedia evidence found)"}

Return JSON with:
- "verdict": one of "LIKELY_TRUE", "LIKELY_FALSE", "MIXED", "UNVERIFIABLE"
- "confidence": 0.0–1.0 (how certain you are given the evidence)
- "explanation": 2-3 sentence assessment citing specific evidence
- "caveats": 1-2 limitations of this assessment (e.g., "Wikipedia may be outdated on this")
- "evidence_summary": one sentence summarizing what the evidence shows`;

  const resp = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${openaiKey}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`OpenAI ${resp.status}`);
  const data = await resp.json();
  return JSON.parse(data.choices[0].message.content);
}

export default {
name:        "fact-check",
price:       "$0.470",
description: "Factual claim verification using Wikipedia evidence + AI synthesis. Extracts search terms from the claim, queries Wikipedia for relevant articles, and returns a structured verdict (LIKELY_TRUE / LIKELY_FALSE / MIXED / UNVERIFIABLE) with confidence score, explanation, and source citations.",

inputSchema: {
  type: "object",
  properties: {
    claim: {
      type: "string",
      description: "The factual statement to verify (e.g. 'The Eiffel Tower is 330 meters tall' or 'Apple was founded in 1976').",
    },
  },
  required: ["claim"],
  additionalProperties: false,
},

outputSchema: {
  type: "object",
  properties: {
    claim:            { type: "string" },
    verdict:          { type: "string", description: "LIKELY_TRUE | LIKELY_FALSE | MIXED | UNVERIFIABLE" },
    confidence:       { type: "number", description: "0.0–1.0 confidence in verdict." },
    explanation:      { type: "string" },
    evidence_summary: { type: "string" },
    caveats:          { type: "string" },
    sources: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title:   { type: "string" },
          url:     { type: "string" },
          excerpt: { type: "string" },
        },
      },
    },
    generated_at: { type: "string" },
  },
},

async handler(query) {
  const claim = (query.claim ?? "").trim();
  if (!claim) throw Object.assign(new Error("provide claim parameter"), { status: 400 });

  const openaiKey = process.env.OPENAI_API_KEY ?? null;
  if (!openaiKey) throw new Error("OPENAI_API_KEY not configured — fact-check requires LLM synthesis");

  // Step 1: extract search terms
  const searchTerms = await extractSearchTerms(claim, openaiKey);

  // Step 2: Wikipedia search for each term
  const titleSets = await Promise.all(searchTerms.map(term => wikiSearch(term).catch(() => [])));
  const uniqueTitles = [...new Set(titleSets.flat())].slice(0, 4);

  // Step 3: fetch page summaries
  const summaries = (await Promise.all(uniqueTitles.map(t => wikiSummary(t).catch(() => null)))).filter(Boolean);

  // Step 4: synthesize verdict
  const synth = await synthesizeVerdict(claim, summaries, openaiKey);

  return {
    claim,
    verdict:          synth.verdict ?? "UNVERIFIABLE",
    confidence:       synth.confidence ?? 0,
    explanation:      synth.explanation ?? "",
    evidence_summary: synth.evidence_summary ?? "",
    caveats:          Array.isArray(synth.caveats) ? synth.caveats.join(" ") : (synth.caveats ?? ""),
    sources: summaries.map(s => ({
      title:   s.title,
      url:     s.url ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(s.title)}`,
      excerpt: s.extract?.slice(0, 200) ?? "",
    })),
    generated_at: new Date().toISOString(),
  };
},
};
