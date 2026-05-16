import { findPiiIssues } from "./pii.js";

export type ImmutableRecordKind =
  | "RECEIPT"
  | "POLICY_AUDIT_EVENT"
  | "GOVERNANCE_AUDIT_EVENT"
  | "MARKET_EVENT"
  | "ANCHOR_PAYLOAD"
  | "PROOF_RECORD"
  | "WEBHOOK_IMMUTABLE_LOG";

export interface PiiGuardResult {
  ok: boolean;
  blockedFields: string[];
  reasonCodes: string[];
}

export function checkImmutableRecordSafe(kind: ImmutableRecordKind, payload: unknown): PiiGuardResult {
  const issues = findPiiIssues(payload);
  return {
    ok: issues.length === 0,
    blockedFields: issues.map((issue) => issue.split(":")[0] || kind),
    reasonCodes: issues.length === 0 ? [] : issues.map(() => `${kind}_RAW_PII_BLOCKED`),
  };
}

export function assertImmutableRecordSafe(kind: ImmutableRecordKind, payload: unknown): void {
  const result = checkImmutableRecordSafe(kind, payload);
  if (!result.ok) {
    throw new Error(`PII_FORBIDDEN IMMUTABLE_PII_BLOCKED: ${kind}: ${result.blockedFields.join(", ")}`);
  }
}
