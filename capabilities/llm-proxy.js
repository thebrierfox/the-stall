// llm-proxy.js
//
// x402-paywalled LLM inference proxy — the Blockrun model.
//
// Agents pay USDC on Base and get OpenAI inference without managing
// API keys. Solves the "agents that already have USDC wallets don't
// want to manage API keys across 11 providers" problem from the
// RelayPlane x402 ecosystem analysis (2026-03).
//
// Upstream: api.openai.com (OPENAI_API_KEY required in env).
//
// P0 bounding (2026-07-22/23): gpt-4o removed from this flat-price route —
// at up to 2,000 output tokens, gpt-4o's per-token cost alone could exceed
// the $0.021 flat price before input cost or infra overhead (margin-negative
// tail risk). gpt-4o-mini only, with an input-size ceiling, output-token
// ceiling, per-process concurrency ceiling, and a per-IP abuse limit (wallet
// rotation does not bypass it). Worst-case cost model:
//   input ceiling 2,000 tokens  * $0.15/1M = $0.00030
//   output ceiling 2,000 tokens * $0.60/1M = $0.00120
//   worst-case upstream cost                = $0.00150
//   price                                   = $0.021
//   gross margin (pre-infra)                = ~92.9%
// Price: $0.021/call. Repo/runtime/catalog/OpenAPI/402-quote must all agree
// on this figure — verify at deploy time, do not let this comment drift.

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const TIMEOUT_MS = 30_000;
const ALLOWED_MODELS = new Set(["gpt-4o-mini"]);

// Combined system+prompt character ceiling. ~4 chars/token is a conservative
// (over-)estimate for English text, so this bounds worst-case input tokens
// to roughly INPUT_CHAR_CEILING / 4.
const INPUT_CHAR_CEILING = 8_000; // ≈2,000 tokens worst case
const OUTPUT_TOKEN_CEILING = 2_000;

// Per-process concurrency ceiling — bounds simultaneous upstream OpenAI
// requests regardless of how many distinct payers/wallets are involved.
const MAX_CONCURRENT = 8;
let activeRequests = 0;

// Per-IP abuse limit — a rotating wallet does not reset this, since it keys
// on the request's IP, not the payer address.
const RATE_WINDOW_MS = 60_000;
const MAX_CALLS_PER_IP_PER_WINDOW = 20;
const ipCallLog = new Map(); // ip -> array of call timestamps (ms)

function checkIpRateLimit(ip) {
  if (!ip) return; // no IP context available (e.g. direct unit test call) — nothing to bound
  const now = Date.now();
  const calls = (ipCallLog.get(ip) || []).filter((ts) => now - ts < RATE_WINDOW_MS);
  if (calls.length >= MAX_CALLS_PER_IP_PER_WINDOW) {
    const err = new Error("Rate limit exceeded for this source — try again shortly.");
    err.status = 400;
    throw err;
  }
  calls.push(now);
  ipCallLog.set(ip, calls);
}

export default {
  name:  "llm-proxy",
  price: "$0.021",

  description:
    "LLM inference proxy — pay USDC, get AI responses without managing API keys. Accepts a prompt and optional system instruction, forwards to OpenAI, returns the completion. Runs gpt-4o-mini (fast, cost-efficient). Agents that already hold USDC on Base can call this to run one-off LLM tasks without onboarding to OpenAI. Max 2,000 output tokens per call, max 8,000 combined input characters.",

  inputSchema: {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: {
        type: "string",
        description: "The user message / task to send to the LLM.",
      },
      system: {
        type: "string",
        description: "Optional system prompt. Sets the persona or role for the model.",
      },
      model: {
        type: "string",
        enum: ["gpt-4o-mini"],
        description: "Model to use. Only gpt-4o-mini is available on this flat-price route.",
      },
      max_tokens: {
        type: "integer",
        minimum: 1,
        maximum: 2000,
        description: "Maximum output tokens. Default: 500. Increase for longer outputs (max 2,000).",
      },
    },
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "The model's response text.",
      },
      model: {
        type: "string",
        description: "The model that handled the request.",
      },
      finish_reason: {
        type: "string",
        description: "Why the model stopped: stop (natural end), length (hit max_tokens), or content_filter.",
      },
      usage: {
        type: "object",
        properties: {
          prompt_tokens:     { type: "integer" },
          completion_tokens: { type: "integer" },
          total_tokens:      { type: "integer" },
        },
      },
    },
  },

  async handler(query, ctx = {}) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY not set — llm-proxy cannot route requests.");
    }

    const { prompt, system, model, max_tokens: rawMaxTokens = 500 } = query;
    const max_tokens = Math.min(OUTPUT_TOKEN_CEILING, Math.max(1, Number(rawMaxTokens) || 500));

    if (!prompt?.trim()) {
      const err = new Error("prompt is required and cannot be empty.");
      err.status = 400;
      throw err;
    }

    // Disallowed model — reject before any upstream call. Do not silently
    // downgrade: an explicit request for a model this route doesn't serve
    // is a client error, not a substitution.
    if (model !== undefined && !ALLOWED_MODELS.has(model)) {
      const err = new Error(`model must be one of: ${[...ALLOWED_MODELS].join(", ")}`);
      err.status = 400;
      throw err;
    }
    const resolvedModel = "gpt-4o-mini";

    const combinedInputChars = (system?.trim() || "").length + (prompt?.trim() || "").length;
    if (combinedInputChars > INPUT_CHAR_CEILING) {
      const err = new Error(
        `Combined system+prompt length (${combinedInputChars} chars) exceeds the ${INPUT_CHAR_CEILING}-char ceiling for this route.`
      );
      err.status = 400;
      throw err;
    }

    checkIpRateLimit(ctx.req?.ip);

    if (activeRequests >= MAX_CONCURRENT) {
      const err = new Error("llm-proxy is at capacity — retry shortly.");
      err.status = 400;
      throw err;
    }

    const messages = [];
    if (system?.trim()) {
      messages.push({ role: "system", content: system.trim() });
    }
    messages.push({ role: "user", content: prompt.trim() });

    const body = {
      model: resolvedModel,
      messages,
      max_tokens,
      temperature: 0.7,
    };

    activeRequests++;
    try {
      const resp = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        if (resp.status === 429) throw new Error("OpenAI rate limit — retry in a few seconds.");
        if (resp.status === 401) throw new Error("OpenAI API key invalid.");
        throw new Error(`OpenAI API HTTP ${resp.status}: ${text.slice(0, 200)}`);
      }

      const data = await resp.json();
      const choice = data.choices?.[0];
      if (!choice) throw new Error("OpenAI returned no choices.");

      return {
        content:       choice.message?.content ?? "",
        model:         data.model ?? resolvedModel,
        finish_reason: choice.finish_reason ?? "stop",
        usage:         data.usage ?? null,
      };
    } finally {
      activeRequests--;
    }
  },
};
