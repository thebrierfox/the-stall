#!/usr/bin/env python3
"""
P0 Field-Calibrated Reprice — Go-Live sequence, Kyle+Fable authorized 2026-07-13
Directive: directive_chat_go_live_p0_pricing_gate_field_calibrated_20260713_181631.md

DOCTRINE (Kyle binding):
- Floor rule: no cap below its category's field p40
- Target band: p60-p85 of category comparables
- Ceiling rule: proven-demand prices HELD (settlement or signed-attempt evidence)
- Batch caps price vs per-unit equiv (stock-price-multi $0.295 = $0.059/ticker — defensible)

FIELD BENCHMARKS (Chat survey n=988 non-STALL Bazaar prices, 2026-07-13):
  overall:          med=$0.010, p75=$0.031, p90=$0.100
  stock_price:      med=$0.005, p75=$0.010, p90=$0.052
  earnings:         med=$0.020, p75=$0.100, p90=$2.00
  crypto/market:    med=$0.010, p75=$0.050, p90=$0.100
  research/synth:   med=$0.030, p75=$0.100, p90=$0.500
  sentiment/social: med=$0.014, p75=$0.060, p90=$0.100
  news:             med=$0.010, p75=$0.020, p90=$0.100
  weather:          med=$0.010, p75=$0.010, p90=$0.050

PROVEN DEMAND (held, not trimmed):
  research-synthesis:  $2.50  (4 signed attempts Jul 8-11)
  sector-rotation:     $0.434 (2 payers — RESTORING from mistaken $0.040)
  equity-brief:        $0.370 (organic settle Jul 2)
  equity-technicals:   $0.420 (38 calls confirmed Jul 9)
  market-intelligence: $0.390 (43 calls confirmed Jul 9)
  fact-check:          $0.470 (35 calls confirmed Jul 9)
  analyst-ratings:     $0.295 (79 calls confirmed Jul 9)
  income-statements:   $0.295 (34 calls confirmed Jul 9)
  us-stock-price:      $0.295 (168 calls/46w confirmed Jul 9)
  stock-price-multi:   $0.295 (111 calls/36w confirmed Jul 9)
  energy-brief:        $0.990 (35 calls confirmed Jul 9)
  code-test-detector:  $0.160 (field-proven Jul 9)
  code-api-surface:    $0.160 (field-proven Jul 9)
  chain-pulse:         $0.117 (field-proven Jul 9)

Actor: Aegis cy_hb_4269 | Date: 2026-07-13
"""

import re
import os
import sys

CAPS_DIR = os.path.join(os.path.dirname(__file__), "capabilities")
INVERT = "--invert" in sys.argv

# BASELINE = cy_hb_4268 prices (pre-P0 state)
BASELINE = {
    # Earnings category (below p40=$0.059)
    "earnings-calendar":              "$0.059",
    "earnings-surprises":             "$0.059",
    "analyst-upgrades":               "$0.025",
    "earnings-estimates":             "$0.012",
    "earnings-quality":               "$0.025",
    "earnings-reaction":              "$0.025",
    # sector-rotation (proven demand restore)
    "sector-rotation":                "$0.040",
    # Market brief (below p40=$0.065)
    "polymarket-intel":               "$0.034",
    # News/sentiment (below p40=$0.037)
    "twitter-intel":                  "$0.015",
    "equity-sentiment":               "$0.035",
    "market-sentiment":               "$0.035",
    "polymarket-sentiment-shift":     "$0.034",
    # Crypto floor violations (below p40=$0.030)
    "ens-lookup":                     "$0.004",
    "tx-intel":                       "$0.014",
    # Dev/security floor violations (below p40=$0.021)
    "github-trending":                "$0.006",
    "github-intel":                   "$0.015",
    # Media data (below p40=$0.021)
    "patent-intel":                   "$0.015",
    "youtube-playlist":               "$0.015",
    "youtube-search":                 "$0.015",
    "youtube-video-analytics":        "$0.015",
    # Economic data (below p40=$0.021)
    "fred-query":                     "$0.008",
    "government-contract-intel":      "$0.015",
    # Other — below overall p40=$0.021
    "npi-lookup":                     "$0.005",
    "price-target-consensus":         "$0.010",
    "market-breadth":                 "$0.010",
    "app-store-intel":                "$0.010",
    "huggingface-intel":              "$0.010",
    "llm-proxy":                      "$0.010",
    "sec-full-text-search":           "$0.010",
    "tvmaze-intel":                   "$0.010",
    "balance-sheet":                  "$0.015",
    "cash-flow-statement":            "$0.015",
    "fdic-bank-intel":                "$0.015",
    "inflation-intel":                "$0.015",
    "insider-trading-intel":          "$0.015",
    "institutional-ownership":        "$0.015",
    "institutional-ownership-intel":  "$0.015",
    "nonprofit-intel":                "$0.015",
    "open-food-intel":                "$0.015",
    "pubmed-intel":                   "$0.015",
    "pypi-intel":                     "$0.015",
    "vc-funding-intel":               "$0.015",
    "npm-trends":                     "$0.020",
    "cot-positioning":                "$0.018",
    "economic-momentum":              "$0.018",
    "geocode":                        "$0.014",
    "place-details":                  "$0.020",
    "activist-investor-intel":        "$0.020",
    "merger-acquisition-intel":       "$0.020",
    "revenue-growth-intel":           "$0.020",
    "solar-intel":                    "$0.020",
    "prediction-stock-pulse":         "$0.016",
    "short-interest-intel":           "$0.012",
}

