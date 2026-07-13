#!/bin/bash
# Bounce regression suite runner — run after any change to:
#   src/local-facilitator.mjs, src/payai-canary.js, src/server.js (payment path)
#
# R2 standing rule: when a new organic bounce is diagnosed, its shape enters this
# suite in the same session as the fix. Wound → immune system.
#
# Daily heartbeat: runs r1_buga_discovery_402.mjs only (read-only, zero cost).
# Commit trigger: runs full suite including r1_bugb when seeder balance >= $2.50.
#
# Usage:
#   ./tests/bounce_replays/run_suite.sh          # daily mode (read-only)
#   ./tests/bounce_replays/run_suite.sh --full   # full suite including seeder replay
# Exit 0 = all PASS, exit 1 = any FAIL.

set -e
cd "$(dirname "$0")/../.."  # run from the-stall/

FULL=${1:-""}
PASS=0
FAIL=0
SKIPPED=0

echo "=== BOUNCE REGRESSION SUITE ==="
echo "Mode: $([ -n "$FULL" ] && echo FULL || echo DAILY)"
echo ""

# ── R1.2 / Bug A: fresh discovery 402 (read-only, always runs) ────────────────
echo "Running R1-BugA: discovery 402 format..."
if node tests/bounce_replays/r1_buga_discovery_402.mjs; then
  echo "  → PASS"
  PASS=$((PASS+1))
else
  echo "  → FAIL"
  FAIL=$((FAIL+1))
  bash ~/intuitek/notify.sh "🚨 [Bounce-Regression] r1_buga FAIL — discovery 402 regression detected" 2>/dev/null || true
fi
echo ""

# ── R1.1 / Bug B: v2 ResourceInfo settle ($2.50, seeder-funded) ───────────────
if [ -n "$FULL" ]; then
  echo "Running R1-BugB: v2 ResourceInfo settle ($2.50 seeder)..."
  # Check seeder balance before firing
  SEEDER_BAL=$(node -e "
    import { createPublicClient, http, parseAbi } from 'viem';
    import { base } from 'viem/chains';
    const c = createPublicClient({ chain: base, transport: http(process.env.COINBASE_BASE_RPC || 'https://gateway.tenderly.co/public/base') });
    const bal = await c.readContract({ address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: ['0xf615BDa54D576e757B51A6128aC8A7C67a1C3d6C'] });
    console.log((Number(bal) / 1e6).toFixed(6));
  " 2>/dev/null || echo "0")
  SEEDER_NUM=$(echo "$SEEDER_BAL" | awk '{print $1+0}')
  if (( $(echo "$SEEDER_NUM >= 2.5" | bc -l) )); then
    if node tests/bounce_replays/r1_bugb_v2_resourceinfo_settle.mjs; then
      echo "  → PASS"
      PASS=$((PASS+1))
    else
      echo "  → FAIL"
      FAIL=$((FAIL+1))
      bash ~/intuitek/notify.sh "🚨 [Bounce-Regression] r1_bugb FAIL — v2 ResourceInfo settle regression detected" 2>/dev/null || true
    fi
  else
    echo "  → SKIPPED (seeder balance $SEEDER_BAL < \$2.50)"
    SKIPPED=$((SKIPPED+1))
  fi
else
  echo "R1-BugB: SKIPPED (daily mode — use --full for seeder replay)"
  SKIPPED=$((SKIPPED+1))
fi
echo ""

echo "=== RESULTS: ${PASS} PASS / ${FAIL} FAIL / ${SKIPPED} SKIPPED ==="
[ $FAIL -eq 0 ] && exit 0 || exit 1
