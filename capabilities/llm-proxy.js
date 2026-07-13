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
// Model routing: gpt-4o-mini (default) for sub-cent margin-positive calls.
// Price: $0.010/call covers cost + margin at typical agent request sizes.

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const TIMEOUT_MS = 30_000;
const ALLOWED_MODELS = new Set(["gpt-4o-mini", "gpt-4o"]);

export default {
  name:  "llm-proxy",
  price: "$0.021",

  description:
    "LLM inference proxy — pay USDC, get AI responses without managing API keys. Accepts a prompt and optional system instruction, forwards to OpenAI, returns the completion. Supports gpt-4o-mini (default, fast and cost-efficient) or gpt-4o (more capable). Agents that already hold USDC on Base can call this to run one-off LLM tasks without onboarding to OpenAI. Max 2,000 output tokens per call.",

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
        enum: ["gpt-4o-mini", "gpt-4o"],
        description: "Model to use. Default: gpt-4o-mini (fast, cost-efficient). Use gpt-4o for complex multi-step reasoning.",
      },
      max_tokens: {
        type: "integer",
        minimum: 1,
        maximum: 2000,
        description: "Maximum output tokens. Default: 500. Increase for longer outputs.",
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

  async handler(query) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY not set — llm-proxy cannot route requests.");
    }

    const { prompt, system, model = "gpt-4o-mini", max_tokens: rawMaxTokens = 500 } = query;
    const max_tokens = Math.min(2000, Math.max(1, Number(rawMaxTokens) || 500));

    if (!prompt?.trim()) {
      const err = new Error("prompt is required and cannot be empty.");
      err.status = 400;
      throw err;
    }

    const resolvedModel = ALLOWED_MODELS.has(model) ? model : "gpt-4o-mini";

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
  },
};
