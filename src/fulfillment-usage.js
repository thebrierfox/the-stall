// Invocation-local counters only. No credentials, network, pricing or payment effects.
import { AsyncLocalStorage } from "node:async_hooks";
const usageContext = new AsyncLocalStorage();
const usageKey = Symbol("stall.fulfillment.usage");
const resultUsage = new WeakMap();
const selected = new Set(["market-breadth", "youtube-niche-intel", "earnings-calendar"]);

// A fresh scope also retains usage when a handler throws without an HTTP request.
export function withUsageContext(run) {
  return usageContext.run({ usage: null }, run);
}

export function currentUsageEvidence() {
  return snapshotUsage(usageContext.getStore()?.usage);
}

export function beginUsage(context, capability) {
  if (!selected.has(capability)) return null;
  const usage = { schema: "stall-upstream-usage/v1", capability, counters: {} };
  if (capability === "earnings-calendar") {
    usage.counters.alpha_vantage_calendar_http = { attempted: 0, completed: 0, successful: 0 };
  }
  const scope = usageContext.getStore();
  if (scope) scope.usage = usage;
  if (context?.req && typeof context.req === "object") context.req[usageKey] = usage;
  return usage;
}

export function recordAttempt(usage, name) {
  if (!usage) return;
  const count = usage.counters[name] ||= { attempted: 0, completed: 0, successful: 0 };
  count.attempted += 1;
}

export function recordResult(usage, name, successful) {
  const count = usage?.counters[name];
  if (!count) return;
  count.completed += 1;
  count.successful += Number(successful === true);
}

export function attachUsage(result, usage) {
  if (result && typeof result === "object" && usage) resultUsage.set(result, usage);
  return result;
}

export function usageEvidence(req) {
  const usage = req?.[usageKey] || (req && typeof req === "object" ? resultUsage.get(req) : null);
  return snapshotUsage(usage);
}

function snapshotUsage(usage) {
  if (!usage) return null;
  return { ...usage, ...(usage.source_observation ? { source_observation: { ...usage.source_observation } } : {}), counters: Object.fromEntries(Object.entries(usage.counters).map(([k, v]) => [k, { ...v }])) };
}
