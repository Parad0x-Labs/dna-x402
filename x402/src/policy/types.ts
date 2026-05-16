export type PolicyDecisionState =
  | "ALLOW"
  | "ALLOW_WITH_LIMITS"
  | "REVIEW_REQUIRED"
  | "BLOCK"
  | "SUSPEND_SELLER"
  | "SUSPEND_BUYER"
  | "DISABLE_LISTING";

export type ScreeningStatus = "UNKNOWN" | "CLEAR" | "HIT" | "REVIEW";
export type VerificationStatus = "NOT_REQUIRED" | "UNKNOWN" | "PENDING" | "VERIFIED" | "FAILED";
export type TaxProfileStatus = "NOT_REQUIRED" | "MISSING" | "PENDING" | "VALIDATED";
export type ListingRiskTier = "LOW" | "MEDIUM" | "HIGH" | "BLOCKED";
export type TransactionAction =
  | "PUBLISH"
  | "QUOTE"
  | "COMMIT"
  | "FINALIZE"
  | "FULFILL"
  | "WITHDRAW"
  | "REFUND"
  | "PAYOUT";
export type TaxThresholdStatus = "BELOW_THRESHOLD" | "NEAR_THRESHOLD" | "ABOVE_THRESHOLD" | "UNKNOWN";
export type DataResidencyRegion = "EU" | "US" | "GLOBAL" | "UNKNOWN";
export type ErasureImpact = "NONE" | "OFFCHAIN_ONLY" | "HASH_REMAINS" | "REQUIRES_REDACTION";

export interface PolicyInputV1 {
  actor: {
    buyerWallet?: string;
    sellerWallet?: string;
    sellerProfileId?: string;
    agentId?: string;
    sessionId?: string;
    countryHint?: string;
    jurisdictionFlags: string[];
    sanctionsScreeningStatus?: ScreeningStatus;
    kycStatus?: VerificationStatus;
    kybStatus?: VerificationStatus;
    taxProfileStatus?: TaxProfileStatus;
  };
  listing: {
    listingId?: string;
    manifestHash?: string;
    category: string;
    capabilityTags: string[];
    riskTier: ListingRiskTier;
    physicalGoods: boolean;
    regulatedGoods: boolean;
    publicMarketplace: boolean;
  };
  transaction: {
    action: TransactionAction;
    amount?: string;
    token?: string;
    chain?: string;
    settlementMode?: string;
    countryPair?: {
      buyer?: string;
      seller?: string;
    };
  };
  reputation: {
    sellerRiskTier?: string;
    buyerRiskTier?: string;
    badges: string[];
    policyStrikes: number;
    disputeRate?: number;
    refundRate?: number;
    fulfilledVolumeConfidence?: "LOW" | "MEDIUM" | "HIGH";
  };
  compliance: {
    taxReportingRequired?: boolean;
    taxThresholdStatus?: TaxThresholdStatus;
    amlMonitoringFlags: string[];
    ofacFlags: string[];
    reviewReasonCodes: string[];
  };
  privacy: {
    containsPersonalData: boolean;
    dataResidencyRegion?: DataResidencyRegion;
    erasureImpact?: ErasureImpact;
  };
  system: {
    emergencyPaused: boolean;
    marketplacePaused: boolean;
    finalizePaused: boolean;
    policyVersion: string;
  };
}

export interface PolicyDecision {
  decisionId: string;
  state: PolicyDecisionState;
  reasonCodes: string[];
  normalizedInputHash: string;
  policyVersion: string;
  createdAt: string;
}

export interface PolicyAuditEvent {
  eventId: string;
  decisionId: string;
  state: PolicyDecisionState;
  reasonCodes: string[];
  normalizedInputHash: string;
  policyVersion: string;
  createdAt: string;
}

export interface SanctionsScreeningProvider {
  screenWallet(wallet: string): Promise<ScreeningStatus>;
}

export interface IdentityVerificationProvider {
  sellerStatus(sellerProfileId: string): Promise<VerificationStatus>;
}
