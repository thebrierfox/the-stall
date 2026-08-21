// Non-sensitive request attribution for the existing Task 002 placement.
// Attribution never makes a request demand-qualified; it only preserves how a
// request reached the existing route. Unknown and test traffic fail closed.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

const storage = new AsyncLocalStorage();
const TARGET_PATH = "/cap/defi-yield-strategies";
const TARGET_CANDIDATE = "cand_0ad825bcd28d002d";
const TARGET_CHANNEL = "awesome-x402-services";
const TARGET_PLACEMENT = "awesome-x402-services-readme";
const REGISTRY_PATH = process.env.ARDE_ATTRIBUTION_REGISTRY
  || "/home/aegis/intuitek/the-stall/config/experiment-attribution.json";
const MARKER_KEYS = Object.freeze({
  candidate: "genie_candidate",
  channel: "genie_channel",
  placement: "genie_placement",
  test: "genie_test_probe",
});

export const ATTRIBUTION_INSTRUMENTED_AT = new Date().toISOString();

const DEFAULT_PLACEMENT = Object.freeze({
  candidate_id: TARGET_CANDIDATE,
  channel_id: TARGET_CHANNEL,
  placement_id: TARGET_PLACEMENT,
  route_path: TARGET_PATH,
  active: true,
  trusted_referer_tokens: ["kylemillion", "awesome-x402-services"],
});
let registryCache = { mtimeMs: null, placements: [DEFAULT_PLACEMENT] };

function activePlacements() {
  try {
    const mtimeMs = statSync(REGISTRY_PATH).mtimeMs;
    if (registryCache.mtimeMs !== mtimeMs) {
      const parsed = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
      const placements = Array.isArray(parsed?.placements)
        ? parsed.placements.filter((item) => item && item.active === true)
        : [];
      registryCache = { mtimeMs, placements };
    }
  } catch {
    registryCache = { mtimeMs: null, placements: [DEFAULT_PLACEMENT] };
  }
  return registryCache.placements;
}

function clipped(value, max = 300) {
  if (value === undefined || value === null) return null;
  return String(value).slice(0, max);
}

function sanitizedUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value));
    return `${parsed.origin}${parsed.pathname}`.slice(0, 500);
  } catch {
    return null;
  }
}

function operatorSignal(ip, userAgent) {
  if (!ip && !userAgent) return null;
  return "opsig_" + createHash("sha256")
    .update(`stall-observation-v1|${ip || ""}|${userAgent || ""}`)
    .digest("hex")
    .slice(0, 24);
}

function trustedPlacementReferer(referer, placement) {
  if (!referer) return false;
  try {
    const parsed = new URL(referer);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    const tokens = placement?.trusted_referer_tokens || [];
    return (host === "github.com" || host === "raw.githubusercontent.com")
      && tokens.length > 0
      && tokens.every((item) => path.includes(String(item).toLowerCase()));
  } catch {
    return false;
  }
}

function queryValue(req, key) {
  const value = req?.query?.[key];
  return Array.isArray(value) ? value[0] : value;
}

