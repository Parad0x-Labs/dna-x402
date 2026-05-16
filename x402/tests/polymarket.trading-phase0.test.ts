import { describe, expect, it } from "vitest";
import {
  validateUserRiskControls,
  validateDepositWalletOrderSemantics,
  validateOrderForSubmission,
  validatePhase0SdkSnapshot,
} from "../src/polymarket/trading.js";
import {
  assertCompatibilityDecisionRecorded,
  assertPhase0NotPassedForProduction,
  PHASE0_EXIT_CRITERIA,
} from "../src/polymarket/phase0.js";

const validOrder = {
  depositWallet: "0xDepositWallet",
  funder: "0xDepositWallet",
  signatureType: 3 as const,
  complianceAllowed: true,
  marketActive: true,
  orderbookEnabled: true,
  tokenId: "token-yes",
  side: "YES" as const,
  price: 0.5,
  size: 10,
  tickSize: 0.01,
  minSize: 5,
  negRiskKnown: true,
  pUsdAvailable: 10,
  allowanceApproved: true,
  orderbookFresh: true,
  duplicateRetrySafe: true,
  rateLimitAllowed: true,
  maxSlippageBps: 50,
  estimatedSlippageBps: 10,
  riskControlsPassed: true,
  builderCode: "0x100d7a6b325d63750f6d617565aa9c31277f0ca846f4af2a1bddab6ccfca57b3",
  activeLocalSignerAvailable: true,
};

describe("polymarket trading validation and Phase 0 guard", () => {
  it("requires deposit wallet as funder and POLY_1271 signature type without hardcoding maker/signer", () => {
    expect(validateDepositWalletOrderSemantics({
      depositWallet: "0xDepositWallet",
      funder: "0xOther",
      signatureType: 3,
    })).toContain("deposit_wallet_must_be_funder");

    expect(validateDepositWalletOrderSemantics({
      depositWallet: "0xDepositWallet",
      funder: "0xDepositWallet",
      signatureType: 0,
    })).toContain("signature_type_must_be_poly_1271");
  });

  it("captures required SDK snapshot fields for Phase 0 fixture tests", () => {
    expect(() => validatePhase0SdkSnapshot({
      maker: "sdk-maker",
      signer: "sdk-signer",
      funder: "0xDepositWallet",
      depositWallet: "0xDepositWallet",
      signatureType: "POLY_1271",
      apiKeyAddressBehavior: "fixture-recorded",
      ownerSessionSignerBehavior: "fixture-recorded",
      builderCode: validOrder.builderCode,
      signedOrderPayloadHash: "payload-hash",
    })).not.toThrow();

    expect(() => validatePhase0SdkSnapshot({
      funder: "0xDepositWallet",
      depositWallet: "0xDepositWallet",
      signatureType: "POLY_1271",
      apiKeyAddressBehavior: "",
      ownerSessionSignerBehavior: "",
      builderCode: "",
      signedOrderPayloadHash: "",
    })).toThrow(/snapshot_maker_missing/);
  });

  it.each([
    ["geoblock_or_compliance_blocked", { complianceAllowed: false }],
    ["market_inactive", { marketActive: false }],
    ["orderbook_disabled", { orderbookEnabled: false }],
    ["stale_orderbook", { orderbookFresh: false }],
    ["token_id_missing", { tokenId: undefined }],
    ["tick_size_violation", { price: 0.505 }],
    ["min_size_violation", { size: 4 }],
    ["insufficient_pusd", { pUsdAvailable: 1 }],
    ["missing_allowance_or_approval", { allowanceApproved: false }],
    ["builder_code_missing", { builderCode: undefined }],
    ["active_local_signer_missing", { activeLocalSignerAvailable: false }],
    ["duplicate_retry_not_idempotent", { duplicateRetrySafe: false }],
  ])("prevents order submit on %s", (expected, override) => {
    const result = validateOrderForSubmission({ ...validOrder, ...override });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(expected);
  });

  it("accepts a fully validated active-session order candidate", () => {
    const result = validateOrderForSubmission(validOrder);
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it.each([
    ["max_trade_size_exceeded", { tradeSizePusd: 101 }],
    ["max_daily_spend_exceeded", { projectedDailySpendPusd: 501 }],
    ["max_daily_loss_exceeded", { projectedDailyLossPusd: 51 }],
    ["max_market_exposure_exceeded", { projectedMarketExposurePusd: 201 }],
    ["max_open_orders_exceeded", { projectedOpenOrders: 11 }],
    ["max_slippage_exceeded", { estimatedSlippageBps: 51 }],
    ["category_blacklisted", { marketCategory: "politics" }],
    ["dry_run_blocks_submit", { dryRun: true }],
    ["manual_approval_required", { manualApprovalRequired: true, manualApprovalGranted: false }],
  ])("reports user risk control failure %s", (expected, override) => {
    const result = validateUserRiskControls({
      tradeSizePusd: 100,
      projectedDailySpendPusd: 500,
      projectedDailyLossPusd: 50,
      projectedMarketExposurePusd: 200,
      projectedOpenOrders: 10,
      estimatedSlippageBps: 50,
      marketCategory: "sports",
      dryRun: false,
      manualApprovalRequired: false,
      manualApprovalGranted: false,
      maxTradeSizePusd: 100,
      maxDailySpendPusd: 500,
      maxDailyLossPusd: 50,
      maxMarketExposurePusd: 200,
      maxOpenOrders: 10,
      maxSlippageBps: 50,
      categoryBlacklist: ["politics", "crypto"],
      ...override,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(expected);
  });

  it("adds explicit risk-control errors to order validation", () => {
    const result = validateOrderForSubmission({
      ...validOrder,
      riskControlsPassed: true,
      riskControls: {
        tradeSizePusd: 20,
        projectedDailySpendPusd: 120,
        projectedDailyLossPusd: 0,
        projectedMarketExposurePusd: 120,
        projectedOpenOrders: 2,
        estimatedSlippageBps: 10,
        marketCategory: "politics",
        dryRun: false,
        manualApprovalRequired: false,
        manualApprovalGranted: false,
        maxTradeSizePusd: 100,
        maxDailySpendPusd: 500,
        maxDailyLossPusd: 50,
        maxMarketExposurePusd: 200,
        maxOpenOrders: 10,
        maxSlippageBps: 50,
        categoryBlacklist: ["politics"],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("category_blacklisted");
  });

  it("blocks production money movement until Phase 0 exits and requires compatibility decision", () => {
    expect(PHASE0_EXIT_CRITERIA.length).toBeGreaterThanOrEqual(10);
    expect(() => assertPhase0NotPassedForProduction(false)).toThrow(/blocked/);
    expect(() => assertCompatibilityDecisionRecorded({
      decision: "standard_evm_wallet_required",
      documented: true,
      evidencePath: "reports/polymarket-phase0/phantom-compat.md",
      reason: "fixture",
    })).not.toThrow();
  });
});
