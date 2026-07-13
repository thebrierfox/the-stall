// payai-canary.js — T3-1 Move #3: route the `ping` cap through PayAI facilitator
//
// CANARY scope: ping only. All other caps continue on the existing EVM + Solana rails.
// Observation window: 30d from deployment (2026-07-07 → 2026-08-06).
// Kill criterion: zero PayAI-Bazaar-attributable calls in window → log dead pond, remove.
// Success: ≥1 call with PayAI facilitator-referral UA or first-touch.
//
// PayAI facilitator: https://facilitator.payai.network
// Supports: Base EVM + Solana mainnet (+ 15 other chains). Non-custodial.
// Free tier: 0–10,000 settlements/month (we're at 8,663 lifetime all-rail).

import { createRequire } from "module";

const _require = createRequire(import.meta.url);

// Canary cap name — change here to shift the canary to a different cap
const CANARY_CAP = "ping";

let _payaiMiddleware = null;
let _initAttempted = false;

/**
 * Lazily initialize the PayAI middleware on first request (ESM/CJS interop).
 * Returns null on failure — fail-open: the request falls through to existing rails.
 */
function getPayAIMiddleware(pingCap, solanaWallet, evmWallet) {
  if (_initAttempted) return _payaiMiddleware;
  _initAttempted = true;
  try {
    const { agentPayments } = _require("@payai/agentic-payments/express");
    _payaiMiddleware = agentPayments({
      payTo: {
        // Both EVM and Solana — PayAI handles all their supported chains.
        // EVM: Base mainnet + PayAI's other 15+ supported EVM chains
        // Solana: mainnet-beta via PayAI facilitator (auto-Bazaar listing trigger)
        ...(evmWallet ? { evm: evmWallet } : {}),
        ...(solanaWallet ? { solana: solanaWallet } : {}),
      },
      endpoints: {
        [`GET /cap/${CANARY_CAP}`]: {
          price: pingCap.price,
          description: pingCap.description,
        },
      },
      live: true, // mainnet — real USDC payments
    });
    console.log(`[payai-canary] initialized for /cap/${CANARY_CAP} — facilitator: https://facilitator.payai.network`);
  } catch (err) {
    console.warn(`[payai-canary] init failed (falling through to existing rails): ${err.message}`);
    _payaiMiddleware = null;
  }
  return _payaiMiddleware;
}

/**
 * Build the PayAI canary middleware.
 *
 * Only intercepts /cap/ping. All other paths pass through immediately.
 * If PayAI initialization fails, the canary is a no-op (fail-closed to existing rails).
 *
 * @param {Array} capabilities - Loaded capability modules
 * @param {string} solanaWallet - Solana wallet address (SOLANA_WALLET_ADDRESS)
 * @param {string} evmWallet - EVM wallet address (WALLET_ADDRESS)
 */
export function buildPayAICanaryMiddleware(capabilities, solanaWallet, evmWallet) {
  const pingCap = capabilities.find(c => c.name === CANARY_CAP);
  if (!pingCap) {
    console.warn(`[payai-canary] cap '${CANARY_CAP}' not found — canary disabled`);
    return (req, res, next) => next();
  }
  if (!solanaWallet && !evmWallet) {
    console.warn("[payai-canary] no wallet configured — canary disabled");
    return (req, res, next) => next();
  }

  return function payAICanaryMiddleware(req, res, next) {
    // Only intercept the canary cap path
    if (!req.path.startsWith(`/cap/${CANARY_CAP}`)) return next();
    // Skip if already fiat-paid (stripe token bearer)
    if (req.fiatPaid) return next();
    // Skip if request already carries a native EVM x402 payment — route through local facilitator
    if (req.headers['payment-signature'] || req.headers['x-payment']) return next();

    const payaiMw = getPayAIMiddleware(pingCap, solanaWallet, evmWallet);
    if (!payaiMw) return next(); // PayAI unavailable — fall through to existing rails

    // Let PayAI handle the full 402/verify/settle cycle for this request.
    // If PayAI returns 402 (no payment), that 402 IS the response for this path.
    // Requests to other paths are never intercepted.
    payaiMw(req, res, next);
  };
}
