import { InMemoryRepository, nowIso, stableHash } from "../common/stable.js";
import { assertImmutableRecordSafe } from "../privacy/immutableGuard.js";
import { DenylistEntry, GovernanceAdminRole, PolicyAppeal, PolicyRuleChange } from "./types.js";

export interface GovernanceAuditEvent {
  eventId: string;
  actor: string;
  action: string;
  targetId: string;
  createdAt: string;
}

export class GovernanceService {
  private readonly rules = new InMemoryRepository<PolicyRuleChange>();
  private readonly denylist = new InMemoryRepository<DenylistEntry>();
  private readonly appeals = new InMemoryRepository<PolicyAppeal>();
  private readonly auditEvents: GovernanceAuditEvent[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  addDenylistEntry(entry: Omit<DenylistEntry, "entryId" | "status">): DenylistEntry {
    if (entry.reasonCode.trim().length === 0 || entry.evidenceRefs.length === 0) {
      throw new Error("denylist entry requires reason code and evidence refs");
    }
    const created: DenylistEntry = {
      ...entry,
      entryId: stableHash({ entry, createdAt: nowIso(this.now) }),
      status: "ACTIVE",
    };
    this.audit(entry.createdBy, "denylist.create", created.entryId);
    this.denylist.put(created.entryId, created);
    return created;
  }

  listDenylistEntries(): DenylistEntry[] {
    return this.denylist.list();
  }

  updateDenylistStatus(entryId: string, status: "EXPIRED" | "REVOKED", actor: string): DenylistEntry {
    const entry = this.denylist.get(entryId);
    if (!entry) {
      throw new Error("denylist entry not found");
    }
    const updated: DenylistEntry = { ...entry, status };
    this.audit(actor, `denylist.${status.toLowerCase()}`, entryId);
    this.denylist.put(entryId, updated);
    return updated;
  }

  proposeRuleChange(input: Omit<PolicyRuleChange, "changeId" | "status" | "createdAt">, roles: GovernanceAdminRole[]): PolicyRuleChange {
    if (!roles.includes("policy_proposer")) {
      throw new Error("policy proposer role required");
    }
    const createdAt = nowIso(this.now);
    const change: PolicyRuleChange = {
      ...input,
      changeId: stableHash({ ruleId: input.ruleId, action: input.action, proposedBy: input.proposedBy, createdAt }),
      status: "PROPOSED",
      createdAt,
    };
    this.audit(input.proposedBy, "policy.rule.propose", change.changeId);
    this.rules.put(change.changeId, change);
    return change;
  }

  approveRuleChange(changeId: string, actor: string, roles: GovernanceAdminRole[]): PolicyRuleChange {
    if (!roles.includes("policy_approver")) {
      throw new Error("policy approver role required");
    }
    const change = this.rules.get(changeId);
    if (!change) {
      throw new Error("policy rule change not found");
    }
    const approved: PolicyRuleChange = {
      ...change,
      approvedBy: actor,
      status: "APPROVED",
      effectiveAt: nowIso(this.now),
    };
    this.audit(actor, "policy.rule.approve", changeId);
    this.rules.put(changeId, approved);
    return approved;
  }

  openAppeal(input: Omit<PolicyAppeal, "appealId" | "status">): PolicyAppeal {
    const appeal: PolicyAppeal = {
      ...input,
      appealId: stableHash(input),
      status: "OPEN",
    };
    this.audit(input.subjectId, "policy.appeal.open", appeal.appealId);
    this.appeals.put(appeal.appealId, appeal);
    return appeal;
  }

  listAppeals(): PolicyAppeal[] {
    return this.appeals.list();
  }

  listRuleChanges(): PolicyRuleChange[] {
    return this.rules.list();
  }

  resolveAppeal(appealId: string, reviewer: string, approved: boolean, resolutionReason: string, roles: GovernanceAdminRole[]): PolicyAppeal {
    if (!roles.includes("appeal_reviewer")) {
      throw new Error("appeal reviewer role required");
    }
    const appeal = this.appeals.get(appealId);
    if (!appeal) {
      throw new Error("policy appeal not found");
    }
    const resolved: PolicyAppeal = {
      ...appeal,
      status: approved ? "APPROVED" : "REJECTED",
      reviewer,
      resolutionReason,
    };
    this.audit(reviewer, approved ? "policy.appeal.approve" : "policy.appeal.reject", appealId);
    this.appeals.put(appealId, resolved);
    return resolved;
  }

  history(): GovernanceAuditEvent[] {
    return [...this.auditEvents];
  }

  private audit(actor: string, action: string, targetId: string): void {
    const createdAt = nowIso(this.now);
    const event = {
      eventId: stableHash({ actor, action, targetId, createdAt }),
      actor,
      action,
      targetId,
      createdAt,
    };
    assertImmutableRecordSafe("GOVERNANCE_AUDIT_EVENT", event);
    this.auditEvents.push(event);
  }
}
