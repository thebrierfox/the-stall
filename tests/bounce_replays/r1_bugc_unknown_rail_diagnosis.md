# R1.3 — 0xB397 Undiagnosed Shape: Analysis Report

## Shape: 0xB39741F7D31e1bc80996f7b7FA1c03Bf398ed030 — social-momentum ×5 (Jul 8, 15:59–16:22Z)

### Evidence

**Source:** `logs/402_bounces.jsonl` — 5 entries, all:
```json
{
  "ts": "2026-07-08T15:59:33.982Z" (through 16:22:35.704Z),
  "cap": "/cap/social-momentum",
  "attempted_rail": "unknown",
  "attempted_chain": "unknown",
  "payer": "0xB39741F7D31e1bc80996f7b7FA1c03Bf398ed030",
  "rejection_reason": "payment_rejected"
}
```

**On-chain profile:** 18 outgoing txs, 3 counterparties ($0.01–$0.015/call), no prior STALL settlements. All 5 retries in 23 minutes = persistent intent, deterministic failure.

### Diagnosis

1. **`attempted_rail: "unknown"` is a logging classification gap, not the rejection cause.**
   - ALL x402 v2 payments get `attempted_rail: "unknown"` because the bounce logger
     checked `decoded.network` and `decoded.payload.network`, but v2 format puts the
     network in `decoded.accepted.network` or `decoded.accepted[0].network`.
   - Fix applied in this commit (R1.3): added v2-aware network extraction.

2. **Payer address was successfully extracted** (`decoded?.payload?.authorization?.from`),
   confirming the payment envelope is standard EIP-3009 structure with proper auth fields.

3. **Rejection cause** — raw packet unavailable (chassis.log does not retain Jul 8 data).
   Based on available evidence:
   - **Most likely**: 0xB397 was using a PayAI-mediated payment where the EIP-3009
     authorization `auth.to` pointed to PayAI's intermediary address (not STALL's
     revenue wallet 0x03d773). This causes `shouldBypass()` in local-facilitator to
     return false → routes to CDP → CDP rejects because auth.to is not CDP-registered.
   - **Alternative**: 0xB397's client generates short-lived authorizations (validBefore ≈
     60s), and STALL's verification latency exceeded the window on all 5 attempts.
   - **Ruled out**: bug b (v2 ResourceInfo TypeError) would crash SETTLE, not VERIFY.
     0xB397 got 402 responses = verification was the failing step.

4. **Compatibility decision for Kyle:**
   - If 0xB397 routes payments through PayAI's aggregator (auth.to = PayAI address),
     STALL will continue to reject them until STALL is listed on PayAI's catalog
     (so PayAI routes to STALL's wallet).
   - The `allow402-quote/1.0` agent also appeared in the ping window — unknown affiliation.
   - **Recommended action:** List STALL on PayAI's provider catalog to capture this
     agent class. Contact: x402.paysponge.com (PaySponge) is already a known target;
     PayAI may be a separate integration path.

### R1.3 Fix Applied

Enhanced `log402Bounce()` in `src/server.js`:
- Network extraction now checks `decoded.accepted?.network || decoded.accepted?.[0]?.network`
  in addition to prior paths — v2 format payments will now be classified as `evm` not `unknown`
- Raw payload snippet (200 chars) is now captured in bounce log entries when rail is still
  `unknown` after all detection paths, enabling future forensic diagnosis without chassis.log retention

### Future: Raw Packet Capture

For next occurrence of `attempted_rail: unknown`, check `402_bounces.jsonl` for `raw_snippet`
field. If the payment format is genuinely non-standard (not recognizable as EIP-3009 v1 or v2
or Solana), file it here as a compatibility case for Kyle.

### R1 Replay for This Shape

Since raw Jul 8 packets are unavailable, a synthetic replay of the most likely failure
(PayAI-intermediated payment) requires:
1. A PayAI account/wallet
2. A call through PayAI's facilitator to /cap/social-momentum
3. Observe whether STALL now accepts it (if listed on PayAI) or rejects (if not listed)

This cannot be executed headlessly — requires Cowork browser session to register on PayAI.
Until then: monitor `402_bounces.jsonl` for 0xB397 returning. W3 (warm-lead-return) will
alert on 0xB397's next appearance.
