// btc-systems-theory.js
//
// Seven-lens systems theory analysis of the Bitcoin network.
// Seam origin: btcnode.uk/api/game-theory → btcnode.uk/api/systems-theory
// (11 distinct wallets, 1.0 strength, signal-intel archive 2026-06-06).
// Sister capability to btc-game-theory; purpose-built for systemic analysis.
//
// 7 lenses:
//   1. Feedback Loops    — difficulty adjustment as the dominant regulator
//   2. Stocks & Flows    — UTXO-equivalent mempool queue + throughput
//   3. Delays            — confirmation latency at current fee tier
//   4. Nonlinearity      — fee response to mempool fill; hash-rate growth curve
//   5. Nakamoto Coeff.   — minimum pools to collude for 50%+ of blocks
//   6. Self-Organization — fee market spontaneous order; pool-size emergence
//   7. Resilience        — HHI mining concentration; decentralization grade

const MEMPOOL = "https://mempool.space/api";
const UA      = "Mozilla/5.0 (compatible; the-stall/1.0; +https://intuitek.ai)";
const T       = 15_000;

async function get(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(T) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

// Nakamoto coefficient: fewest entities exceeding 50% of hashrate
function nakamotoCoeff(pools) {
  const sorted = [...pools].sort((a, b) => b.blockCount - a.blockCount);
  const total  = sorted.reduce((s, p) => s + p.blockCount, 0);
  let   cum    = 0;
  for (let i = 0; i < sorted.length; i++) {
    cum += sorted[i].blockCount;
    if (cum / total > 0.5) return i + 1;
  }
  return sorted.length;
}

// Herfindahl-Hirschman Index (0–10000). <1500 = competitive, >2500 = concentrated
function hhi(pools) {
  const total = pools.reduce((s, p) => s + p.blockCount, 0);
  return Math.round(pools.reduce((s, p) => s + Math.pow((p.blockCount / total) * 100, 2), 0));
}

// Estimate confirmation time in minutes for a given fee tier
// Uses mempool vsize and fee histogram to estimate queue depth at target fee
function estimateConfirmMinutes(mempoolData, targetFeeRateSatVb) {
  // Rough: 1 block per 10 min, ~1M vbytes per block
  const BLOCK_VSIZE = 1_000_000;
  const BLOCK_TIME_MIN = 10;
  const hist = mempoolData.fee_histogram ?? [];
  let vbytesAhead = 0;
  for (const [rate, vsize] of hist) {
    if (rate > targetFeeRateSatVb) vbytesAhead += vsize;
  }
  const blocksAhead = vbytesAhead / BLOCK_VSIZE;
  return Math.max(BLOCK_TIME_MIN, Math.round(blocksAhead * BLOCK_TIME_MIN));
}

function decentralizationGrade(n, hhiScore) {
  if (n >= 5 && hhiScore < 1500) return "A";
  if (n >= 4 && hhiScore < 2000) return "B";
  if (n >= 3 && hhiScore < 2500) return "C";
  if (n >= 2 && hhiScore < 3500) return "D";
  return "F";
}

export default {
  name:  "btc-systems-theory",
  price: "$0.100",

  description:
    "Seven-lens systems theory analysis of the Bitcoin network. Returns: (1) difficulty feedback loop state + regulator lag, (2) mempool stock-flow ratio and queue depth, (3) confirmation delay at economy/priority fee tiers, (4) fee nonlinearity index and hash-rate growth curvature, (5) Nakamoto coefficient (min pools for 51% consensus), (6) self-organization score for fee market equilibrium, (7) HHI mining concentration index and decentralization grade A–F. Sourced from mempool.space — no API key required. Pairs with btc-game-theory for full Bitcoin systems and incentive analysis.",

  inputSchema: {
    type: "object",
    properties: {
      pool_window: {
        type: "string",
        enum: ["24h", "3d", "1w", "1m"],
        description: "Rolling window for mining pool distribution. Default: 1w.",
        default: "1w",
      },
    },
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      lens_1_feedback: {
        type: "object",
        description: "Difficulty adjustment as the dominant feedback regulator.",
        properties: {
          state:              { type: "string", enum: ["TIGHTENING", "EASING", "NEUTRAL"] },
          projected_change_pct: { type: "number" },
          epoch_progress_pct: { type: "number" },
          blocks_to_retarget: { type: "integer" },
          retarget_eta_iso:   { type: "string" },
          regulator_lag_days: { type: "number", description: "Estimated days until adjustment corrects current hash-rate divergence." },
        },
      },
      lens_2_stocks_flows: {
        type: "object",
        description: "Mempool as stock; block throughput as flow.",
        properties: {
          mempool_tx_count:     { type: "integer" },
          mempool_vsize_mb:     { type: "number" },
          mempool_fee_btc:      { type: "number" },
          blocks_to_clear:      { type: "number", description: "Estimated blocks to clear mempool at current throughput." },
          flow_pressure:        { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
        },
      },
      lens_3_delays: {
        type: "object",
        description: "Transaction confirmation latency at different fee tiers.",
        properties: {
          economy_fee_sat_vb:           { type: "integer" },
          priority_fee_sat_vb:          { type: "integer" },
          est_economy_confirm_minutes:  { type: "integer" },
          est_priority_confirm_minutes: { type: "integer" },
        },
      },
      lens_4_nonlinearity: {
        type: "object",
        description: "Degree of nonlinear amplification in fee market and hash-rate growth.",
        properties: {
          fee_nonlinearity_ratio: {
            type: "number",
            description: "Ratio of fastest-to-economy fee rate. >4 = high nonlinearity (congestion premium); <2 = linear.",
          },
          hashrate_trend_ehs:    { type: "number", description: "Current 1-month average hash rate in EH/s." },
          hashrate_growth_state: { type: "string", enum: ["ACCELERATING", "STEADY", "DECELERATING"] },
        },
      },
      lens_5_nakamoto: {
        type: "object",
        description: "Minimum number of mining pools that could collude to exceed 50% of blocks.",
        properties: {
          nakamoto_coefficient: { type: "integer" },
          pool_window:          { type: "string" },
          total_pools:          { type: "integer" },
          top_pool_name:        { type: "string" },
          top_pool_share_pct:   { type: "number" },
          top_3_share_pct:      { type: "number", description: "Combined share of 3 largest pools (%)." },
        },
      },
      lens_6_self_organization: {
        type: "object",
        description: "Fee market equilibrium and pool emergence patterns.",
        properties: {
          fee_market_state:   { type: "string", enum: ["EQUILIBRIUM", "BACKLOGGED", "UNDERLOADED"] },
          avg_fee_delta_sat:  { type: "number", description: "Mean deviation between expected and actual fees in mempool (sat). Near 0 = equilibrium." },
          dominant_cluster:   { type: "string", description: "Name of the largest emerging mining entity." },
          self_org_score:     { type: "integer", description: "0–100 score: 100 = perfectly competitive fee market with many equally-sized pools." },
        },
      },
      lens_7_resilience: {
        type: "object",
        description: "Network concentration and decentralization health.",
        properties: {
          hhi:                    { type: "integer", description: "Herfindahl-Hirschman Index (0–10000). <1500 competitive; >2500 concentrated." },
          decentralization_grade: { type: "string", enum: ["A", "B", "C", "D", "F"] },
          hhi_interpretation:     { type: "string" },
          resilience_summary:     { type: "string" },
        },
      },
      meta: {
        type: "object",
        properties: {
          block_height:  { type: "integer" },
          generated_at:  { type: "string" },
          data_sources:  { type: "array", items: { type: "string" } },
        },
      },
    },
  },

  async handler(input) {
    const window = input.pool_window ?? "1w";

    const [diffAdj, poolData, fees, mempoolData, hashrateData, blockTip, rewardStats] = await Promise.all([
      get(`${MEMPOOL}/v1/difficulty-adjustment`),
      get(`${MEMPOOL}/v1/mining/pools/${window}`),
      get(`${MEMPOOL}/v1/fees/recommended`),
      get(`${MEMPOOL}/mempool`),
      get(`${MEMPOOL}/v1/mining/hashrate/1m`).catch(() => ({ hashrates: [] })),
      get(`${MEMPOOL}/blocks/tip/height`).catch(() => null),
      get(`${MEMPOOL}/v1/mining/reward-stats/144`).catch(() => ({})),
    ]);

    const pools    = poolData?.pools ?? [];
    const projChg  = diffAdj.difficultyChange ?? 0;
    const epochPct = diffAdj.progressPercent  ?? 0;
    const remain   = diffAdj.remainingBlocks  ?? 0;
    const retargetEta = diffAdj.estimatedRetargetDate
      ? new Date(diffAdj.estimatedRetargetDate).toISOString()
      : null;

    // --- Lens 1: Feedback ---
    const fbState = projChg > 2 ? "TIGHTENING" : projChg < -2 ? "EASING" : "NEUTRAL";
    const lagDays  = remain > 0 ? Number((remain * 10 / 60 / 24).toFixed(2)) : 0;

    // --- Lens 2: Stocks & Flows ---
    const mempoolVsizeMb    = Number((mempoolData.vsize / 1_000_000).toFixed(2));
    const mempoolFeeBtc     = Number((mempoolData.total_fee / 1e8).toFixed(6));
    const BLOCK_VSIZE       = 1_000_000;
    const blocksToClear     = Number((mempoolData.vsize / BLOCK_VSIZE).toFixed(1));
    const flowPressure      = mempoolData.count > 100_000 ? "HIGH" : mempoolData.count > 30_000 ? "MEDIUM" : "LOW";

    // --- Lens 3: Delays ---
    const econFee     = fees.economyFee     ?? 0;
    const priorityFee = fees.halfHourFee    ?? fees.fastestFee ?? 0;
    const econConf    = estimateConfirmMinutes(mempoolData, econFee);
    const priorConf   = estimateConfirmMinutes(mempoolData, priorityFee);

    // --- Lens 4: Nonlinearity ---
    const fastFee      = fees.fastestFee ?? 1;
    const feeSmoothFee = econFee          >= 1 ? econFee : 1;
    const feeNlRatio   = Number((fastFee / feeSmoothFee).toFixed(2));

    const hashRates       = hashrateData?.hashrates ?? [];
    const latestHr        = hashRates.slice(-1)[0]?.avgHashrate ?? 0;
    const midpointHr      = hashRates[Math.floor(hashRates.length / 2)]?.avgHashrate ?? latestHr;
    const hashRateEhs     = Number((latestHr / 1e18).toFixed(2));
    const hashGrowthRatio = midpointHr > 0 ? latestHr / midpointHr : 1;
    const hashTrend       = hashGrowthRatio > 1.05 ? "ACCELERATING" : hashGrowthRatio < 0.95 ? "DECELERATING" : "STEADY";

    // --- Lens 5: Nakamoto ---
    const totalPoolBlocks = pools.reduce((s, p) => s + (p.blockCount ?? 0), 0);
    const nakaCoeff       = nakamotoCoeff(pools);
    const sortedPools     = [...pools].sort((a, b) => (b.blockCount ?? 0) - (a.blockCount ?? 0));
    const topPool         = sortedPools[0];
    const topSharePct     = totalPoolBlocks > 0
      ? Number(((topPool?.blockCount ?? 0) / totalPoolBlocks * 100).toFixed(1))
      : 0;
    const top3SharePct    = totalPoolBlocks > 0
      ? Number((sortedPools.slice(0, 3).reduce((s, p) => s + (p.blockCount ?? 0), 0) / totalPoolBlocks * 100).toFixed(1))
      : 0;

    // --- Lens 6: Self-Organization ---
    const avgFeeDelta = pools.length > 0
      ? Number((pools.reduce((s, p) => s + Math.abs(parseFloat(p.avgFeeDelta ?? 0)), 0) / pools.length).toFixed(4))
      : 0;
    const feeMarketState = blocksToClear > 6 ? "BACKLOGGED" : blocksToClear < 1 ? "UNDERLOADED" : "EQUILIBRIUM";
    const hhiScore       = hhi(pools);
    // Self-org score: high when many pools, low HHI, balanced fee market
    const selfOrgScore   = Math.min(100, Math.round(
      (nakaCoeff / Math.max(pools.length, 1) * 50) +      // diversity share
      (Math.max(0, 2500 - hhiScore) / 2500 * 30) +        // HHI bonus
      (feeMarketState === "EQUILIBRIUM" ? 20 : 5)          // market state bonus
    ));

    // --- Lens 7: Resilience ---
    const grade     = decentralizationGrade(nakaCoeff, hhiScore);
    const hhiInterp = hhiScore < 1500 ? "competitive" : hhiScore < 2500 ? "moderately concentrated" : "highly concentrated";
    const resSummary = `${pools.length} active pools (${window}). Nakamoto coefficient ${nakaCoeff} — need ${nakaCoeff} largest pool(s) for 51% consensus. HHI ${hhiScore} (${hhiInterp}). Top pool ${topPool?.name ?? "unknown"} at ${topSharePct}%. Grade: ${grade}.`;

    return {
      lens_1_feedback: {
        state:                fbState,
        projected_change_pct: Number(projChg.toFixed(4)),
        epoch_progress_pct:   Number(epochPct.toFixed(2)),
        blocks_to_retarget:   remain,
        retarget_eta_iso:     retargetEta,
        regulator_lag_days:   lagDays,
      },
      lens_2_stocks_flows: {
        mempool_tx_count:  mempoolData.count ?? 0,
        mempool_vsize_mb:  mempoolVsizeMb,
        mempool_fee_btc:   mempoolFeeBtc,
        blocks_to_clear:   blocksToClear,
        flow_pressure:     flowPressure,
      },
      lens_3_delays: {
        economy_fee_sat_vb:           econFee,
        priority_fee_sat_vb:          priorityFee,
        est_economy_confirm_minutes:  econConf,
        est_priority_confirm_minutes: priorConf,
      },
      lens_4_nonlinearity: {
        fee_nonlinearity_ratio: feeNlRatio,
        hashrate_trend_ehs:     hashRateEhs,
        hashrate_growth_state:  hashTrend,
      },
      lens_5_nakamoto: {
        nakamoto_coefficient: nakaCoeff,
        pool_window:          window,
        total_pools:          pools.length,
        top_pool_name:        topPool?.name ?? null,
        top_pool_share_pct:   topSharePct,
        top_3_share_pct:      top3SharePct,
      },
      lens_6_self_organization: {
        fee_market_state:  feeMarketState,
        avg_fee_delta_sat: avgFeeDelta,
        dominant_cluster:  topPool?.name ?? null,
        self_org_score:    selfOrgScore,
      },
      lens_7_resilience: {
        hhi:                    hhiScore,
        decentralization_grade: grade,
        hhi_interpretation:     hhiInterp,
        resilience_summary:     resSummary,
      },
      meta: {
        block_height:  typeof blockTip === "number" ? blockTip : null,
        generated_at:  new Date().toISOString(),
        data_sources:  ["mempool.space (free, no key)"],
      },
    };
  },
};