# P0 TARGET prices (field-calibrated, p60-p85 band)
TARGET = {
    # Earnings — raise to p60-p75 range (p75=$0.100)
    "earnings-calendar":              "$0.099",   # directive explicit, below p75 headroom
    "earnings-surprises":             "$0.099",   # same category, same reasoning
    "analyst-upgrades":               "$0.079",   # earnings p60 band
    "earnings-estimates":             "$0.079",   # earnings p60 band
    "earnings-quality":               "$0.079",   # earnings p60 band
    "earnings-reaction":              "$0.079",   # earnings p60 band
    # sector-rotation: restore to proven-demand price (2 payers at $0.434)
    "sector-rotation":                "$0.434",   # PROVEN RESTORE — field-proven 2 payers
    # Market brief — raise to p60 range
    "polymarket-intel":               "$0.079",   # market_brief p60 band
    # News/sentiment — raise to p60 range (field p75=$0.060, target $0.040 = near p50)
    "twitter-intel":                  "$0.040",   # sentiment p50-p60 range
    "equity-sentiment":               "$0.040",   # sentiment at-floor, raise to p50
    "market-sentiment":               "$0.040",   # sentiment at-floor, raise to p50
    "polymarket-sentiment-shift":     "$0.040",   # sentiment below floor, raise
    # Crypto — raise to p40 minimum ($0.031)
    "ens-lookup":                     "$0.031",   # crypto p40 floor (simple lookup)
    "tx-intel":                       "$0.031",   # crypto p40 floor
    # Dev/security — raise to overall floor ($0.021)
    "github-trending":                "$0.021",   # dev overall floor
    "github-intel":                   "$0.021",   # dev overall floor
    # Media data — raise to overall floor
    "patent-intel":                   "$0.021",
    "youtube-playlist":               "$0.021",
    "youtube-search":                 "$0.021",
    "youtube-video-analytics":        "$0.021",
    # Economic data — raise to floor
    "fred-query":                     "$0.021",
    "government-contract-intel":      "$0.021",
    # Other — raise to overall floor ($0.021) or field-adjacent band
    "npi-lookup":                     "$0.021",   # healthcare provider lookup → floor
    "price-target-consensus":         "$0.031",   # analyst data → slightly higher
    "market-breadth":                 "$0.031",   # market data → slightly higher
    "app-store-intel":                "$0.021",
    "huggingface-intel":              "$0.021",
    "llm-proxy":                      "$0.021",
    "sec-full-text-search":           "$0.021",
    "tvmaze-intel":                   "$0.021",
    "balance-sheet":                  "$0.021",
    "cash-flow-statement":            "$0.021",
    "fdic-bank-intel":                "$0.021",
    "inflation-intel":                "$0.021",
    "insider-trading-intel":          "$0.021",
    "institutional-ownership":        "$0.021",
    "institutional-ownership-intel":  "$0.021",
    "nonprofit-intel":                "$0.021",
    "open-food-intel":                "$0.021",
    "pubmed-intel":                   "$0.021",
    "pypi-intel":                     "$0.021",
    "vc-funding-intel":               "$0.021",
    "npm-trends":                     "$0.021",
    "cot-positioning":                "$0.021",
    "economic-momentum":              "$0.021",
    "geocode":                        "$0.021",
    "place-details":                  "$0.021",
    "activist-investor-intel":        "$0.021",
    "merger-acquisition-intel":       "$0.021",
    "revenue-growth-intel":           "$0.021",
    "solar-intel":                    "$0.021",
    "prediction-stock-pulse":         "$0.021",
    "short-interest-intel":           "$0.021",
}

