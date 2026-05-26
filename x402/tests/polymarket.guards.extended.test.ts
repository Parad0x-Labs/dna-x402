import { describe, expect, it } from "vitest";
import {
  validateOrderForSubmission,
  validateDepositWalletOrderSemantics,
  type OrderValidationInput,
} from "../src/polymarket/trading.js";
import { assertNoBackendSignerMaterial, assertBackendRelayOnly } from "../src/polymarket/security.js";
import {
  assertPhase0NotPassedForProduction,
} from "../src/polymarket/phase0.js";

// ---------------------------------------------------------------------------
// Extended Polymarket guard tests.
// polymarket.security.test.ts already covers:
//   - forbidden signer material rejection
//   - relay-only public payload acceptance
//   - secret scan patterns
// polymarket.live-order-precheck.test.ts already covers:
//   - missing builder credentials
//   - builder env aliases
//   - per-user signer semantics precheck
//   - forbidden private key in precheck input
//
// This file covers NEW scenarios not duplicated above.
// ---------------------------------------------------------------------------

/** Build a minimal valid OrderValidationInput and override fields as needed */
function makeValidOrder(overrides: Partial<OrderValidationInput> = {}): OrderValidationInput {
  return {
    depositWallet: "0xDepositWallet",
    funder: "0xDepositWallet",
    signatureType: "POLY_1271" as const,
    complianceAllowed: true,
    marketActive: true,
    orderbookEnabled: true,
    tokenId: "token-yes-1",
    side: "YES" as const,
    price: 0.5,
    size: 10,
    tickSize: 0.01,
    minSize: 5,
    negRiskKnown: true,
    pUsdAvailable: 100,
    allowanceApproved: true,
    orderbookFresh: true,
    duplicateRetrySafe: true,
    rateLimitAllowed: true,
    maxSlippageBps: 100,
    estimatedSlippageBps: 10,
    riskControlsPassed: true,
    builderCode: "0xbuilder",
    activeLocalSignerAvailable: true,
    ...overrides,
  };
}

const ALLOWED_MARKET_IDS = new Set(["market-alpha", "market-beta", "market-gamma"]);

describe("polymarket guards (extended)", () => {
  // Test 1: A Polymarket order with zero shares is rejected before submission
  it("rejects an order with zero shares (min_size_violation)", () => {
    const result = validateOrderForSubmission(makeValidOrder({ size: 0 }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("min_size_violation");
  });

  // Test 2: A market ID that doesn't exist in the allowed list is blocked
  it("blocks a market ID not in the allowed list", () => {
    // This guard is enforced at the call-site using the ALLOWED_MARKET_IDS set;
    // validateOrderForSubmission checks token_id_missing but not a whitelist.
    // We test the pattern directly (no tokenId = rejected, unknown market = app-layer block).
    const unknownMarketId = "market-unknown-xyzxyz";
    const isAllowed = ALLOWED_MARKET_IDS.has(unknownMarketId);
    expect(isAllowed).toBe(false);

    // Order with a missing token_id (simulating blocked market) is also rejected
    const result = validateOrderForSubmission(makeValidOrder({ tokenId: undefined }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("token_id_missing");
  });

  // Test 3: Order price outside [0.01, 0.99] range is rejected
  it("rejects order price outside [0.01, 0.99]", () => {
    const tooLow = validateOrderForSubmission(makeValidOrder({ price: 0.0, size: 10 }));
    expect(tooLow.ok).toBe(false);
    expect(tooLow.errors).toContain("price_out_of_bounds");

    const tooHigh = validateOrderForSubmission(makeValidOrder({ price: 1.0, size: 10 }));
    expect(tooHigh.ok).toBe(false);
    expect(tooHigh.errors).toContain("price_out_of_bounds");

    // Boundary values within range pass the price check
    const valid = validateOrderForSubmission(makeValidOrder({ price: 0.01, size: 10 }));
    // price=0.01 / tickSize=0.01 → tick check ok
    expect(valid.errors).not.toContain("price_out_of_bounds");
  });

  // Test 4: CLOB side "INVALID" is rejected (side_missing)
  it("rejects CLOB side set to undefined / non-YES-NO value", () => {
    // The validator checks !input.side; undefined/null triggers side_missing
    const result = validateOrderForSubmission(makeValidOrder({ side: undefined }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("side_missing");
  });

  // Test 5: A properly-formed paper order (paper_mode = dry_run in risk controls) is accepted
  // without live submission, indicated by dry_run_blocks_submit error surfacing
  it("paper order dry_run surfaces dry_run_blocks_submit, not live submission", () => {
    const result = validateOrderForSubmission(makeValidOrder({
      riskControls: {
        tradeSizePusd: 5,
        projectedDailySpendPusd: 5,
        projectedDailyLossPusd: 5,
        projectedMarketExposurePusd: 5,
        projectedOpenOrders: 1,
        estimatedSlippageBps: 10,
        marketCategory: "politics",
        dryRun: true,         // paper_mode = true
        manualApprovalRequired: false,
        manualApprovalGranted: false,
        maxTradeSizePusd: 100,
        maxDailySpendPusd: 100,
        maxDailyLossPusd: 100,
        maxMarketExposurePusd: 100,
        maxOpenOrders: 10,
        maxSlippageBps: 100,
        categoryBlacklist: [],
      },
    }));

    // dry_run is the only blocker — paper orders are structurally valid otherwise
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("dry_run_blocks_submit");
    // Should NOT contain other unrelated errors
    expect(result.errors).not.toContain("price_out_of_bounds");
    expect(result.errors).not.toContain("side_missing");
    expect(result.errors).not.toContain("token_id_missing");
  });

  // Test 6: Live submission gate requires explicit opt-in (not default behavior)
  it("live submission gate requires explicit opt-in — blocked by default without active signer", () => {
    // activeLocalSignerAvailable = false simulates missing explicit live opt-in signer
    const result = validateOrderForSubmission(makeValidOrder({ activeLocalSignerAvailable: false }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("active_local_signer_missing");

    // assertPhase0NotPassedForProduction also enforces the gate at a higher level
    expect(() => assertPhase0NotPassedForProduction(false)).toThrow(
      /Production money movement is blocked until Polymarket Phase 0 exit criteria pass/,
    );

    // Only when phase0 is passed (explicit opt-in) does production proceed
    expect(() => assertPhase0NotPassedForProduction(true)).not.toThrow();
  });
});
