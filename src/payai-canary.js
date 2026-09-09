// PayAI ping compatibility boundary — quarantined under current rail governance.
//
// The legacy SDK expands an EVM/Solana payTo into facilitator-supported rails,
// including rails that STALL explicitly keeps in GOVERNANCE_REVIEW. It must not
// initialize, advertise, verify, or settle outside the canonical payment path.
// This is not a finding that the old observation-window date alone revoked all
// PayAI authority. Current middleware/discovery truth parity requires quarantine.
//
// Original implementation is retained in git and the anomaly244 preimage.
// Reintroduction requires separately reviewed rail-specific authority and tests;
// there is deliberately no clock, wallet, request, or environment enable switch.

/**
 * Preserve compatibility for any historical caller without loading a payment SDK.
 * Every request is passed through untouched exactly once. The caller must retain
 * its canonical payment gate; this middleware never authorizes fulfillment.
 */
export function buildPayAICanaryMiddleware(_capabilities, _solanaWallet, _evmWallet) {
  return function quarantinedPayAICanary(_req, _res, next) {
    return next();
  };
}
