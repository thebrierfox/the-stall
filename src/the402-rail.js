// the402-rail.js — Webhook handler for the402.ai marketplace integration.
//
// the402.ai is an x402-based service marketplace. When an agent buys a STALL
// service listed on the402, the402 POSTs a signed webhook here, STALL executes
// the capability, then POSTs the result back to the402's callback URL.
//
// Required env vars (set after registration):
//   THE402_API_KEY        — Provider API key for posting callbacks
//   THE402_WEBHOOK_SECRET — HMAC-SHA256 secret for verifying incoming webhooks
//
// Webhook route: POST /v1/the402-webhook
// Registration:  scripts/register_the402.mjs

import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";
import { appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const LOG = join(__dir, "..", "logs", "the402-webhook.jsonl");

const MAX_TIMESTAMP_SKEW_SEC = 300;
const CALLBACK_TIMEOUT_MS    = 15_000;

function logEntry(obj) {
  try { appendFileSync(LOG, JSON.stringify(obj) + "\n"); } catch (_) {}
}

function verifyHmac(secret, timestamp, rawBody, signature) {
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  const sigBuf = Buffer.from(signature, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expBuf.length) return false;
  return timingSafeEqual(sigBuf, expBuf);
}

async function postCallback(callbackUrl, apiKey, body) {
  try {
    const res = await fetch(callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    });
    return res.status;
  } catch (err) {
    console.error(`[the402-rail] callback POST failed: ${err.message}`);
    return null;
  }
}

function findCap(serviceName, capMap) {
  if (typeof serviceName !== "string" || !serviceName) return null;
  if (capMap.has(serviceName)) return capMap.get(serviceName);
  const lower = serviceName.toLowerCase();
  for (const [name, cap] of capMap) {
    if (name.toLowerCase() === lower) return cap;
  }
  return null;
}

export function mountThe402Rail(app, capabilities) {
  const apiKey        = process.env.THE402_API_KEY;
  const webhookSecret = process.env.THE402_WEBHOOK_SECRET;

  if (!apiKey) {
    console.warn("[the402-rail] THE402_API_KEY not set — webhook route mounted but callbacks will fail");
  }
  if (!webhookSecret) {
    console.warn("[the402-rail] THE402_WEBHOOK_SECRET not set — HMAC verification disabled until set");
  }

  const capMap = new Map(capabilities.map(c => [c.name, c]));

  app.post(
    "/v1/the402-webhook",
    express.raw({ type: "*/*", limit: "256kb" }),
    async (req, res) => {
      const rawBody  = req.body?.toString("utf8") ?? "";
      const timestamp = req.headers["x-webhook-timestamp"];
      const signature = req.headers["x-webhook-signature"];

      // HMAC verification — skip only if secret not yet configured (initial setup)
      if (webhookSecret) {
        if (!timestamp || !signature) {
          logEntry({ ts: new Date().toISOString(), event: "auth_fail", reason: "missing_headers" });
          return res.status(401).json({ error: "missing signature headers" });
        }

        const now = Math.floor(Date.now() / 1000);
        if (Math.abs(now - parseInt(timestamp, 10)) > MAX_TIMESTAMP_SKEW_SEC) {
          logEntry({ ts: new Date().toISOString(), event: "auth_fail", reason: "stale_timestamp", timestamp });
          return res.status(401).json({ error: "stale timestamp" });
        }

        if (!verifyHmac(webhookSecret, timestamp, rawBody, signature)) {
          logEntry({ ts: new Date().toISOString(), event: "auth_fail", reason: "invalid_hmac" });
          return res.status(401).json({ error: "invalid signature" });
        }
      }

      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return res.status(400).json({ error: "invalid JSON" });
      }

      // Health probe from the402 service test endpoint
      if (payload.test === true) {
        logEntry({ ts: new Date().toISOString(), event: "test_ping", service_id: payload.service_id });
        return res.status(200).json({ ok: true, test: true, provider: "the-stall" });
      }

      if (payload.type !== "job_dispatch") {
        return res.status(400).json({ error: `unknown type: ${payload.type}` });
      }

      const { job_id, service_name, brief, callback_url } = payload;

      // Acknowledge immediately — the402 has a short response-time window
      res.status(200).json({ ok: true, job_id, status: "processing" });

      // Response already sent above — nothing below this point may throw
      // synchronously or reject without being caught, or it takes down the
      // whole process (unhandled rejection after headers-sent isn't
      // recoverable by Express). Guard the entire continuation.
      try {
        const cap = findCap(service_name, capMap);
        if (!cap) {
          logEntry({ ts: new Date().toISOString(), event: "cap_not_found", service_name, job_id });
          if (apiKey && callback_url) {
            await postCallback(callback_url, apiKey, {
              status: "failed",
              result: { error: "capability_not_found" },
              message: `No STALL cap matches service: ${service_name}`,
            });
          }
          return;
        }

        const startMs = Date.now();
        let result, status, message;

        try {
          result  = await cap.handler(brief ?? {});
          status  = "completed";
          message = `${cap.name} executed in ${Date.now() - startMs}ms`;
        } catch (err) {
          result  = { error: err.message };
          status  = "failed";
          message = `Cap error: ${String(err.message).slice(0, 200)}`;
        }

        logEntry({
          ts: new Date().toISOString(),
          event: status,
          cap: cap.name,
          service_name,
          job_id,
          duration_ms: Date.now() - startMs,
          error: status === "failed" ? result.error : undefined,
        });

        if (apiKey && callback_url) {
          await postCallback(callback_url, apiKey, { status, result, message });
        }
      } catch (err) {
        logEntry({
          ts: new Date().toISOString(),
          event: "unhandled_error",
          service_name,
          job_id,
          error: String((err && err.message) || err),
        });
      }
    }
  );

  console.log("[the402-rail] Webhook handler active at POST /v1/the402-webhook");
}