export function buildObservationContext(req) {
  const requestId = `req_${randomUUID()}`;
  const userAgent = clipped(req?.get?.("user-agent"), 240);
  const refererRaw = req?.get?.("referer") || req?.get?.("referrer") || null;
  const referer = sanitizedUrl(refererRaw);
  const origin = sanitizedUrl(req?.get?.("origin"));
  const candidateMarker = clipped(queryValue(req, MARKER_KEYS.candidate), 96);
  const channelMarker = clipped(queryValue(req, MARKER_KEYS.channel), 96);
  const placementMarker = clipped(queryValue(req, MARKER_KEYS.placement), 128);
  const placements = activePlacements();
  const attributionEligiblePath = placements.some((item) => item.route_path === req?.path)
    || req?.path === "/mcp"
    || req?.path === "/messages";
  const explicitPlacement = attributionEligiblePath && placements.find((item) =>
    candidateMarker === item.candidate_id
    && channelMarker === item.channel_id
    && placementMarker === item.placement_id
    && (req?.path === item.route_path || req?.path === "/mcp" || req?.path === "/messages")
  );
  const partialMarker = Boolean(candidateMarker || channelMarker || placementMarker);
  const refererPlacements = attributionEligiblePath && !partialMarker
    ? placements.filter((item) =>
        (req?.path === item.route_path || req?.path === "/mcp" || req?.path === "/messages")
        && trustedPlacementReferer(refererRaw, item))
    : [];
  const refererPlacement = refererPlacements.length === 1 ? refererPlacements[0] : null;
  const testProbeId = clipped(queryValue(req, MARKER_KEYS.test), 32);
  const expectedTestUserAgentPrefix = Object.freeze({
    task007: "GENIE-Task007-NonDemand-Probe/",
    task008: "GENIE-Task008-NonDemand-Probe/",
    task009: "GENIE-Task009-NonDemand-Probe/",
  })[testProbeId];
  const testProbe = Boolean(expectedTestUserAgentPrefix)
    && req?.get?.("x-genie-test-probe") === testProbeId
    && String(userAgent || "").startsWith(expectedTestUserAgentPrefix);

  let attributionMethod = "UNKNOWN";
  let attributionConfidence = "none";
  let candidateId = null;
  let channelId = null;
  let placementId = null;
  if (explicitPlacement) {
    attributionMethod = "explicit_deterministic_query_marker";
    attributionConfidence = "deterministic";
    candidateId = explicitPlacement.candidate_id;
    channelId = explicitPlacement.channel_id;
    placementId = explicitPlacement.placement_id;
  } else if (refererPlacement && !partialMarker) {
    attributionMethod = "trusted_referer";
    attributionConfidence = "high";
    candidateId = refererPlacement.candidate_id;
    channelId = refererPlacement.channel_id;
    placementId = refererPlacement.placement_id;
  } else if (partialMarker) {
    attributionMethod = "INVALID_OR_INCOMPLETE_MARKER";
    attributionConfidence = "none";
  }

  return Object.freeze({
    request_id: requestId,
    challenge_id: `httpch_${createHash("sha256").update(requestId).digest("hex").slice(0, 24)}`,
    candidate_id: candidateId,
    channel_id: channelId,
    placement_id: placementId,
    attribution_method: attributionMethod,
    attribution_confidence: attributionConfidence,
    attribution_instrumented_at: ATTRIBUTION_INSTRUMENTED_AT,
    operator_signal: operatorSignal(req?.ip, userAgent),
    user_agent: userAgent,
    referer,
    origin,
    is_test_probe: testProbe,
    classification: testProbe ? "NON_DEMAND_TEST" : "UNADJUDICATED",
    demand_qualified: false,
  });
}

export function attachObservationContext(req, res, next) {
  const context = buildObservationContext(req);
  req._observationContext = context;
  res.setHeader("X-Stall-Request-Id", context.request_id);
  next();
}

export function requestLogRecord(req, status, elapsedMs) {
  const context = req?._observationContext || buildObservationContext(req);
  return {
    ts: new Date().toISOString(),
    method: clipped(req?.method, 16),
    path: clipped(req?.path, 500),
    status,
    ip: req?.ip || "unknown", // legacy field retained for existing classifiers
    ua: context.user_agent || "", // legacy field retained for existing readers
    ms: elapsedMs,
    ...context,
  };
}

export function runWithAttribution(context, callback) {
  return storage.run(context || null, callback);
}

export function currentAttribution() {
  return storage.getStore() || null;
}

export function observationFields(context) {
  if (!context) return {};
  return {
    request_id: context.request_id,
    challenge_id: context.challenge_id,
    candidate_id: context.candidate_id,
    channel_id: context.channel_id,
    placement_id: context.placement_id,
    attribution_method: context.attribution_method,
    attribution_confidence: context.attribution_confidence,
    attribution_instrumented_at: context.attribution_instrumented_at,
    operator_signal: context.operator_signal,
    is_test_probe: context.is_test_probe,
    classification: context.classification,
    demand_qualified: false,
  };
}

export const TASK002_ATTRIBUTION_CONTRACT = Object.freeze({
  target_path: TARGET_PATH,
  candidate_id: TARGET_CANDIDATE,
  channel_id: TARGET_CHANNEL,
  placement_id: TARGET_PLACEMENT,
  marker_keys: MARKER_KEYS,
  qualification_effect: "NONE",
  unknown_behavior: "UNKNOWN_NON_QUALIFYING",
  test_behavior: "NON_DEMAND_TEST",
});

export const EXPERIMENT_ATTRIBUTION_REGISTRY = Object.freeze({
  registry_path: REGISTRY_PATH,
  marker_keys: MARKER_KEYS,
  qualification_effect: "NONE",
  inactive_or_unknown_behavior: "UNKNOWN_NON_QUALIFYING",
});
