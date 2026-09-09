---
name: stall-research-funnel
description: Turn targeted paper or repository discovery into cross-source research synthesis through The Stall
version: 1.0.1
author: IntuiTek¹ (W. Kyle Million)
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Research, Papers, GitHub, Synthesis, x402]
    category: research
    related_skills: [stall-market-data]
    requires_toolsets: [terminal]
    config:
      stall.endpoint:
        default: "https://the-stall.intuitek.ai"
        description: "STALL API base URL"
---

# STALL Research Funnel

Use The Stall's bounded discovery-to-synthesis workflow when a research question benefits from targeted paper or repository discovery followed by a deeper cross-source report. The [public funnel manifest](https://the-stall.intuitek.ai/research-funnel.json) supplies current request templates and registry-derived per-call prices. Consult the [catalog](https://the-stall.intuitek.ai/catalog) for raw input/output contracts and the [commercial descriptors](https://the-stall.intuitek.ai/commercial-descriptors.json) for reviewed limits or explicit unknown legacy semantics. The actual payment challenge governs rail-specific amounts, fees and eligibility.

HTTP and [MCP](https://the-stall.intuitek.ai/.well-known/mcp/server-card.json) execute components. [A2A](https://the-stall.intuitek.ai/.well-known/agent-card.json) is payment recovery only, not research execution. This caller-operated sequence is not a separately admitted research product, an ongoing monitor or a notification service.

## Safety and payment boundary

- Fetching the catalog, funnel manifest, and skill files is free.
- Capability calls are paid and return HTTP 402 until an authorized payment is attached.
- Never invent a payment token, read a wallet key, or pay without the caller's authorization.
- This skill holds no credentials and does not guarantee a research or conversion outcome.
- The legacy `research-synthesis` output does not provide claim-level evidence mapping. Source material may predate execution, and model synthesis is not independent verification.

## Procedure

1. Fetch `https://the-stall.intuitek.ai/research-funnel.json` and confirm all three steps are available.
2. Choose exactly one discovery step:
   - `research-paper-search` for papers and scholarly sources.
   - `github-intel` for repositories, projects, and implementation evidence.
3. Probe the selected discovery capability with the original topic. Preserve the HTTP 402 challenge for the caller's payment tool.
4. After authorized settlement, capture the discovery result and keep the original topic.
5. Form the `research-synthesis` query from the original topic plus a concise summary of the returned findings. Use the manifest's suggested focus unless the caller supplied another focus.
6. Probe `research-synthesis`, settle only with separate authorization, and return the actual response with its source and verification limitations. Do not call the report independently verified merely because execution succeeded.

## Quick reference

```bash
SCRIPT=${HERMES_SKILL_DIR}/scripts/stall_client.py

# Free, authoritative workflow and current prices
curl -fsS https://the-stall.intuitek.ai/research-funnel.json

# Discovery probes; each surfaces an HTTP-402 challenge without paying
python3 $SCRIPT call research-paper-search --query "AI agent protocols" --limit 5 --sort relevant
python3 $SCRIPT call github-intel --action search --query "AI agent protocols" --limit 10

# Synthesis probe after discovery; payment still requires explicit authorization
python3 $SCRIPT call research-synthesis --query "AI agent protocols and the verified discovery findings" --focus "cross-source synthesis, implications, risks, and recommendations"
```

## Verification

```bash
curl -fsS https://the-stall.intuitek.ai/.well-known/skills/index.json
curl -fsS https://the-stall.intuitek.ai/research-funnel.json
```

Expected: the skills index lists `stall-research-funnel`, and the funnel manifest reports the two discovery capabilities followed by `research-synthesis` with current prices and request templates.

## Install

```bash
hermes skills install well-known:https://the-stall.intuitek.ai/.well-known/skills/stall-research-funnel
```
