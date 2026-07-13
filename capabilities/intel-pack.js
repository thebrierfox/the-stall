// intel-pack.js — Bundled intelligence: market overview + top DeFi yields + prediction markets.
//
// StableEnrich play: "six sources, one API call" applied to STALL's three strongest
// signal streams. One x402 payment returns structured context across equities, DeFi,
// and prediction markets — useful for position-sizing, yield routing, or pre-decision
// sentiment. $0.09 vs $0.109 bought individually.

import marketOverview from "./market-overview.js";
import defiYields from "./defi-yields.js";
import predictionMarkets from "./prediction-markets.js";

export default {
  name: "intel-pack",
  price: "$0.110",

  description:
    "Three-source intelligence pack in one x402 call: stock market snapshot (SPY/QQQ/IWM/VIX/risk signal) + top DeFi yield pools by APY + top prediction markets by volume. Replaces three separate calls. $0.109 purchased individually; $0.09 as a pack. No inputs required.",

  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      market: {
        type: "object",
        description: "Equity snapshot from market-overview: SPY, QQQ, IWM, DIA, VIX, TNX, risk_posture.",
      },
      defi: {
        type: "object",
        description: "Top DeFi yield pools from defi-yields: top 10 by APY, min TVL $1M, all chains.",
      },
      prediction: {
        type: "object",
        description: "Top prediction markets from prediction-markets: top 10 by USDC volume.",
      },
      sources: {
        type: "array",
        items: { type: "string" },
        description: "Capability names included in this pack.",
      },
      generated_at: { type: "string", description: "ISO-8601 timestamp." },
      pack_version:  { type: "string" },
    },
  },

  async handler(query) {
    const [market, defi, prediction] = await Promise.all([
      marketOverview.handler({}),
      defiYields.handler({ limit: 10, min_tvl_usd: 1_000_000 }),
      predictionMarkets.handler({ limit: 10 }),
    ]);

    return {
      market,
      defi,
      prediction,
      sources: ["market-overview", "defi-yields", "prediction-markets"],
      generated_at: new Date().toISOString(),
      pack_version: "1.0",
    };
  },
};
