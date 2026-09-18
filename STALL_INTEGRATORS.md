# STALL Integrator Guide

**Machine-to-machine paid capabilities from IntuiTek¹ · W. Kyle Million, founder**

Base URL: `https://the-stall.intuitek.ai`. This guide describes the buyer integration, not a guarantee of demand, output quality, or profit. Updated September 18, 2026.

## Start with a quote, not a remembered price

The live catalog and unsigned payment challenge are authoritative for the requested call. Do not sign using prices copied from an old README, a search listing, or an earlier quote. On September 18 the earnings-calendar challenge was **10,000 USDC atoms = 0.010 USDC**, not the 0.001 USDC previously printed here.

- [`/catalog`](https://the-stall.intuitek.ai/catalog): current capabilities, prices and input/output schemas.
- [`/openapi.json`](https://the-stall.intuitek.ai/openapi.json): HTTP operations and current payment instructions.
- [`/.well-known/x402`](https://the-stall.intuitek.ai/.well-known/x402): payment and discovery metadata.
- [`/mcp`](https://the-stall.intuitek.ai/mcp): streamable HTTP MCP. Discovery is free; paid tool calls require a payment-capable buyer.

## MCP: connecting is not paying

A generic MCP URL configuration can enumerate tools but does not, by itself, create a wallet, authorize spending, or handle an x402 payment challenge. MCP may return **HTTP 200 with `result.isError: true` and an x402 challenge**; that is a denied tool call, not a fulfilled purchase.

Use the included [budget-limited buyer](examples/stall-buyer.mjs), backed by the official `@x402/mcp` client and `@x402/evm` signer. Run from a checkout with the repository dependencies installed. Quote mode does not load or require a signing key:

```bash
node examples/stall-buyer.mjs quote earnings-calendar '{"days_ahead":7,"limit":5}'
```

For a purchase, the **buyer/operator**, not STALL, supplies `STALL_BUYER_PRIVATE_KEY` through its own secret manager and admits its own budget. Do not paste signing material into chats, scripts, issues, or logs. With that environment set, this command permits at most 0.010 USDC for one logical call:

```bash
node examples/stall-buyer.mjs pay earnings-calendar '{"days_ahead":7,"limit":5}' 0.010 ./earnings-job-001.receipt.jsonl
```

The client checks the current v2 quote, exact Base USDC scheme, pinned STALL payee, amount ceiling, tool identity and maximum authorization duration **before signing**. It reserves the receipt file exclusively and blocks a second authorization. Reuse the same receipt path for the same logical operation; do not generate a new path merely to get around an uncertain earlier attempt.

A timeout or missing/failed receipt is **not permission to pay again**. The reservation stays on disk. Reconcile the original receipt and wallet before any separately authorized retry. The receipt reported by the server is not independently verified chain evidence; the client labels that distinction.

The implementation supports one Base USDC offer per challenge. Other currencies, multiple offers, negotiated credit rails and unrecognized token domains fail closed rather than being silently converted.

## HTTP x402 v2

```bash
curl -i 'https://the-stall.intuitek.ai/cap/earnings-calendar?days_ahead=7&limit=5'
```

Expected unsigned response: HTTP **402** and a Base64-encoded **`PAYMENT-REQUIRED`** header. Decode it as a v2 `PaymentRequired` object. The current Base offer uses `scheme: "exact"`, `network: "eip155:8453"`, the Base USDC contract, an atomic-unit `amount`, and `payTo`.

The buyer validates the offer against its own mandate, then uses its x402 wallet client to produce a **v2 `PaymentPayload`**. Retry the identical operation with that complete payload Base64-encoded in **`PAYMENT-SIGNATURE`**. Do not rename v1 fields, sign an old quote, send a bare signature, or substitute an unrelated transfer transaction hash.

`X-PAYMENT` is legacy transport, not the recommended v2 interface. STALL's September 17 compatibility adapter does not convert a v1 authorization into v2 or waive any payment requirement. MCP carries its payment payload in `params._meta["x402/payment"]`, not in an HTTP payment header for an ordinary tool call.

After successful settlement, the HTTP response uses `PAYMENT-RESPONSE`; the MCP SDK exposes its payment response separately from tool content. Inspect both the receipt and fulfillment/error state. Server-side execution can precede settlement internally; paid output must remain withheld when settlement fails.

## Choosing a useful call

These are integration examples, not pre-sold bundles or proven downstream outcomes. Retrieve current schemas and quotes for every step; a purchase of one step does not pay for later steps.

| Objective | Existing starting capability | Example input |
|---|---|---|
| Upcoming US earnings | `earnings-calendar` | `{"days_ahead":7,"limit":5}` |
| Market breadth context | `market-breadth` | Inspect current schema |
| Aviation weather | `aviation-weather` | Inspect current airport parameter |
| Research discovery | `research-paper-search` | Inspect current query schema |

The [research sequence](https://the-stall.intuitek.ai/research-funnel.json) describes separately paid components. Do not interpret it as an autonomous ongoing monitor or a guarantee that synthesized claims have been independently verified.

## Other payment methods

Consult the live [`/v1/payment-methods`](https://the-stall.intuitek.ai/v1/payment-methods) registry. A configured or discovery-only method is not proof of a completed acquisition/payment path. Do not assume that a hosted checkout link gives an otherwise unpaid MCP client automatic tool access.

## Verification

```bash
node --test tests/test_buyer_entry.mjs
node --test examples/stall-buyer-sdk.test.mjs
```

The SDK tests use an in-memory server and an invalid synthetic signature: **no on-chain payment**. Unsigned live checks prove discovery and paywall behavior, not outside-payer conversion. A valid paid production receipt, delivery evidence, cost coverage and recurrence are separate acceptance evidence.

Primary SDK reference: [official x402 MCP package](https://github.com/coinbase/x402/tree/main/typescript/packages/mcp). The repository's existing pinned/declared dependencies are used; no production payment middleware, price, source handler, reserve or routing setting is changed by this client.
