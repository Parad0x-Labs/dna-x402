import { parseAtomic } from "../feePolicy.js";

export interface AgentSpendPolicy {
  agentId: string;
  ownerWallet: string;
  allowedCapabilities: string[];
  blockedCapabilities: string[];
  maxSpendPerCall: string;
  maxSpendPerDay: string;
  maxSpendPerSeller: string;
  maxBundleDepth: number;
  allowedSettlementModes: string[];
  allowedTokens: string[];
  expiresAt: string;
  requiresHumanApprovalAbove: string;
  canUseNetting: boolean;
  canUseStreaming: boolean;
  canDelegateToSubagents: boolean;
  revokedAt?: string;
}

export interface AgentSpendAttempt {
  agentId: string;
  sellerId: string;
  capability: string;
  amountAtomic: string;
  token: string;
  settlementMode: string;
  bundleDepth: number;
  spentTodayAtomic: string;
  spentWithSellerAtomic: string;
  now: Date;
}

export interface AgentSpendDecision {
  ok: boolean;
  requiresHumanApproval: boolean;
  reasonCodes: string[];
}

export function evaluateAgentSpend(policy: AgentSpendPolicy, attempt: AgentSpendAttempt): AgentSpendDecision {
  const reasons: string[] = [];
  const amount = parseAtomic(attempt.amountAtomic);

  if (policy.revokedAt) {
    reasons.push("revoked_session");
  }
  if (new Date(policy.expiresAt).getTime() <= attempt.now.getTime()) {
    reasons.push("expired_session");
  }
  if (policy.blockedCapabilities.includes(attempt.capability)) {
    reasons.push("blocked_capability");
  }
  if (policy.allowedCapabilities.length > 0 && !policy.allowedCapabilities.includes(attempt.capability)) {
    reasons.push("capability_not_allowed");
  }
  if (!policy.allowedTokens.includes(attempt.token)) {
    reasons.push("token_not_allowed");
  }
  if (!policy.allowedSettlementModes.includes(attempt.settlementMode)) {
    reasons.push("settlement_not_allowed");
  }
  if (attempt.settlementMode === "netting" && !policy.canUseNetting) {
    reasons.push("netting_not_allowed");
  }
  if (attempt.settlementMode === "stream" && !policy.canUseStreaming) {
    reasons.push("streaming_not_allowed");
  }
  if (attempt.bundleDepth > policy.maxBundleDepth) {
    reasons.push("bundle_depth_exceeded");
  }
  if (amount > parseAtomic(policy.maxSpendPerCall)) {
    reasons.push("per_call_limit_exceeded");
  }
  if (amount + parseAtomic(attempt.spentTodayAtomic) > parseAtomic(policy.maxSpendPerDay)) {
    reasons.push("daily_limit_exceeded");
  }
  if (amount + parseAtomic(attempt.spentWithSellerAtomic) > parseAtomic(policy.maxSpendPerSeller)) {
    reasons.push("seller_limit_exceeded");
  }

  return {
    ok: reasons.length === 0,
    requiresHumanApproval: amount > parseAtomic(policy.requiresHumanApprovalAbove),
    reasonCodes: reasons,
  };
}
