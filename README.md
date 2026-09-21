# The Stall

Hosted pay-per-call capabilities for agents and developers over MCP and HTTP
x402. The live service currently exposes **301 paid capabilities** with no
subscription or STALL API key required.

> This repository is the public integration and discovery surface. It does not
> contain the seller backend, capability implementations, supplier logic,
> settlement internals, pricing machinery, commercial strategy, runtime data,
> or operating configuration.

## Live endpoints

| Surface | URL |
|---|---|
| Service health | <https://the-stall.intuitek.ai/health> |
| Live catalog, prices, and schemas | <https://the-stall.intuitek.ai/catalog> |
| Streamable HTTP MCP | <https://the-stall.intuitek.ai/mcp> |
| Agent Card | <https://the-stall.intuitek.ai/.well-known/agent.json> |
| x402 discovery | <https://the-stall.intuitek.ai/.well-known/x402> |
| OpenAPI | <https://the-stall.intuitek.ai/openapi.json> |
| Payment methods | <https://the-stall.intuitek.ai/v1/payment-methods> |

The live catalog and the unsigned challenge returned for a specific request are
authoritative. Do not sign using a price copied from a README, search result,
cached registry page, or earlier quote.

## MCP connection

```json
{
  "mcpServers": {
    "the-stall": {
      "type": "streamable-http",
      "url": "https://the-stall.intuitek.ai/mcp"
    }
  }
}
```

MCP discovery is free. A paid tool call that has not supplied a valid x402
payment returns an MCP error result containing the payment challenge; it does
not return paid content.

## HTTP quote

```bash
curl -i 'https://the-stall.intuitek.ai/cap/market-breadth'
```

The expected unsigned response is HTTP `402` with an x402 v2
`PAYMENT-REQUIRED` header. Current settlement is exact USDC on Base
(`eip155:8453`). See [PAYMENT.md](PAYMENT.md) before authorizing a payment.

## Buyer examples

The included buyer is deliberately buyer-controlled: it validates the network,
asset, STALL recipient, exact amount, authorization lifetime, tool identity,
and an operator-supplied USDC ceiling before signing. Quote mode never loads a
signing key.

```bash
npm ci
npm test
node examples/stall-buyer.mjs quote earnings-calendar '{"days_ahead":7,"limit":5}'
```

Read [INTEGRATION.md](INTEGRATION.md) for MCP and HTTP payment details. The
public/private boundary is documented in [PUBLIC_BOUNDARY.md](PUBLIC_BOUNDARY.md).

## Current acceptance baseline

The public verification command checks the live contract without paying:

```bash
npm run verify:live
```

The September 21, 2026 baseline is health `200`, catalog `200` with 301 paid
capabilities, unsigned HTTP `402`, MCP initialize/list success, and an MCP
unpaid-call challenge for the same Base USDC recipient and amount.

© 2026 W. Kyle Million / IntuiTek¹
