import { stableHash } from "../common/stable.js";
import { assertImmutableRecordSafe } from "../privacy/immutableGuard.js";
import {
  PolicyAuditEvent,
  PolicyDecision,
  PolicyDecisionState,
  PolicyInputV1,
  ScreeningStatus,
  TaxProfileStatus,
  TaxThresholdStatus,
  VerificationStatus,
} from "./types.js";

export const POLICY_VERSION_V1 = "policy-v1";

export interface PolicyEngineOptions {
  now?: () => Date;
  restrictedCategories?: string[];
  restrictedCapabilities?: string[];
}

const DEFAULT_RESTRICTED_CATEGORIES = [
  "gambling",
  "betting",
  "prediction_market",
  "physical_goods_public",
  "regulated_goods",
  "proxy",
  "malware",
  "exploit",
];

const DEFAULT_RESTRICTED_CAPABILITIES = [
  "sports_betting",
  "wager",
  "bookmaker",
  "casino",
  "residential_proxy",
  "credential",
  "keylogger",
  "ddos",
];

function defaultScreening(value?: ScreeningStatus): ScreeningStatus {
  return value ?? "UNKNOWN";
}

function defaultVerification(value?: VerificationStatus): VerificationStatus {
  return value ?? "UNKNOWN";
}

function defaultTax(value?: TaxProfileStatus): TaxProfileStatus {
  return value ?? "MISSING";
}

function defaultTaxThreshold(value?: TaxThresholdStatus): TaxThresholdStatus {
  return value ?? "UNKNOWN";
}

function sorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

export function normalizePolicyInput(input: Partial<PolicyInputV1>): PolicyInputV1 {
  return {
    actor: {
      buyerWallet: input.actor?.buyerWallet,
      sellerWallet: input.actor?.sellerWallet,
      sellerProfileId: input.actor?.sellerProfileId,
      agentId: input.actor?.agentId,
      sessionId: input.actor?.sessionId,
      countryHint: input.actor?.countryHint,
      jurisdictionFlags: sorted(input.actor?.jurisdictionFlags ?? ["UNKNOWN"]),
      sanctionsScreeningStatus: defaultScreening(input.actor?.sanctionsScreeningStatus),
      kycStatus: defaultVerification(input.actor?.kycStatus),
      kybStatus: defaultVerification(input.actor?.kybStatus),
      taxProfileStatus: defaultTax(input.actor?.taxProfileStatus),
    },
    listing: {
      listingId: input.listing?.listingId,
      manifestHash: input.listing?.manifestHash,
      category: input.listing?.category ?? "UNKNOWN",
      capabilityTags: sorted(input.listing?.capabilityTags ?? ["UNKNOWN"]),
      riskTier: input.listing?.riskTier ?? "MEDIUM",
      physicalGoods: input.listing?.physicalGoods ?? false,
      regulatedGoods: input.listing?.regulatedGoods ?? false,
      publicMarketplace: input.listing?.publicMarketplace ?? true,
    },
    transaction: {
      action: input.transaction?.action ?? "QUOTE",
      amount: input.transaction?.amount,
      token: input.transaction?.token,
      chain: input.transaction?.chain,
      settlementMode: input.transaction?.settlementMode,
      countryPair: input.transaction?.countryPair,
    },
    reputation: {
      sellerRiskTier: input.reputation?.sellerRiskTier ?? "UNKNOWN",
      buyerRiskTier: input.reputation?.buyerRiskTier ?? "UNKNOWN",
      badges: sorted(input.reputation?.badges ?? []),
      policyStrikes: Math.max(0, input.reputation?.policyStrikes ?? 0),
      disputeRate: input.reputation?.disputeRate,
      refundRate: input.reputation?.refundRate,
      fulfilledVolumeConfidence: input.reputation?.fulfilledVolumeConfidence ?? "LOW",
    },
    compliance: {
      taxReportingRequired: input.compliance?.taxReportingRequired ?? false,
      taxThresholdStatus: defaultTaxThreshold(input.compliance?.taxThresholdStatus),
      amlMonitoringFlags: sorted(input.compliance?.amlMonitoringFlags ?? []),
      ofacFlags: sorted(input.compliance?.ofacFlags ?? []),
      reviewReasonCodes: sorted(input.compliance?.reviewReasonCodes ?? []),
    },
    privacy: {
      containsPersonalData: input.privacy?.containsPersonalData ?? false,
      dataResidencyRegion: input.privacy?.dataResidencyRegion ?? "UNKNOWN",
      erasureImpact: input.privacy?.erasureImpact ?? "NONE",
    },
    system: {
      emergencyPaused: input.system?.emergencyPaused ?? false,
      marketplacePaused: input.system?.marketplacePaused ?? false,
      finalizePaused: input.system?.finalizePaused ?? false,
      policyVersion: input.system?.policyVersion ?? POLICY_VERSION_V1,
    },
  };
}

