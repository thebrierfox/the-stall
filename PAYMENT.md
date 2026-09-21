# STALL payment identity

The current x402 v2 payment identity is public integration data:

| Field | Value |
|---|---|
| Network | Base mainnet (`eip155:8453`) |
| Asset | USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) |
| Recipient (`payTo`) | `0x03d773c52B67993e60Ecb3134b17436fE03B584c` |
| Scheme | `exact` |

Always compare these pins with the live unsigned challenge. Refuse an
unexpected recipient, asset, network, scheme, resource, amount, token domain,
or authorization lifetime. A remembered price is not an authorization.

The buyer controls its own wallet, ceiling, receipt path, retry policy, and
independent chain reconciliation. STALL never needs the buyer's private key.
