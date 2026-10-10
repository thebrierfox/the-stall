# MCP manifest investigation — October 10, 2026

## Finding

The engineering concern is valid: a count-only check cannot detect changes to
descriptions or schemas at constant tool count. No actual schema regression,
execution access problem, or lost revenue was established by this investigation.
Issue #7 explicitly describes a monitoring offer, not a vulnerability report.

The reporter's 302-tool count and first four names agree with an independent
unsigned `tools/list` capture at **2026-10-10T17:03:38.900832Z**
(**12:03:38 p.m. America/Chicago**). The endpoint returned HTTP 200, one complete
302-tool array, and no pagination cursor. No paid tool was executed.

The reported capture time is **2026-10-10T00:01Z**. Its original JSON has not
been obtained. The supplied hash does not match either common interpretation
of compact sorted-key JSON applied to our later response:

| Serialization of the tools array, preserving response order | SHA-256 |
| --- | --- |
| Reporter, exact encoding unspecified | `f2b042e114d64f4316d499218b4de1707a399f2bd31d0bd0a71b84fef5067fc1` |
| Python `json.dumps`, sorted keys, compact separators, default ASCII escaping | `d54efeb9319cd6b97f12dbda694717fd7318a61d1f8b69d2b07b390619281f27` |
| Same, with `ensure_ascii=False`, UTF-8 bytes | `4ce37e7e8d536218291f4213a3c2a176651677e80e463326ab11c06579a70fcc` |
| Our explicitly defined profile, additionally sorting tool names | `4611271b8ec4d064da78d13ad94a812cf66f2fb9ed3e9b3f8d02785345f62431` |

The mismatch is an **unverified historical comparison**. Without the original
JSON and exact encoding, it cannot distinguish a content change from a hashing
method difference. Even a confirmed content change would need release evidence
before being classified as a regression. A separate ASCII variant with sorted
tool names was also checked and did not match the reporter.

## Independent evidence and scope

The complete later tool definitions and capture provenance are preserved in
`mcp-tools.json`, including the raw response fingerprint and request ID.
SHA-256 of that raw JSON-RPC response was
`d9faed51c33b761a5c76d263a8f6dd4303a145d0df00d5a3fafc024e9e533c3e`.
A later capture at **2026-10-10T17:09:28.634Z** matched this canonical baseline
with zero added, removed, or changed tools; the full unsigned live verifier
also passed at 17:09:29Z. The saved comparison retains the exact later time.

The public repository at `5766c53f54adca9f4df2065b010d1c0a2b858bd9` had no
manifest comparison. Its older `glama.json` is a different discovery surface:
301 definitions, without the free `stall-payment-negotiate` tool. Compared with
the live MCP view, all 301 shared tools differ in description, input schema,
execution metadata, and `_meta`; seven also differ in output schema and
annotations. That verifies differences between these two surfaces, not changes
since the reporter's capture. It is not a substitute for his original baseline.

The original 36 deterministic public tests and five independent, offline
canonicalization/mutation checks passed before implementation changes. The
original live verifier passed its existing discovery and unsigned payment
challenge assertions before this extension. After the extension, all 58 tests
passed, including equal-count mutations, malformed captures, evidence output,
explicit release updates, the full verifier's same-count failure path, and the
original buyer protections.

Only the public verification, baseline evidence, documentation, and existing
CI workflow are extended. Seller code, prices, permissions, signing,
settlement, and payment protections are outside this change.

## Assessment of the offer

Public tool discovery is expected, and a correct tool count does not prove a
problem. The issue offers a private baseline for free and separately offers
monitoring at $29/server/month, without a guaranteed detection interval. Its
public monitoring page describes schema/description comparison rather than a
security audit. These observations support treating the issue as commercial
outreach about a legitimate engineering concern; they do not independently
certify the operator or justify calling the offer a scam.

The public history API returned HTTP 403 during this investigation, so it
supplied no historical manifest evidence. No subscription, checkout, account,
outreach message, paid call, or recurring cost was authorized or created.

The replacement uses the existing push/PR checks. It is not continuous
monitoring: changes occurring between those runs are not detected until the
next check. Unexpected changes produce full field diffs and fail closed;
intentional changes require an explicit baseline update with release ID and
reason, reviewed in git.

Sources:

- [External issue #7](https://github.com/thebrierfox/the-stall/issues/7)
- [Original verifier, pinned](https://github.com/thebrierfox/the-stall/blob/5766c53f54adca9f4df2065b010d1c0a2b858bd9/scripts/verify-live.mjs)
- [Original integration guide, pinned](https://github.com/thebrierfox/the-stall/blob/5766c53f54adca9f4df2065b010d1c0a2b858bd9/INTEGRATION.md)
- [Public MCP endpoint](https://the-stall.intuitek.ai/mcp)
- [Monitoring offer](https://dominionobservatory.com/monitor)
