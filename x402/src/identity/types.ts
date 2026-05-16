export type SellerRiskTier = "LOW" | "MEDIUM" | "HIGH" | "SUSPENDED";

export type ReputationBadge =
  | "NEW"
  | "VERIFIED_DOMAIN"
  | "VERIFIED_SELLER"
  | "BONDED"
  | "FAST_FULFILLER"
  | "HIGH_DISPUTE_RATE"
  | "POLICY_STRIKE"
  | "SUSPENDED"
  | "ANCHOR_VERIFIED";

export interface SellerProfile {
  sellerProfileId: string;
  primaryWallet: string;
  linkedWallets: string[];
  agentSlugs: string[];
  verifiedDomains: string[];
  emailVerified: boolean;
  oauthVerified: boolean;
  kybStatus: "NOT_REQUIRED" | "UNKNOWN" | "PENDING" | "VERIFIED" | "FAILED";
  kycStatus: "NOT_REQUIRED" | "UNKNOWN" | "PENDING" | "VERIFIED" | "FAILED";
  bondState: "NONE" | "POSTED" | "SLASHED" | "REFUNDED";
  policyStrikes: number;
  disputeCount: number;
  refundCount: number;
  fulfilledCount: number;
  fulfilledVolumeAtomic: string;
  failedFulfillmentCount: number;
  createdAt: string;
  updatedAt: string;
  suspendedAt?: string;
}

export interface SellerTrustSnapshot {
  sellerProfileId: string;
  riskTier: SellerRiskTier;
  badges: ReputationBadge[];
  fulfilledVolumeConfidence: "LOW" | "MEDIUM" | "HIGH";
  rankingPenalty: number;
}

export function sellerTrustSnapshot(profile: SellerProfile): SellerTrustSnapshot {
  const badges: ReputationBadge[] = [];
  if (profile.suspendedAt || profile.policyStrikes >= 3) {
    badges.push("SUSPENDED");
  }
  if (profile.verifiedDomains.length > 0) {
    badges.push("VERIFIED_DOMAIN");
  }
  if (profile.kybStatus === "VERIFIED" || profile.kycStatus === "VERIFIED") {
    badges.push("VERIFIED_SELLER");
  }
  if (profile.bondState === "POSTED") {
    badges.push("BONDED");
  }
  if (profile.policyStrikes > 0) {
    badges.push("POLICY_STRIKE");
  }
  if (profile.disputeCount > Math.max(2, profile.fulfilledCount * 0.1)) {
    badges.push("HIGH_DISPUTE_RATE");
  }
  if (profile.fulfilledCount >= 20 && profile.failedFulfillmentCount / Math.max(1, profile.fulfilledCount) <= 0.02) {
    badges.push("FAST_FULFILLER");
  }
  if (badges.length === 0) {
    badges.push("NEW");
  }

  const fulfilledVolume = BigInt(profile.fulfilledVolumeAtomic || "0");
  const fulfilledVolumeConfidence =
    profile.fulfilledCount >= 50 && fulfilledVolume > 100_000_000n
      ? "HIGH"
      : profile.fulfilledCount >= 10
        ? "MEDIUM"
        : "LOW";

  const riskTier: SellerRiskTier = badges.includes("SUSPENDED")
    ? "SUSPENDED"
    : profile.policyStrikes > 0 || badges.includes("HIGH_DISPUTE_RATE")
      ? "HIGH"
      : badges.includes("VERIFIED_SELLER") || badges.includes("BONDED")
        ? "LOW"
        : "MEDIUM";

  return {
    sellerProfileId: profile.sellerProfileId,
    riskTier,
    badges,
    fulfilledVolumeConfidence,
    rankingPenalty: Math.min(100, profile.policyStrikes * 25 + profile.disputeCount * 5 + profile.failedFulfillmentCount * 2),
  };
}