function rankState(a: PolicyDecisionState, b: PolicyDecisionState): PolicyDecisionState {
  const order: PolicyDecisionState[] = [
    "ALLOW",
    "ALLOW_WITH_LIMITS",
    "REVIEW_REQUIRED",
    "DISABLE_LISTING",
    "SUSPEND_BUYER",
    "SUSPEND_SELLER",
    "BLOCK",
  ];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

function decideState(reasons: string[]): PolicyDecisionState {
  let state: PolicyDecisionState = "ALLOW";
  for (const reason of reasons) {
    if (reason.startsWith("BLOCK_")) {
      state = rankState("BLOCK", state);
    } else if (reason.startsWith("SUSPEND_SELLER_")) {
      state = rankState("SUSPEND_SELLER", state);
    } else if (reason.startsWith("SUSPEND_BUYER_")) {
      state = rankState("SUSPEND_BUYER", state);
    } else if (reason.startsWith("DISABLE_LISTING_")) {
      state = rankState("DISABLE_LISTING", state);
    } else if (reason.startsWith("REVIEW_")) {
      state = rankState("REVIEW_REQUIRED", state);
    } else if (reason.startsWith("LIMIT_")) {
      state = rankState("ALLOW_WITH_LIMITS", state);
    }
  }
  return state;
}

export class PolicyEngine {
  private readonly now: () => Date;
  private readonly restrictedCategories: Set<string>;
  private readonly restrictedCapabilities: Set<string>;

  constructor(options: PolicyEngineOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.restrictedCategories = new Set(options.restrictedCategories ?? DEFAULT_RESTRICTED_CATEGORIES);
    this.restrictedCapabilities = new Set(options.restrictedCapabilities ?? DEFAULT_RESTRICTED_CAPABILITIES);
  }

  decide(input: Partial<PolicyInputV1>): PolicyDecision {
    const normalized = normalizePolicyInput(input);
    const reasons: string[] = [];

    if (normalized.system.emergencyPaused) {
      reasons.push("BLOCK_EMERGENCY_PAUSED");
    }
    if (normalized.system.marketplacePaused && ["PUBLISH", "QUOTE", "COMMIT"].includes(normalized.transaction.action)) {
      reasons.push("BLOCK_MARKETPLACE_PAUSED");
    }
    if (normalized.system.finalizePaused && normalized.transaction.action === "FINALIZE") {
      reasons.push("BLOCK_FINALIZE_PAUSED");
    }
    if (normalized.actor.sanctionsScreeningStatus === "HIT" || normalized.compliance.ofacFlags.length > 0) {
      reasons.push("BLOCK_SANCTIONS_HIT");
    }
    if (normalized.actor.sanctionsScreeningStatus === "REVIEW" || normalized.compliance.reviewReasonCodes.length > 0) {
      reasons.push("REVIEW_COMPLIANCE_SIGNAL");
    }
    if (normalized.actor.kycStatus === "FAILED") {
      reasons.push("SUSPEND_BUYER_KYC_FAILED");
    }
    if (normalized.actor.kybStatus === "FAILED") {
      reasons.push("SUSPEND_SELLER_KYB_FAILED");
    }
    if (normalized.listing.riskTier === "BLOCKED") {
      reasons.push("DISABLE_LISTING_BLOCKED_RISK_TIER");
    }
    if (normalized.listing.regulatedGoods) {
      reasons.push("BLOCK_REGULATED_GOODS");
    }
    if (normalized.listing.physicalGoods && normalized.listing.publicMarketplace) {
      reasons.push("REVIEW_PUBLIC_PHYSICAL_GOODS_GATED");
    }
    if (normalized.listing.publicMarketplace && this.restrictedCategories.has(normalized.listing.category)) {
      reasons.push("BLOCK_RESTRICTED_CATEGORY");
    }
    if (normalized.listing.capabilityTags.some((tag) => this.restrictedCapabilities.has(tag))) {
      reasons.push("BLOCK_RESTRICTED_CAPABILITY");
    }
    if (normalized.reputation.policyStrikes >= 3) {
      reasons.push("SUSPEND_SELLER_POLICY_STRIKES");
    } else if (normalized.reputation.policyStrikes > 0) {
      reasons.push("REVIEW_POLICY_STRIKE");
    }
    if ((normalized.reputation.disputeRate ?? 0) >= 0.2) {
      reasons.push("REVIEW_HIGH_DISPUTE_RATE");
    }
    if (normalized.transaction.action === "PAYOUT"
      && normalized.compliance.taxThresholdStatus === "ABOVE_THRESHOLD"
      && normalized.actor.taxProfileStatus !== "VALIDATED") {
      reasons.push("BLOCK_TAX_PROFILE_REQUIRED_FOR_PAYOUT");
    }
    if (normalized.transaction.action === "PAYOUT"
      && normalized.compliance.taxThresholdStatus === "NEAR_THRESHOLD"
      && normalized.actor.taxProfileStatus !== "VALIDATED") {
      reasons.push("LIMIT_TAX_PROFILE_MISSING_NEAR_THRESHOLD");
    }
    if (normalized.privacy.containsPersonalData && normalized.privacy.erasureImpact === "REQUIRES_REDACTION") {
      reasons.push("REVIEW_PERSONAL_DATA_REDACTION_REQUIRED");
    }

    const normalizedInputHash = stableHash(normalized);
    const reasonCodes = reasons.length > 0 ? reasons.sort() : ["ALLOW_DEFAULT"];
    const state = decideState(reasonCodes);
    return {
      decisionId: stableHash({
        policyVersion: normalized.system.policyVersion,
        normalizedInputHash,
        reasonCodes,
        state,
      }),
      state,
      reasonCodes,
      normalizedInputHash,
      policyVersion: normalized.system.policyVersion,
      createdAt: this.now().toISOString(),
    };
  }

  auditEvent(decision: PolicyDecision): PolicyAuditEvent {
    const event: PolicyAuditEvent = {
      eventId: stableHash({
        decisionId: decision.decisionId,
        normalizedInputHash: decision.normalizedInputHash,
        state: decision.state,
        createdAt: decision.createdAt,
      }),
      decisionId: decision.decisionId,
      state: decision.state,
      reasonCodes: decision.reasonCodes,
      normalizedInputHash: decision.normalizedInputHash,
      policyVersion: decision.policyVersion,
      createdAt: decision.createdAt,
    };
    assertImmutableRecordSafe("POLICY_AUDIT_EVENT", event);
    return event;
  }
}
