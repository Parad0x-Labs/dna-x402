export interface PolicyRuleChange {
  changeId: string;
  ruleId: string;
  action: "CREATE" | "UPDATE" | "DISABLE";
  proposedBy: string;
  approvedBy?: string;
  reason: string;
  diff: unknown;
  status: "PROPOSED" | "APPROVED" | "REJECTED" | "ROLLED_BACK";
  createdAt: string;
  effectiveAt?: string;
}

export interface DenylistEntry {
  entryId: string;
  subjectType: "WALLET" | "SELLER_PROFILE" | "LISTING" | "DOMAIN" | "CAPABILITY" | "CATEGORY";
  subjectValue: string;
  reasonCode: string;
  evidenceRefs: string[];
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  status: "ACTIVE" | "EXPIRED" | "REVOKED";
  createdBy: string;
  expiresAt?: string;
}

export interface PolicyAppeal {
  appealId: string;
  subjectType: "SELLER" | "BUYER" | "LISTING" | "WALLET";
  subjectId: string;
  policyDecisionId: string;
  reason: string;
  evidenceRefs: string[];
  status: "OPEN" | "UNDER_REVIEW" | "APPROVED" | "REJECTED";
  reviewer?: string;
  resolutionReason?: string;
}

export type GovernanceAdminRole = "policy_proposer" | "policy_approver" | "appeal_reviewer" | "emergency_operator";
