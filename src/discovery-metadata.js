// Exact reviewed discovery copy. This layer never changes a capability's price,
// handler or schemas, and preserves newer source copy on either drift fence.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../config/discovery-metadata.v2.json", import.meta.url), "utf8"));
const descriptions = new Map();
let guidance;
for (const change of manifest.changes) {
  if (change.kind === "add_usage_guidance") {
    if (guidance !== undefined) throw new Error("duplicate discovery guidance");
    guidance = change.after;
    continue;
  }
  const name = change.path?.match(/^\/cap\/([a-z0-9-]+)$/)?.[1];
  if (!name || change.method !== "get" || change.field !== "summary" || descriptions.has(name)
      || change.expected_declared_price?.mode !== "fixed" || change.expected_declared_price?.currency !== "USD"
      || !/^[a-f0-9]{64}$/.test(change.before_text_sha256) || typeof change.after !== "string") {
    throw new Error("invalid reviewed discovery metadata entry");
  }
  descriptions.set(name, Object.freeze(change));
}
if (manifest.version !== 2 || descriptions.size !== 49 || typeof guidance !== "string") {
  throw new Error("invalid reviewed discovery metadata manifest");
}

export const DISCOVERY_GUIDANCE = guidance;

export function applyReviewedDiscoveryMetadata(cap, onDrift = (name, reason) => {
  console.warn(`[discovery-metadata] preserving ${name}: ${reason}`);
}) {
  const change = descriptions.get(cap.name);
  if (!change) return cap;
  if (cap.price !== `$${change.expected_declared_price.amount}`) {
    onDrift(cap.name, "declared price drift");
    return cap;
  }
  if (cap.description === change.after) return cap;
  if (typeof cap.description !== "string"
      || createHash("sha256").update(cap.description).digest("hex") !== change.before_text_sha256) {
    onDrift(cap.name, "source description drift");
    return cap;
  }
  return { ...cap, description: change.after };
}
