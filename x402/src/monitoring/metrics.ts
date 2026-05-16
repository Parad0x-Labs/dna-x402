import type { AuditLogger } from "../logging/audit.js";
import type { X402AppContext } from "../server.js";

function line(name: string, value: number, labels: Record<string, string> = {}): string {
  const labelEntries = Object.entries(labels);
  const suffix = labelEntries.length === 0
    ? ""
    : `{${labelEntries.map(([key, item]) => `${key}="${item.replace(/"/g, '\\"')}"`).join(",")}}`;
  return `${name}${suffix} ${Number.isFinite(value) ? value : 0}`;
}

function countAudit(auditLog: AuditLogger, kind: string): number {
  return auditLog.query({ kind: kind as never, limit: 10_000 }).length;
}

function countImmutablePiiBlocks(auditLog: AuditLogger): number {
  const receiptBlocks = countAudit(auditLog, "RECEIPT_BLOCKED");
  const webhookBlocks = auditLog.query({ kind: "WEBHOOK_FAILED", limit: 10_000 })
    .filter((entry) => {
      const reason = String(entry.meta?.reason ?? entry.errorMessage ?? "").toLowerCase();
      return reason.includes("pii") || reason.includes("immutable");
    })
    .length;

  return receiptBlocks + webhookBlocks;
}

function sumAuditAmount(auditLog: AuditLogger, kind: string): number {
  return auditLog.query({ kind: kind as never, limit: 10_000 })
    .reduce((sum, entry) => sum + Number(entry.amountAtomic ?? 0), 0);
}

function countObservedAgents(context: X402AppContext, auditLog: AuditLogger): number {
  const agents = new Set(context.observedAgentIds ?? []);
  for (const entry of auditLog.query({ limit: 10_000 })) {
    const actor = entry.actor;
    if (actor && /^agent[-_:]/i.test(actor)) {
      agents.add(actor);
    }
  }
  return agents.size;
}

