export interface SellerRiskProfile {
  sellerProfileId: string;
  primaryWallet?: string;
  linkedWallets?: string[];
  slugs?: string[];
  domains?: string[];
  receiptGraphIds?: string[];
  disputeCount?: number;
  refundCount?: number;
  governanceActionIds?: string[];
}

export interface SellerPolicyStrikeRecord {
  sellerProfileId: string;
  count: number;
  reasonCodes?: string[];
}

export interface RelistCandidate {
  wallet?: string;
  linkedWallets?: string[];
  slug?: string;
  domain?: string;
  receiptGraphIds?: string[];
}

export interface SellerRelistRisk {
  sellerProfileId?: string;
  matchedSignals: string[];
  policyStrikes: number;
  clusteredRisk: boolean;
  cleanTrustAllowed: boolean;
}

function lowerSet(values: Array<string | undefined> | undefined): Set<string> {
  return new Set((values ?? []).filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase()));
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  for (const item of left) {
    if (right.has(item)) {
      return true;
    }
  }
  return false;
}

export function evaluateSellerRelistRisk(input: {
  profiles: SellerRiskProfile[];
  strikes: SellerPolicyStrikeRecord[];
  candidate: RelistCandidate;
}): SellerRelistRisk {
  const candidateWallets = lowerSet([input.candidate.wallet, ...(input.candidate.linkedWallets ?? [])]);
  const candidateSlugs = lowerSet([input.candidate.slug]);
  const candidateDomains = lowerSet([input.candidate.domain]);
  const candidateReceipts = lowerSet(input.candidate.receiptGraphIds);

  for (const profile of input.profiles) {
    const matchedSignals: string[] = [];
    const profileWallets = lowerSet([profile.primaryWallet, ...(profile.linkedWallets ?? [])]);
    const profileSlugs = lowerSet(profile.slugs);
    const profileDomains = lowerSet(profile.domains);
    const profileReceipts = lowerSet(profile.receiptGraphIds);

    if (intersects(profileWallets, candidateWallets)) {
      matchedSignals.push("linked_wallet");
    }
    if (intersects(profileSlugs, candidateSlugs)) {
      matchedSignals.push("slug");
    }
    if (intersects(profileDomains, candidateDomains)) {
      matchedSignals.push("domain");
    }
    if (intersects(profileReceipts, candidateReceipts)) {
      matchedSignals.push("receipt_graph");
    }

    if (matchedSignals.length === 0) {
      continue;
    }

    const policyStrikes = input.strikes
      .filter((strike) => strike.sellerProfileId === profile.sellerProfileId)
      .reduce((sum, strike) => sum + strike.count, 0);
    const behaviorRisk = (profile.disputeCount ?? 0) > 0
      || (profile.refundCount ?? 0) > 0
      || (profile.governanceActionIds?.length ?? 0) > 0;
    const clusteredRisk = policyStrikes > 0 || behaviorRisk;
    return {
      sellerProfileId: profile.sellerProfileId,
      matchedSignals,
      policyStrikes,
      clusteredRisk,
      cleanTrustAllowed: !clusteredRisk,
    };
  }

  return {
    matchedSignals: [],
    policyStrikes: 0,
    clusteredRisk: false,
    cleanTrustAllowed: true,
  };
}
