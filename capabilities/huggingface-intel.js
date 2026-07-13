// huggingface-intel.js
//
// HuggingFace Hub intelligence: search models and datasets, get detailed model
// info, find trending models by task — all from the HuggingFace public API.
//
// Use cases:
//   - AI pipeline builders evaluating which model to use for a task
//   - Researchers tracking the state of the art in a domain
//   - Agents auto-selecting the best open-source model for a subtask
//   - Comparing download velocity across competing model families (Llama vs Qwen vs Mistral)
//
// Actions:
//   search_models  — find models by keyword + optional task/library filter
//   model_info     — full metadata for a specific model (model card, params, license)
//   trending       — most-liked models, optionally filtered by task
//   search_datasets — find datasets by keyword + optional task filter
//
// Upstream: HuggingFace public API (https://huggingface.co/api/).
// No API key required. Rate limit: 500 req/5 min unauthenticated.
// Price: $0.010/call.

const HF_API   = "https://huggingface.co/api";
const UA       = "Mozilla/5.0 (compatible; the-stall/4.66; +https://intuitek.ai)";
const TIMEOUT  = 12_000;

const PIPELINE_TASKS = [
  "text-generation","text2text-generation","summarization","translation",
  "question-answering","fill-mask","text-classification","token-classification",
  "ner","conversational","zero-shot-classification","sentence-similarity",
  "feature-extraction","image-classification","object-detection","image-segmentation",
  "depth-estimation","image-to-text","visual-question-answering","image-to-image",
  "text-to-image","text-to-audio","text-to-speech","automatic-speech-recognition",
  "audio-classification","audio-to-audio","tabular-classification","tabular-regression",
  "reinforcement-learning","robotics","graph-machine-learning",
];

