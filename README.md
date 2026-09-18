# The Stall

**Machine-payable data capabilities from IntuiTek¹ — founded by W. Kyle Million (~K¹).**

The Stall exposes individually priced tools over HTTP and MCP. Buyers can inspect the catalog without a merchant API key and pay for supported calls in USDC on Base using x402. A payment-capable buyer, its own wallet authorization and sufficient funds are still required.

**Service:** `https://the-stall.intuitek.ai` · **MCP:** `https://the-stall.intuitek.ai/mcp`

## Start here: a buyer that can actually pay

A plain MCP connection can discover tools. It cannot automatically pay just because the tools appear in a client. Use the [current integrator guide](STALL_INTEGRATORS.md) and the [budget-limited MCP buyer](examples/stall-buyer.mjs).

```bash
# Free quote only. Does not load a signing key or send a payment.
node examples/stall-buyer.mjs quote earnings-calendar '{"days_ahead":7,"limit":5}'
```

The script uses the existing repository dependencies. Paid mode additionally requires the buyer's own securely supplied wallet key, an explicit per-call ceiling, and a durable receipt path. It will not silently retry an uncertain payment. The guide explains those controls and provides the complete purchase command.

## Live catalog, not a frozen price table

The September 18, 2026 unsigned observation found **301 capabilities** and **302 MCP tools**, including payment negotiation. These are dated availability observations, not a promise that every source is healthy or that every response satisfies a buyer's task.

| Resource | Purpose |
|---|---|
| [Catalog](https://the-stall.intuitek.ai/catalog) | Current capabilities, prices, input/output schemas |
| [OpenAPI](https://the-stall.intuitek.ai/openapi.json) | HTTP operations and payment contract |
| [Agent card](https://the-stall.intuitek.ai/.well-known/agent.json) | Agent-facing discovery |
| [x402 manifest](https://the-stall.intuitek.ai/.well-known/x402) | Payment/discovery metadata |
| [Payment methods](https://the-stall.intuitek.ai/v1/payment-methods) | Declared rail status and negotiation |
| [Health](https://the-stall.intuitek.ai/health) | Service health, not economic success |

Examples include earnings-calendar, market-breadth, aviation-weather, vision-analyze and research-paper-search. **Use the current unsigned challenge as the quote.** The earlier static tables mixed obsolete prices and capability counts; they are no longer an authorization source.

## Payment contracts

**HTTP x402 v2:** an unsigned capability call returns HTTP 402. Decode `PAYMENT-REQUIRED`, validate its terms, and let the buyer's wallet client create a v2 payment payload. Retry the same operation using `PAYMENT-SIGNATURE`. The Base network identifier is `eip155:8453`; amounts are token atomic units, not floating-point dollars.

**MCP x402:** `tools/list` is free. An unpaid `tools/call` can return HTTP 200 with an error-marked tool result containing the x402 challenge. A compatible client attaches payment at `params._meta["x402/payment"]`. HTTP 200 alone is not proof of paid fulfillment.

**Other rails:** follow the current payment-method registry. Configured checkout, a discovery listing, or a historical test is not proof that a given acquisition route works for this buyer. Unsupported rails must not become free fallbacks.

## Buyer integration tests

```bash
node --test tests/test_buyer_entry.mjs
node --test examples/stall-buyer-sdk.test.mjs
```

Tests cover exact atomic budgets, intended recipient and network, challenge parsing, single authorization, durable uncertain-attempt handling, and receipt/error distinctions. The SDK test is local and synthetic; it does not settle a real payment.

The bounded GitHub verification workflow inspects public discovery and unsigned HTTP/MCP challenges without wallet keys or funded requests. Diagnostic traffic is not counted as customer demand.

## Architecture and deployment boundary

`src/server.js` serves the capability chassis; capability modules provide their contracts and handlers. Payment verification and settlement belong to the seller runtime; the buyer example does not bypass or replace them. The proprietary selection/operations layer is separate from this public interface.

The production service is operated through its existing native deployment procedure. **A GitHub push is not a production STALL deployment.** This buyer-entry repair changes public documentation and client tooling, not production routing, prices, source handlers or spending limits.

The previous README remains available in [Git history](https://github.com/thebrierfox/the-stall/blob/4d4e877fe192555f3f9758fde7fd307cff5f10b9/README.md). Its historical prices, capability counts, deployment examples and competitor comparisons must not be treated as current integration instructions.

## Revenue objective

External discovery → qualified selection → authorized payment → paid fulfillment → reconciled settlement → positive contribution → recurrence. API traffic, tests, self-payments, catalog size and a successful build are not substitutes for those economic outcomes.

*IntuiTek¹ · W. Kyle Million / ~K¹ · autonomous infrastructure for the agentic economy.*
