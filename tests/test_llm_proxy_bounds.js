// tests/test_llm_proxy_bounds.js — P0 bounding checks for llm-proxy (STALL
// containment, 2026-07-22/23). Verifies rejection happens before any upstream
// OpenAI call — no network access required for these paths.
// Run: node --test tests/test_llm_proxy_bounds.js

import { test } from "node:test";
import assert from "node:assert/strict";
import llmProxy from "../capabilities/llm-proxy.js";

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-placeholder-not-real";

test("disallowed model (gpt-4o) is rejected before any upstream call", async () => {
  await assert.rejects(
    () => llmProxy.handler({ prompt: "hi", model: "gpt-4o" }, {}),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /model must be one of/);
      return true;
    }
  );
});

test("gpt-4o is not present in the model enum at all", () => {
  assert.deepEqual(llmProxy.inputSchema.properties.model.enum, ["gpt-4o-mini"]);
});

test("input over the character ceiling is rejected before any upstream call", async () => {
  const hugePrompt = "x".repeat(9_000);
  await assert.rejects(
    () => llmProxy.handler({ prompt: hugePrompt }, {}),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /exceeds the 8000-char ceiling/);
      return true;
    }
  );
});

test("output max_tokens is clamped to the 2,000 ceiling regardless of request", () => {
  // max_tokens isn't independently observable without a network call, but the
  // schema ceiling plus the Math.min clamp in the handler bound it — assert
  // the declared schema ceiling matches the documented cost model.
  assert.equal(llmProxy.inputSchema.properties.max_tokens.maximum, 2000);
});

test("per-IP rate limit rejects the 21st call within the window, before upstream", async (t) => {
  // Stub fetch so calls that pass the rate limiter don't make real network
  // requests to OpenAI — this test is only about the in-process limiter.
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], model: "gpt-4o-mini", usage: {} }),
  }));
  t.after(() => { globalThis.fetch = originalFetch; });

  const ip = "203.0.113.42";
  for (let i = 0; i < 20; i++) {
    await llmProxy.handler({ prompt: "hi" }, { req: { ip } });
  }
  await assert.rejects(
    () => llmProxy.handler({ prompt: "hi" }, { req: { ip } }),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /Rate limit exceeded/);
      return true;
    }
  );
});
