# STALL integration guide

Base URL: `https://the-stall.intuitek.ai`

## 1. Discover the current contract

Use the live surfaces at request time:

- `/catalog` for capability names, current prices, and input/output schemas.
- `/mcp` for MCP `tools/list` and paid tool calls.
- `/.well-known/x402` for x402 resources and payment metadata.
- `/openapi.json` for HTTP operations.

The catalog currently contains 301 paid capabilities. MCP currently lists 302
tools because it also exposes a free catalog/discovery tool.

## 2. Request a quote before signing

An unsigned HTTP capability request returns `402 Payment Required`. For x402 v2,
decode the Base64 `PAYMENT-REQUIRED` header and validate the complete offer.

An unsigned MCP `tools/call` returns HTTP `200` with `result.isError: true` and
the x402 challenge in `result.structuredContent`. HTTP success at the transport
layer is not proof that the paid tool executed.

Validate at least:

- `x402Version` is `2`.
- `scheme` is `exact`.
- `network` is `eip155:8453`.
- `asset` is the expected Base USDC contract.
- `payTo` is the pinned STALL recipient in [PAYMENT.md](PAYMENT.md).
- `amount` is a decimal atomic-unit string within the buyer's explicit ceiling.
- `resource` identifies the intended URL or MCP tool.
- `maxTimeoutSeconds` is acceptable to the buyer.

## 3. Authorize one bounded attempt

For MCP, use a payment-capable x402 MCP client. The included
[`examples/stall-buyer.mjs`](examples/stall-buyer.mjs) uses the official x402
client packages and reserves a durable receipt file before signing.

```bash
# Quote only; no signing key is loaded.
node examples/stall-buyer.mjs quote balance-sheet '{"ticker":"AAPL","period":"quarterly"}'

# Paid mode: the operator supplies its own key through its secret manager.
export STALL_BUYER_PRIVATE_KEY='<buyer-owned key>'
node examples/stall-buyer.mjs pay \
  balance-sheet \
  '{"ticker":"AAPL","period":"quarterly"}' \
  0.021 \
  ./balance-sheet-job-001.receipt.jsonl
```

The ceiling is a buyer limit; check the current challenge before authorizing.
This example uses SEC EDGAR Companyfacts and returns reported filing periods,
not a trading recommendation.

Never place signing material in source, chat, issues, command history, or logs.
The example accepts one logical authorization per receipt path and blocks an
automatic second authorization.

## 4. Treat uncertain settlement as unresolved

A timeout, missing response, failed receipt write, or ambiguous client state is
not permission to pay again. Reconcile the original receipt and buyer wallet
before any separately authorized retry. A server-reported transaction hash is
not, by itself, an independently verified chain receipt.

On HTTP success, inspect `PAYMENT-RESPONSE` and the fulfillment body. On MCP
success, inspect both the payment response and the tool result. Failed
settlement must not be treated as successful delivery.

## 5. Card/prepaid access

Consult the live `/v1/payment-methods` registry for currently configured payment
methods. Do not assume that a checkout link, discovery record, or prepaid
purchase automatically authorizes an otherwise unpaid MCP call.

## Local verification

```bash
npm ci
npm test
npm run verify:live
```

The unit tests use an in-memory synthetic server and invalid synthetic signing
material. They make no real payment. `verify:live` performs unsigned discovery
and challenge checks only.