async function hfFetch(path, params = {}) {
  const url = new URL(`${HF_API}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const resp = await fetch(url.toString(), {
    headers: { "User-Agent": UA, "Accept": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    throw new Error(`HuggingFace API ${resp.status}: ${err.slice(0, 120)}`);
  }
  return resp.json();
}

function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.filter(t =>
    !t.startsWith("dataset:") &&
    !t.startsWith("arxiv:") &&
    !t.startsWith("base_model:") &&
    !t.startsWith("deploy:") &&
    !t.startsWith("region:")
  ).slice(0, 12);
}

function extractLicense(tags) {
  const l = (tags || []).find(t => t.startsWith("license:"));
  return l ? l.replace("license:", "") : null;
}

function extractLang(tags) {
  return (tags || [])
    .filter(t => /^[a-z]{2}$/.test(t) || /^[a-z]{2}-[A-Z]{2}$/.test(t))
    .slice(0, 5);
}

function formatModel(m) {
  return {
    id:            m.id,
    pipeline_task: m.pipeline_tag ?? null,
    library:       m.library_name ?? null,
    downloads:     m.downloads ?? null,
    likes:         m.likes ?? null,
    license:       extractLicense(m.tags),
    languages:     extractLang(m.tags),
    tags:          cleanTags(m.tags),
    last_modified: m.lastModified ?? null,
    created_at:    m.createdAt ?? null,
  };
}

function formatDataset(d) {
  return {
    id:          d.id,
    description: (d.description ?? "").slice(0, 200).trim(),
    downloads:   d.downloads ?? null,
    likes:       d.likes ?? null,
    gated:       d.gated ?? false,
    license:     extractLicense(d.tags),
    tags:        (d.tags ?? []).filter(t => !t.startsWith("region:")).slice(0, 10),
    last_modified: d.lastModified ?? null,
    created_at:    d.createdAt ?? null,
  };
}

async function searchModels({ query, task, library, sort, limit }) {
  const params = {
    limit:     Math.min(limit ?? 10, 30),
    sort:      sort === "trending" ? "likes" : (sort ?? "downloads"),
    direction: -1,
    full:      false,
  };
  if (query)   params.search  = query;
  if (task)    params.filter  = task;
  if (library) params.library = library;

  const models = await hfFetch("/models", params);
  return {
    action:  "search_models",
    query:   query ?? null,
    task:    task ?? null,
    sort:    params.sort,
    count:   models.length,
    models:  models.map(formatModel),
    note: "sorted by downloads (most popular) by default. Set sort='likes' for community buzz.",
  };
}

async function modelInfo({ model_id }) {
  if (!model_id) throw new Error("model_id is required");
  const m = await hfFetch(`/models/${model_id.replace(/^\//, "")}`);
  const base = formatModel(m);
  // Extra fields from full model fetch
  const siblings = (m.siblings ?? []).map(s => s.rfilename).filter(f =>
    /\.(json|txt|md|safetensors|bin|gguf)$/i.test(f)
  ).slice(0, 15);
  const safeInfo = m.safetensors?.parameters ?? null;
  const paramCount = safeInfo
    ? Object.values(safeInfo).reduce((a, b) => a + b, 0)
    : null;
  return {
    action:         "model_info",
    model_id,
    ...base,
    total_params:   paramCount,
    param_breakdown: safeInfo,
    model_card_url: `https://huggingface.co/${model_id}`,
    inference_api:  m.inference ?? null,
    siblings,
  };
}

async function trending({ task, limit }) {
  const params = {
    limit:     Math.min(limit ?? 15, 30),
    sort:      "likes",
    direction: -1,
    full:      false,
  };
  if (task) params.filter = task;

  const models = await hfFetch("/models", params);
  return {
    action:  "trending",
    task:    task ?? "all tasks",
    ranked_by: "likes (community endorsement)",
    count:   models.length,
    models:  models.map(formatModel),
    note: "Top liked models = strongest community signal. For raw usage volume, use search_models with sort=downloads.",
  };
}

async function searchDatasets({ query, task, limit }) {
  const params = {
    limit:     Math.min(limit ?? 10, 20),
    sort:      "downloads",
    direction: -1,
    full:      false,
  };
  if (query) params.search = query;
  if (task)  params.filter = task;

  const datasets = await hfFetch("/datasets", params);
  return {
    action:  "search_datasets",
    query:   query ?? null,
    task:    task ?? null,
    count:   datasets.length,
    datasets: datasets.map(formatDataset),
  };
}

export default {
  name:  "huggingface-intel",
  price: "$0.021",

  description:
    "HuggingFace Hub intelligence: search AI models and datasets, get detailed model metadata, and find trending models by task. Returns downloads, likes, license, supported languages, pipeline task, and tags. Use to evaluate which open-source model best fits a task, compare model families (Llama vs Qwen vs Mistral), track AI research trends, or discover datasets for fine-tuning. Free upstream: HuggingFace public API (no key required).",

  inputSchema: {
    type: "object",
    required: [],
    properties: {
      action: {
        type: "string",
        enum: ["search_models", "model_info", "trending", "search_datasets"],
        description:
          "Action to perform. " +
          "'search_models': find models by keyword + optional task/library filter. " +
          "'model_info': full metadata for a specific model ID (params, files, license). " +
          "'trending': most-liked models, optionally filtered by pipeline task. " +
          "'search_datasets': find datasets by keyword + optional task filter. " +
          "Default: 'trending'.",
      },
      query: {
        type: "string",
        description:
          "Search keyword for search_models or search_datasets (e.g. 'bert embedding', 'llama instruction', 'image classification pytorch'). Omit to browse all.",
      },
      model_id: {
        type: "string",
        description:
          "Full HuggingFace model ID for model_info action (e.g. 'meta-llama/Llama-3-8B-Instruct', 'openai/whisper-large-v3', 'sentence-transformers/all-MiniLM-L6-v2').",
      },
      task: {
        type: "string",
        description:
          "Filter by pipeline task for search_models, trending, or search_datasets. " +
          `Valid tasks: ${PIPELINE_TASKS.slice(0,12).join(", ")}, and more. ` +
          "Omit to search across all tasks.",
      },
      library: {
        type: "string",
        description:
          "Filter models by library for search_models (e.g. 'transformers', 'diffusers', 'sentence-transformers', 'timm', 'peft', 'trl'). Omit for all libraries.",
      },
      sort: {
        type: "string",
        enum: ["downloads", "likes"],
        description:
          "Sort order for search_models: 'downloads' = most widely used (default), 'likes' = most community buzz / trending. Trending action always uses likes.",
      },
      limit: {
        type: "number",
        description: "Max results to return (default 10 for search, 15 for trending, max 30).",
      },
    },
  },

  outputSchema: {
    type: "object",
    properties: {
      action:   { type: "string", description: "Action that was performed." },
      count:    { type: "number", description: "Number of results returned." },
      models:   {
        type: "array",
        description: "List of model objects (search_models and trending actions).",
        items: {
          type: "object",
          properties: {
            id:            { type: "string",  description: "HuggingFace model ID (e.g. 'meta-llama/Llama-3-8B-Instruct')." },
            pipeline_task: { type: ["string","null"], description: "Inference pipeline task (e.g. 'text-generation', 'feature-extraction')." },
            library:       { type: ["string","null"], description: "ML library (e.g. 'transformers', 'diffusers')." },
            downloads:     { type: ["number","null"], description: "Total downloads from HuggingFace Hub." },
            likes:         { type: ["number","null"], description: "Community likes (endorsement signal)." },
            license:       { type: ["string","null"], description: "SPDX license identifier (e.g. 'apache-2.0', 'mit', 'llama3')." },
            languages:     { type: "array",   description: "Supported language codes (e.g. ['en', 'fr'])." },
            tags:          { type: "array",   description: "Model tags (framework, architecture, task, etc.)." },
            last_modified: { type: ["string","null"], description: "ISO 8601 last modification date." },
            created_at:    { type: ["string","null"], description: "ISO 8601 creation date." },
          },
        },
      },
      datasets: {
        type: "array",
        description: "List of dataset objects (search_datasets action).",
        items: {
          type: "object",
          properties: {
            id:          { type: "string",  description: "HuggingFace dataset ID." },
            description: { type: "string",  description: "Short dataset description (≤200 chars)." },
            downloads:   { type: ["number","null"] },
            likes:       { type: ["number","null"] },
            gated:       { type: "boolean", description: "Whether dataset requires access approval." },
            license:     { type: ["string","null"] },
            tags:        { type: "array" },
          },
        },
      },
      model_id:        { type: "string",          description: "Requested model ID (model_info action)." },
      total_params:    { type: ["number","null"],  description: "Total parameter count (from safetensors metadata, model_info only)." },
      param_breakdown: { type: ["object","null"],  description: "Parameter count per dtype (model_info only)." },
      model_card_url:  { type: "string",           description: "URL to model card on HuggingFace Hub (model_info only)." },
      siblings:        { type: "array",            description: "Key files in the model repo (model_info only)." },
      note:            { type: "string",           description: "Contextual note about the result." },
      query:           { type: ["string","null"] },
      task:            { type: ["string","null"] },
      sort:            { type: "string" },
      ranked_by:       { type: "string" },
    },
  },

  async handler({ action = "trending", query, model_id, task, library, sort, limit }) {
    switch (action) {
      case "search_models":   return searchModels({ query, task, library, sort, limit });
      case "model_info":      return modelInfo({ model_id });
      case "trending":        return trending({ task, limit });
      case "search_datasets": return searchDatasets({ query, task, limit });
      default:
        throw new Error(`Unknown action: "${action}". Valid: search_models, model_info, trending, search_datasets`);
    }
  },
};
