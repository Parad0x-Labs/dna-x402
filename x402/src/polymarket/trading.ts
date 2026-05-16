import type { Phase0SdkSnapshot } from "./types.js";

export type PolymarketOrderSide = "YES" | "NO";

export interface DepositWalletOrderSemantics {
  depositWallet: string;
  funder: string;
  signatureType: 3 | "POLY_1271" | number | string;
}

export interface OrderValidationInput extends DepositWalletOrderSemantics {
  complianceAllowed: boolean;
  marketActive: boolean;
  orderbookEnabled: boolean;
  tokenId?: string;
  side?: PolymarketOrderSide;
  price: number;
  size: number;
  tickSize: number;
  minSize: number;
  negRiskKnown: boolean;
  pUsdAvailable: number;
  allowanceApproved: boolean;
  orderbookFresh: boolean;
  duplicateRetrySafe: boolean;
  rateLimitAllowed: boolean;
  maxSlippageBps: number;
  estimatedSlippageBps: number;
  riskControlsPassed: boolean;
  builderCode?: string;
  activeLocalSignerAvailable: boolean;
  riskControls?: UserRiskControlInput;
}

export interface OrderValidationResult {
  ok: boolean;
  errors: string[];
}

export interface UserRiskControlInput {
  tradeSizePusd: number;
  projectedDailySpendPusd: number;
  projectedDailyLossPusd: number;
  projectedMarketExposurePusd: number;
  projectedOpenOrders: number;
  estimatedSlippageBps: number;
  marketCategory: string;
  dryRun: boolean;
  manualApprovalRequired: boolean;
  manualApprovalGranted: boolean;
  maxTradeSizePusd: number;
  maxDailySpendPusd: number;
  maxDailyLossPusd: number;
  maxMarketExposurePusd: number;
  maxOpenOrders: number;
  maxSlippageBps: number;
  categoryBlacklist: string[];
}

function isPoly1271(signatureType: DepositWalletOrderSemantics["signatureType"]): boolean {
  return signatureType === 3 || signatureType === "POLY_1271";
}

export function validateDepositWalletOrderSemantics(input: DepositWalletOrderSemantics): string[] {
  const errors: string[] = [];
  if (!input.depositWallet) errors.push("deposit_wallet_missing");
  if (!input.funder) errors.push("funder_missing");
  if (input.depositWallet && input.funder && input.funder.toLowerCase() !== input.depositWallet.toLowerCase()) {
    errors.push("deposit_wallet_must_be_funder");
  }
  if (!isPoly1271(input.signatureType)) {
    errors.push("signature_type_must_be_poly_1271");
  }
  return errors;
}

export function validateUserRiskControls(input: UserRiskControlInput): OrderValidationResult {
  const errors: string[] = [];
  if (input.tradeSizePusd > input.maxTradeSizePusd) errors.push("max_trade_size_exceeded");
  if (input.projectedDailySpendPusd > input.maxDailySpendPusd) errors.push("max_daily_spend_exceeded");
  if (input.projectedDailyLossPusd > input.maxDailyLossPusd) errors.push("max_daily_loss_exceeded");
  if (input.projectedMarketExposurePusd > input.maxMarketExposurePusd) errors.push("max_market_exposure_exceeded");
  if (input.projectedOpenOrders > input.maxOpenOrders) errors.push("max_open_orders_exceeded");
  if (input.estimatedSlippageBps > input.maxSlippageBps) errors.push("max_slippage_exceeded");
  const category = input.marketCategory.trim().toLowerCase();
  if (input.categoryBlacklist.map((item) => item.trim().toLowerCase()).includes(category)) {
    errors.push("category_blacklisted");
  }
  if (input.dryRun) errors.push("dry_run_blocks_submit");
  if (input.manualApprovalRequired && !input.manualApprovalGranted) errors.push("manual_approval_required");
  return { ok: errors.length === 0, errors };
}

export function validateOrderForSubmission(input: OrderValidationInput): OrderValidationResult {
  const errors = validateDepositWalletOrderSemantics(input);
  if (!input.complianceAllowed) errors.push("geoblock_or_compliance_blocked");
  if (!input.marketActive) errors.push("market_inactive");
  if (!input.orderbookEnabled) errors.push("orderbook_disabled");
  if (!input.tokenId) errors.push("token_id_missing");
  if (!input.side) errors.push("side_missing");
  if (!Number.isFinite(input.price) || input.price <= 0 || input.price >= 1) errors.push("price_out_of_bounds");
  if (input.tickSize <= 0 || Math.round(input.price / input.tickSize) * input.tickSize !== input.price) {
    errors.push("tick_size_violation");
  }
  if (input.size < input.minSize) errors.push("min_size_violation");
  if (!input.negRiskKnown) errors.push("neg_risk_unknown");
  if (input.pUsdAvailable < input.size * input.price) errors.push("insufficient_pusd");
  if (!input.allowanceApproved) errors.push("missing_allowance_or_approval");
  if (!input.orderbookFresh) errors.push("stale_orderbook");
  if (!input.duplicateRetrySafe) errors.push("duplicate_retry_not_idempotent");
  if (!input.rateLimitAllowed) errors.push("rate_limited");
  if (input.estimatedSlippageBps > input.maxSlippageBps) errors.push("max_slippage_exceeded");
  if (!input.riskControlsPassed) errors.push("risk_controls_failed");
  if (input.riskControls) {
    errors.push(...validateUserRiskControls(input.riskControls).errors);
  }
  if (!input.builderCode) errors.push("builder_code_missing");
  if (!input.activeLocalSignerAvailable) errors.push("active_local_signer_missing");
  return { ok: errors.length === 0, errors };
}

export function validatePhase0SdkSnapshot(snapshot: Phase0SdkSnapshot): void {
  const errors = validateDepositWalletOrderSemantics({
    depositWallet: snapshot.depositWallet,
    funder: snapshot.funder,
    signatureType: snapshot.signatureType,
  });
  if (!snapshot.maker) errors.push("snapshot_maker_missing");
  if (!snapshot.signer) errors.push("snapshot_signer_missing");
  if (!snapshot.apiKeyAddressBehavior) errors.push("snapshot_api_key_behavior_missing");
  if (!snapshot.ownerSessionSignerBehavior) errors.push("snapshot_owner_session_behavior_missing");
  if (!snapshot.builderCode) errors.push("snapshot_builder_code_missing");
  if (!snapshot.signedOrderPayloadHash) errors.push("snapshot_signed_payload_hash_missing");
  if (errors.length > 0) {
    throw new Error(`Phase 0 SDK snapshot invalid: ${errors.join(", ")}`);
  }
}

// TODO(phase0-clob-sdk-semantics): keep maker/signer/API-key behavior fixture-based.
// The production path must not hardcode maker/signer assumptions before the live
// TS SDK fixture proves exact CLOB v2 semantics.
