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
curl -i 'https://the-stall.intuitek.ai/cap/balance-sheet?ticker=AAPL'
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
node examples/stall-buyer.mjs quote balance-sheet '{"ticker":"AAPL","period":"quarterly"}'
```

Read [INTEGRATION.md](INTEGRATION.md) for MCP and HTTP payment details. The
public/private boundary is documented in [PUBLIC_BOUNDARY.md](PUBLIC_BOUNDARY.md).

## Coinbase Agentic Wallet CLI

A Coinbase wallet agent can request a sourced check on a company's liquidity,
debt, and equity from the `balance-sheet` capability before an investment
decision. The result identifies its SEC EDGAR Companyfacts source, filing
periods, and retrieval time. It is filing data, not a trading recommendation.

First inspect the live catalog and the unsigned `402` quote above. After the
buyer has authenticated and set wallet spending limits, the [Coinbase CLI](https://docs.cdp.coinbase.com/agentic-wallet/cli/skills/pay-for-service)
can make a bounded paid request with the same wallet:

```bash
npx awal@latest x402 pay https://the-stall.intuitek.ai/cap/balance-sheet \
  -q '{"ticker":"AAPL","period":"quarterly","limit":4}' \
  --max-amount 21000
```

`21000` is an upper bound of 0.021 USDC in atomic units, not permission to
accept a different recipient or network. If the live quote exceeds that ceiling,
the call must stop. See [PAYMENT.md](PAYMENT.md) for the expected Base USDC
recipient. The buyer decides whether to authorize a payment.

## Current acceptance baseline

The public verification command checks the live contract without paying:

```bash
npm run verify:live
```

The September 26, 2026 baseline is health `200`, catalog `200` with 301 paid
capabilities, unsigned HTTP `402`, MCP initialize/list success, and an MCP
unpaid-call challenge for the same Base USDC recipient and amount.

© 2026 W. Kyle Million / IntuiTek¹