PAT = re.compile(r"""(price:\s*['"]?)(\$[\d.]+)(['"]?)""")

def apply(cap_name, new_price):
    path = os.path.join(CAPS_DIR, f"{cap_name}.js")
    if not os.path.exists(path):
        print(f"  SKIP {cap_name}: file not found")
        return None
    txt = open(path).read()
    m = PAT.search(txt)
    if not m:
        print(f"  SKIP {cap_name}: price pattern not found")
        return None
    old_price = m.group(2)
    if old_price == new_price:
        print(f"  NOOP {cap_name}: already at {new_price}")
        return False
    new_txt = PAT.sub(lambda x: x.group(1) + new_price + x.group(3), txt, count=1)
    open(path, "w").write(new_txt)
    print(f"  OK   {cap_name}: {old_price} → {new_price}")
    return True

changed = 0
price_map = BASELINE if INVERT else TARGET
mode = "REVERT to cy_hb_4268 (pre-P0) prices" if INVERT else "P0 APPLY field-calibrated prices"

print(f"\n{'='*70}")
print(f"P0 Field-Calibrated Reprice — {mode}")
print(f"Actor: Aegis cy_hb_4269 | 2026-07-13")
print(f"{'='*70}")
print(f"\n--- EARNINGS CATEGORY (target band: $0.079–$0.099) ---")
earnings_caps = ["earnings-calendar","earnings-surprises","analyst-upgrades","earnings-estimates","earnings-quality","earnings-reaction"]
for c in earnings_caps:
    if apply(c, price_map[c]): changed += 1

print(f"\n--- PROVEN DEMAND RESTORE ---")
if apply("sector-rotation", price_map["sector-rotation"]): changed += 1

print(f"\n--- MARKET BRIEF (target: $0.079) ---")
if apply("polymarket-intel", price_map["polymarket-intel"]): changed += 1

print(f"\n--- NEWS/SENTIMENT (target: $0.040) ---")
for c in ["twitter-intel","equity-sentiment","market-sentiment","polymarket-sentiment-shift"]:
    if apply(c, price_map[c]): changed += 1

print(f"\n--- CRYPTO FLOOR (minimum: $0.031) ---")
for c in ["ens-lookup","tx-intel"]:
    if apply(c, price_map[c]): changed += 1

print(f"\n--- DEV/SECURITY + MEDIA + ECONOMIC FLOOR (minimum: $0.021) ---")
floor_caps = [
    "github-trending","github-intel","patent-intel","youtube-playlist",
    "youtube-search","youtube-video-analytics","fred-query","government-contract-intel",
]
for c in floor_caps:
    if apply(c, price_map[c]): changed += 1

print(f"\n--- OTHER FLOOR VIOLATIONS (minimum: $0.021) ---")
other_caps = [
    "npi-lookup","price-target-consensus","market-breadth","app-store-intel",
    "huggingface-intel","llm-proxy","sec-full-text-search","tvmaze-intel",
    "balance-sheet","cash-flow-statement","fdic-bank-intel","inflation-intel",
    "insider-trading-intel","institutional-ownership","institutional-ownership-intel",
    "nonprofit-intel","open-food-intel","pubmed-intel","pypi-intel","vc-funding-intel",
    "npm-trends","cot-positioning","economic-momentum","geocode","place-details",
    "activist-investor-intel","merger-acquisition-intel","revenue-growth-intel",
    "solar-intel","prediction-stock-pulse","short-interest-intel",
]
for c in other_caps:
    if apply(c, price_map[c]): changed += 1

print(f"\n{'='*70}")
print(f"Changed: {changed}/{len(TARGET)} caps")
print(f"{'='*70}")
print(f"\nNext: restart STALL, then verify via /health + 3 spot 402 probes")
print(f"Revert: python3 {os.path.basename(__file__)} --invert + restart STALL")
