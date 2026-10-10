import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROFILE = 'stall-tools-v1:sorted-names,sorted-keys,compact-json,utf8';
export const BASELINE = new URL('../manifests/mcp-tools.json', import.meta.url);
export const EVIDENCE = new URL('../.artifacts/mcp-manifest/', import.meta.url);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Object keys and the outer tool array are unordered. Preserve every nested
// array and every advertised field; do not silently discard new metadata.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  assert.notEqual(encoded, undefined, 'Manifest must contain JSON values');
  return encoded;
}

export function canonicalTools(tools) {
  assert.ok(Array.isArray(tools) && tools.length, 'Missing or empty tools array');
  const names = new Set();
  for (const tool of tools) {
    assert.ok(tool && typeof tool.name === 'string' && tool.name.trim(), 'Invalid tool name');
    assert.ok(!names.has(tool.name), `Duplicate tool name: ${tool.name}`);
    assert.equal(typeof tool.description, 'string', `Missing description: ${tool.name}`);
    assert.ok(tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema), `Missing inputSchema: ${tool.name}`);
    names.add(tool.name);
  }
  return [...tools].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

export function toolsFromResponse(json, id = 2) {
  assert.equal(json?.jsonrpc, '2.0', 'Invalid JSON-RPC version');
  assert.equal(json.id, id, 'Unexpected JSON-RPC response id');
  assert.ok(!json.error, 'tools/list returned a JSON-RPC error');
  assert.ok(!json.result?.nextCursor, 'Paginated manifest is incomplete');
  canonicalTools(json.result?.tools);
  return json.result.tools;
}

export function observation(tools, metadata) {
  const sorted = canonicalTools(tools);
  return {
    format: 1,
    profile: PROFILE,
    ...metadata,
    toolCount: sorted.length,
    toolsSha256: sha256(canonicalJson(sorted)),
    // Reference hashes preserve response order. ASCII escaping matches the
    // common Python json.dumps(sort_keys=True, separators=(',', ':')) recipe.
    orderedUtf8Sha256: sha256(canonicalJson(tools)),
    orderedAsciiSha256: sha256(canonicalJson(tools).replace(/[\u007f-\uffff]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)),
    tools: sorted,
  };
}

export function validateSnapshot(snapshot) {
  assert.equal(snapshot?.format, 1, 'Unsupported manifest format');
  assert.equal(snapshot.profile, PROFILE, 'Unsupported canonicalization profile');
  const sorted = canonicalTools(snapshot.tools);
  assert.equal(snapshot.toolCount, sorted.length, 'Manifest count mismatch');
  assert.equal(snapshot.toolsSha256, sha256(canonicalJson(sorted)), 'Manifest hash mismatch');
  return snapshot;
}

const pointer = key => key.replace(/~/g, '~0').replace(/\//g, '~1');
function fields(before, after, path = '') {
  if (canonicalJson(before) === canonicalJson(after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(key => {
      const at = `${path}/${pointer(key)}`;
      if (!Object.hasOwn(before, key)) return [{ path: at, kind: 'added', after: after[key] }];
      if (!Object.hasOwn(after, key)) return [{ path: at, kind: 'removed', before: before[key] }];
      return fields(before[key], after[key], at);
    });
  }
  return [{ path, kind: 'changed', before, after }];
}

export function compare(before, after) {
  validateSnapshot(before);
  validateSnapshot(after);
  assert.ok(before.release?.id && before.release?.reason, 'Baseline needs an explicit release id and reason');
  assert.equal(after.endpoint, before.endpoint, 'Baseline belongs to a different endpoint');
  const old = new Map(before.tools.map(tool => [tool.name, tool]));
  const current = new Map(after.tools.map(tool => [tool.name, tool]));
  const added = [...current.keys()].filter(name => !old.has(name)).sort();
  const removed = [...old.keys()].filter(name => !current.has(name)).sort();
  const changed = [...old.keys()].filter(name => current.has(name)).sort().flatMap(name => {
    const changes = fields(old.get(name), current.get(name));
    return changes.length ? [{ name, changes }] : [];
  });
  const matches = !added.length && !removed.length && !changed.length;
  return {
    status: matches ? 'matches-recorded-baseline' : 'unreviewed-interface-change',
    matches,
    baselineRelease: before.release,
    beforeSha256: before.toolsSha256,
    afterSha256: after.toolsSha256,
    observedAt: after.observedAt,
    added, removed, changed,
  };
}

// One complete tool per line keeps a full public contract easy to review in git.
export function writeSnapshot(path, snapshot) {
  validateSnapshot(snapshot);
  const { tools, ...metadata } = snapshot;
  const header = JSON.stringify(metadata, null, 2).slice(0, -2);
  writeFileSync(path, `${header},\n  "tools": [\n${tools.map(tool => `    ${canonicalJson(tool)}`).join(',\n')}\n  ]\n}\n`);
}

export function recordComparison(baseline, observed, directory = EVIDENCE) {
  const diff = compare(baseline, observed);
  mkdirSync(directory, { recursive: true });
  const dir = directory instanceof URL ? fileURLToPath(directory) : directory;
  writeSnapshot(join(dir, 'observed.json'), observed);
  writeFileSync(join(dir, 'diff.json'), `${JSON.stringify(diff, null, 2)}\n`);
  return diff;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, input, output, releaseId, reason, ...extra] = process.argv.slice(2);
  assert.ok(!extra.length, 'Too many arguments');
  if (command === 'compare') {
    assert.ok(input && output && !releaseId, 'Usage: compare BASELINE OBSERVED');
    const diff = compare(JSON.parse(readFileSync(input, 'utf8')), JSON.parse(readFileSync(output, 'utf8')));
    console.log(JSON.stringify(diff, null, 2));
    process.exitCode = diff.matches ? 0 : 1;
  } else if (command === 'baseline') {
    assert.ok(input && output && releaseId?.trim() && reason?.trim(), 'Usage: baseline OBSERVED OUTPUT RELEASE_ID REASON');
    const snapshot = validateSnapshot(JSON.parse(readFileSync(input, 'utf8')));
    assert.ok(snapshot.endpoint && snapshot.observedAt && snapshot.responseSha256, 'Baseline needs capture provenance');
    writeSnapshot(output, { ...snapshot, release: { id: releaseId, reason } });
    console.log('Baseline written for git review; no release approval or live changes implied.');
  } else {
    throw new Error('Usage: mcp-manifest.mjs compare BASELINE OBSERVED | baseline OBSERVED OUTPUT RELEASE_ID REASON');
  }
}
