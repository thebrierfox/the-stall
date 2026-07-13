// btc-miner-econ.js
//
// Bitcoin mining economics and fee-market game theory. Returns the data
// agents need to reason about BTC miner incentives, fee market pressure,
// upcoming difficulty adjustments, and pool concentration.
//
// Seam origin: btcnode.uk/api/game-theory → btcnode.uk/api/systems-theory
// (11 distinct wallets, 5 days persistence, [REDACTED]4, 2026-06-06).
//
// Free upstream: mempool.space public API (no auth, rate-limit tolerant).

const MEMPOOL = "https://mempool.space/api";
const UA      = "Mozilla/5.0 (compatible; the-stall/3.9; +https://intuitek.ai)";
const TIMEOUT = 10000;

async function get(path) {
  const r = await fetch(`${MEMPOOL}${path}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!r.ok) throw new Error(`mempool.space HTTP ${r.status}: ${path}`);
  return r.json();
}

function feePressureLabel(fastestFee) {
  if (fastestFee <= 2)  return "minimal";
  if (fastestFee <= 10) return "low";
  if (fastestFee <= 30) return "medium";
  if (fastestFee <= 80) return "high";
  return "extreme";
}

export default {
  name: "btc-miner-econ",
  price: "$0.100",

  description:
    "Bitcoin mining economics and fee-market game theory via mempool.space. Returns current fee rates and pressure tier, miner revenue split (subsidy vs fees), next difficulty adjustment (direction, magnitude, blocks remaining), mining pool concentration (top-3 hashrate share), and mempool backlog size. Useful for agents reasoning about BTC transaction timing, miner incentive structures, or on-chain network health.",

  inputSchema: {
    type: "object",
    properties: {
      include: {
        type: "string",
        enum: ["all", "fees", "difficulty", "pools", "mempool"],
        description: "Subset of data to return. 'all' returns every section (default). 'fees' = fee market only. 'difficulty' = next adjustment info only. 'pools' = pool hashrate distribution only. 'mempool' = backlog size only.",
      },
    },
    required: [],
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      block_height:  { type: "integer",  description: "Current Bitcoin chain tip block height." },
      fee_market:    { type: "object",   description: "Current fee rates and market pressure." },
      miner_revenue: { type: "object",   description: "Today's miner revenue split (subsidy vs fees)." },
      difficulty:    { type: "object",   description: "Next difficulty adjustment forecast." },
      pools:         { type: "object",   description: "Mining pool hashrate concentration (1-week window)." },
      mempool:       { type: "object",   description: "Current unconfirmed transaction backlog." },
      generated_at:  { type: "string",   description: "ISO-8601 timestamp of this snapshot." },
    },
  },

  async handler(query) {
    const inc = query.include || "all";

    const wants = (section) => inc === "all" || inc === section;

    // Kick off only the fetches we need, in parallel.
    const [
      height,
      fees,
      diff,
      pools,
      reward,
      mempool,
    ] = await Promise.all([
      get("/blocks/tip/height"),
      wants("fees") || wants("all")       ? get("/v1/fees/recommended")          : null,
      wants("difficulty") || wants("all") ? get("/v1/difficulty-adjustment")      : null,
      wants("pools") || wants("all")      ? get("/v1/mining/pools/1w")            : null,
      wants("fees") || wants("all")       ? get("/v1/mining/reward-stats/1d")     : null,
      wants("mempool") || wants("all")    ? get("/mempool")                        : null,
    ]);

    const out = {
      block_height: height,
      generated_at: new Date().toISOString(),
    };

    if (fees && reward) {
      const totalReward = parseInt(reward.totalReward || "0", 10);
      const totalFee    = parseInt(reward.totalFee    || "0", 10);
      const feeRatio    = totalReward > 0
        ? parseFloat((totalFee / totalReward * 100).toFixed(2))
        : null;

      out.fee_market = {
        fastest_fee_sat_vb:  fees.fastestFee,
        half_hour_fee_sat_vb: fees.halfHourFee,
        hour_fee_sat_vb:     fees.hourFee,
        economy_fee_sat_vb:  fees.economyFee,
        pressure:            feePressureLabel(fees.fastestFee),
      };

      out.miner_revenue = {
        total_reward_sat:     totalReward,
        total_fee_sat:        totalFee,
        total_tx_count:       parseInt(reward.totalTx || "0", 10),
        fee_to_reward_pct:    feeRatio,
        subsidy_to_reward_pct: feeRatio !== null ? parseFloat((100 - feeRatio).toFixed(2)) : null,
        game_theory_note:
          feeRatio !== null && feeRatio < 2
            ? "Fees are <2% of miner revenue — miners still depend almost entirely on block subsidy. Low censorship risk but subsidy halving will pressure this."
            : feeRatio !== null && feeRatio >= 10
            ? "Fees are ≥10% of miner revenue — healthy fee market reducing subsidy dependency."
            : "Fees contribute moderately to miner revenue.",
      };
    }

    if (diff) {
      const retargetMs = diff.estimatedRetargetDate;
      const daysLeft   = retargetMs
        ? parseFloat(((retargetMs - Date.now()) / 86400000).toFixed(1))
        : null;

      out.difficulty = {
        next_adjustment_pct:  parseFloat(diff.difficultyChange.toFixed(4)),
        direction:            diff.difficultyChange >= 0 ? "increasing" : "decreasing",
        blocks_remaining:     diff.remainingBlocks,
        days_remaining:       daysLeft,
        estimated_retarget_at: retargetMs ? new Date(retargetMs).toISOString() : null,
        next_retarget_height:  diff.nextRetargetHeight,
        progress_pct:          parseFloat(diff.progressPercent.toFixed(2)),
        avg_block_time_sec:    Math.round(diff.timeAvg / 1000),
      };
    }

    if (pools) {
      const totalBlocks = pools.blockCount || 1;
      const topPools = (pools.pools || []).slice(0, 5).map(p => ({
        name:               p.name,
        hashrate_share_pct: parseFloat(((p.blockCount / totalBlocks) * 100).toFixed(2)),
        block_count_1w:     p.blockCount,
      }));

      const top3Share = topPools.slice(0, 3).reduce((s, p) => s + p.hashrate_share_pct, 0);

      out.pools = {
        window:            "1 week",
        total_blocks:      pools.blockCount,
        top_pools:         topPools,
        top3_hashrate_pct: parseFloat(top3Share.toFixed(2)),
        concentration_note:
          top3Share > 51
            ? "Top 3 pools hold >51% of hashrate — theoretical majority attack risk if colluding."
            : top3Share > 35
            ? "Moderate concentration — top 3 pools hold >35% combined hashrate."
            : "Hashrate reasonably distributed across top pools.",
      };
    }

    if (mempool) {
      out.mempool = {
        unconfirmed_tx_count: mempool.count,
        backlog_vbytes:       mempool.vsize,
        total_fee_sat:        mempool.total_fee,
        avg_fee_rate_estimate: mempool.count > 0
          ? parseFloat((mempool.total_fee / mempool.vsize).toFixed(2))
          : null,
      };
    }

    return out;
  },
};
