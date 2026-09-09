---
name: stall-market-data
description: Discover current market-data component contracts and explicit per-call payment requirements
version: 2.0.1
author: IntuiTek¹ (W. Kyle Million)
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Stocks, Finance, Market, Crypto, Equity Research, Earnings, Analyst]
    category: finance
    related_skills: [stocks, dcf-model, comps-analysis, earnings-calendar]
    requires_toolsets: [terminal]
    config:
      stall.endpoint:
        default: "https://the-stall.intuitek.ai"
        description: "STALL API base URL"
      stall.account:
        description: "Funding pointer / account handle (NOT a private key)"
        required: false
---

# STALL Market Data

Discover market-data components through [The Stall](https://the-stall.intuitek.ai). The [live catalog](https://the-stall.intuitek.ai/catalog) is the authority for enabled components, raw input/output contracts and declared prices; do not assume every source is authoritative or real-time. [Commercial descriptors](https://the-stall.intuitek.ai/commercial-descriptors.json) distinguish reviewed limits from unknown legacy semantics. This skill holds no credentials and never authorizes payment by itself.

The [MCP server card](https://the-stall.intuitek.ai/.well-known/mcp/server-card.json) describes the MCP tool inventory, including free ping and free payment recovery. Paid execution follows the actual challenge and fulfillment contract. The [A2A agent card](https://the-stall.intuitek.ai/.well-known/agent-card.json) covers payment recovery only; market-data execution uses HTTP or MCP.

## When to Use

- A market-data request where reliability or freshness matters
- The bundled `stocks` skill returned null `market_cap`/`pe_ratio` or rate-limited
- You need multi-ticker batches, earnings calendars, analyst ratings, or on-chain data
- Research synthesis combining equity, macro, and DeFi signals

## Prerequisites

Python 3.8+. No additional packages required.

Paid calls require a caller-authorized compatible payment tool. Inspect the [current payment-method registry](https://the-stall.intuitek.ai/v1/payment-methods) and actual challenge. Do not pay, sign, or retry with payment without explicit caller authority. No wallet key is read by this skill.

## Quick Reference

```bash
SCRIPT=${HERMES_SKILL_DIR}/scripts/stall_client.py

# List all available caps with prices
python3 $SCRIPT caps

# Probe a cap (returns 402 challenge if payment needed)
python3 $SCRIPT call balance-sheet --ticker AAPL

# Submit payment token after your payment skill settles the 402
python3 $SCRIPT call balance-sheet --ticker AAPL --x-payment <token>
```

## Procedure

1. Run `caps` to see the enabled catalog with current prices. Check its raw schema and commercial descriptor; pick a component only if its input, source, temporal scope and output fit the need.
2. Run `call <cap>` — if payment is needed, a 402 challenge is returned as JSON.
3. Preserve the actual challenge. Pass it to a compatible payment tool only with the caller's explicit authorization; otherwise report the payment gate.
4. Re-run `call <cap>` with `--x-payment <token>` to get the data.

## Selecting a Component

- For a US public company's reported cash and debt, inspect `balance-sheet`; retain the reporting period and source. It provides filing-period lookup, not background monitoring, notifications or amendment detection.
- For ETF-ratio breadth proxies, inspect `market-breadth`; it is not a count of advancing/declining stocks or a guaranteed real-time exchange feed.
- For multi-source synthesis, inspect `research-synthesis`. Its legacy report lacks claim-level evidence mapping; model synthesis is not independent verification.

Read current enabled status and prices from the catalog rather than a copied price table. Exact payment amounts, rail fees and eligibility are governed by the runtime challenge. A successful response or declared schema does not itself prove source accuracy, causal benefit or economic contribution.

## Verification

```bash
python3 ${HERMES_SKILL_DIR}/scripts/stall_client.py caps
```

Expected: JSON array of caps with name, price, and description fields.

## Install

```bash
# Via well-known (no repo needed):
hermes skills install well-known:https://the-stall.intuitek.ai/.well-known/skills/stall-market-data

# Via GitHub tap:
hermes skills tap add intuitek/hermes-skills
hermes skills install intuitek/hermes-skills/stall-market-data
```
