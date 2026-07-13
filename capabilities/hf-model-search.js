// hf-model-search.js
//
// Search HuggingFace Hub for ML models by task, keyword, or framework.
// Returns ranked results with downloads, likes, pipeline tag, and library.
//
// Upstream: huggingface.co/api/models — free, no auth required.
// Price: $0.002 (no competitor in x402 Bazaar; unique coverage of 1M+ HF models).

const HF_API = "https://huggingface.co/api/models";
const UA = "the-stall/3.77 (https://intuitek.ai)";
const TIMEOUT = 12000;

const VALID_SORT = new Set(["downloads", "likes", "lastModified", "createdAt"]);
const VALID_TASKS = new Set([
  "text-classification", "token-classification", "question-answering",
  "translation", "summarization", "text-generation", "text2text-generation",
  "fill-mask", "zero-shot-classification", "feature-extraction",
  "sentence-similarity", "image-classification", "object-detection",
  "image-segmentation", "text-to-image", "image-to-text",
  "automatic-speech-recognition", "audio-classification", "text-to-speech",
  "tabular-classification", "tabular-regression", "reinforcement-learning",
]);

export default {
  name: "hf-model-search",
  price: "$0.059",

  description:
    "Search HuggingFace Hub for ML models. Specify a keyword (e.g. 'bert', 'llama', 'stable diffusion') and optional task filter (e.g. 'text-classification', 'text-generation', 'image-classification'). Returns top results sorted by downloads or likes, including model ID, author, pipeline task, framework library, download count, likes count, and tags.",

  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query — model name, architecture, or keyword (e.g. 'bert', 'llama', 'sentiment'). Defaults to 'language model'.",
      },
      task: {
        type: "string",
        description: "Optional pipeline task filter (e.g. 'text-classification', 'text-generation', 'image-classification'). Omit to search all tasks.",
      },
      sort: {
        type: "string",
        enum: ["downloads", "likes", "lastModified"],
        description: "Sort order. Default: downloads.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        description: "Number of results to return (1–20). Default: 10.",
      },
    },
    required: [],
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      query:       { type: "string" },
      task_filter: { type: "string", description: "Task filter applied, or null." },
      count:       { type: "integer" },
      models: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id:           { type: "string", description: "Full model ID (author/name)." },
            author:       { type: "string" },
            pipeline_tag: { type: "string", description: "ML task category." },
            library:      { type: "string", description: "Framework (transformers, diffusers, etc.)." },
            downloads:    { type: "integer", description: "Monthly download count." },
            likes:        { type: "integer" },
            tags:         { type: "array", items: { type: "string" } },
            url:          { type: "string", description: "HuggingFace model page URL." },
            last_modified:{ type: "string" },
          },
        },
      },
      generated_at: { type: "string" },
    },
  },

  async handler(query) {
    const q = ((query.query || "").trim()) || "language model";

    const sort  = VALID_SORT.has(query.sort) ? query.sort : "downloads";
    const limit = Math.min(Math.max(parseInt(query.limit ?? 10, 10), 1), 20);
    const task  = query.task || null;

    const params = new URLSearchParams({ search: q, sort, direction: "-1", limit: String(limit) });
    if (task) params.set("pipeline_tag", task);

    const resp = await fetch(`${HF_API}?${params}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT),
    });

    if (!resp.ok) {
      throw new Error(`HuggingFace API error: HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const models = (Array.isArray(data) ? data : []).map(m => ({
      id:           m.modelId || m.id || null,
      author:       m.author || null,
      pipeline_tag: m.pipeline_tag || null,
      library:      m.library_name || null,
      downloads:    m.downloads ?? null,
      likes:        m.likes ?? null,
      tags:         (m.tags || []).filter(t => !["transformers","pytorch","tf","jax","rust","gguf","safetensors"].includes(t)).slice(0, 8),
      url:          m.modelId ? `https://huggingface.co/${m.modelId}` : null,
      last_modified: m.lastModified || null,
    }));

    return {
      query:        q,
      task_filter:  task,
      count:        models.length,
      models,
      generated_at: new Date().toISOString(),
    };
  },
};