export function renderX402Metrics(context: X402AppContext, auditLog: AuditLogger): string {
  const summary = auditLog.summary();
  const policyBlocks = context.market.policyAuditEvents.filter((event) => !["ALLOW", "ALLOW_WITH_LIMITS"].includes(event.state)).length;
  const policyReviews = context.market.policyAuditEvents.filter((event) => event.state === "REVIEW_REQUIRED").length;
  const emergencyState = context.emergencyPause.snapshot();
  const anyEmergencyPause = Object.values(emergencyState).some((value) => value === true) ? 1 : 0;
  const governanceEntries = context.governance.listDenylistEntries();
  const appealsOpen = context.governance.listAppeals().filter((appeal) => appeal.status === "OPEN" || appeal.status === "UNDER_REVIEW").length;
  const realChainFeeAccruedAtomic = context.realChainFeeAccruals.reduce((sum, item) => sum + Number(item.platformFeeAtomic), 0);

  const rows = [
    "# HELP x402_quotes_created_total Quotes currently held by this server process.",
    "# TYPE x402_quotes_created_total counter",
    line("x402_quotes_created_total", context.quotes.size),
    "# HELP x402_commits_created_total Commits currently held by this server process.",
    "# TYPE x402_commits_created_total counter",
    line("x402_commits_created_total", context.commits.size),
    "# HELP x402_finalize_success_total Successful payment finalizations observed by audit log.",
    "# TYPE x402_finalize_success_total counter",
    line("x402_finalize_success_total", summary.paymentsVerified),
    "# HELP x402_finalize_rejected_total Rejected payment finalizations observed by audit log.",
    "# TYPE x402_finalize_rejected_total counter",
    line("x402_finalize_rejected_total", summary.paymentsRejected),
    "# HELP x402_receipts_issued_total Receipts issued.",
    "# TYPE x402_receipts_issued_total counter",
    line("x402_receipts_issued_total", summary.receiptsIssued),
    "# HELP x402_volume_atomic_total Verified payment volume in atomic token units.",
    "# TYPE x402_volume_atomic_total counter",
    line("x402_volume_atomic_total", sumAuditAmount(auditLog, "PAYMENT_VERIFIED")),
    "# HELP x402_agents_observed_total Distinct x-dna-agent-id actors observed by this process.",
    "# TYPE x402_agents_observed_total gauge",
    line("x402_agents_observed_total", countObservedAgents(context, auditLog)),
    "# HELP x402_real_chain_fee_accruals_total Non-custodial real-chain fee accrual records.",
    "# TYPE x402_real_chain_fee_accruals_total counter",
    line("x402_real_chain_fee_accruals_total", context.realChainFeeAccruals.length),
    "# HELP x402_real_chain_fee_accrued_atomic_total Non-custodial fee accrual amount in atomic token units.",
    "# TYPE x402_real_chain_fee_accrued_atomic_total counter",
    line("x402_real_chain_fee_accrued_atomic_total", realChainFeeAccruedAtomic),
    "# HELP x402_policy_blocks_total Policy decisions that blocked or routed away from allow.",
    "# TYPE x402_policy_blocks_total counter",
    line("x402_policy_blocks_total", policyBlocks),
    "# HELP x402_policy_reviews_total Policy decisions requiring review.",
    "# TYPE x402_policy_reviews_total counter",
    line("x402_policy_reviews_total", policyReviews),
    "# HELP x402_pii_blocks_total Immutable writes blocked by raw PII guard.",
    "# TYPE x402_pii_blocks_total counter",
    line("x402_pii_blocks_total", countImmutablePiiBlocks(auditLog)),
    "# HELP x402_webhook_deliveries_total Webhook delivery attempts.",
    "# TYPE x402_webhook_deliveries_total counter",
    line("x402_webhook_deliveries_total", summary.webhooksSent + summary.webhooksFailed),
    "# HELP x402_webhook_replays_rejected_total Webhook replays rejected by receiver or persistence layer.",
    "# TYPE x402_webhook_replays_rejected_total counter",
    line("x402_webhook_replays_rejected_total", countAudit(auditLog, "WEBHOOK_REPLAY_REJECTED")),
    "# HELP x402_emergency_pause_active Whether any emergency pause switch is active.",
    "# TYPE x402_emergency_pause_active gauge",
    line("x402_emergency_pause_active", anyEmergencyPause),
    "# HELP x402_admin_actions_total Admin and governance actions.",
    "# TYPE x402_admin_actions_total counter",
    line("x402_admin_actions_total", countAudit(auditLog, "ADMIN_ACTION") + countAudit(auditLog, "GOVERNANCE_ACTION")),
    "# HELP x402_appeals_open_total Open policy appeals.",
    "# TYPE x402_appeals_open_total gauge",
    line("x402_appeals_open_total", appealsOpen),
    "# HELP x402_denylist_active_total Active denylist entries.",
    "# TYPE x402_denylist_active_total gauge",
    line("x402_denylist_active_total", governanceEntries.filter((entry) => entry.status === "ACTIVE").length),
    "# HELP x402_tax_profiles_missing_total Sellers missing tax profile status in this process.",
    "# TYPE x402_tax_profiles_missing_total gauge",
    line("x402_tax_profiles_missing_total", 0),
    "# HELP x402_db_errors_total Database errors observed by this process.",
    "# TYPE x402_db_errors_total counter",
    line("x402_db_errors_total", 0),
    "# HELP x402_verifier_errors_total Verifier rejections/errors observed by audit log.",
    "# TYPE x402_verifier_errors_total counter",
    line("x402_verifier_errors_total", summary.paymentsRejected),
    "# HELP x402_settlement_unavailable_total Settlement outage events observed by this process.",
    "# TYPE x402_settlement_unavailable_total counter",
    line("x402_settlement_unavailable_total", 0),
    "# HELP x402_mayhem_failures_total Server mayhem failures observed by this process.",
    "# TYPE x402_mayhem_failures_total counter",
    line("x402_mayhem_failures_total", 0),
  ];

  return `${rows.join("\n")}\n`;
}
