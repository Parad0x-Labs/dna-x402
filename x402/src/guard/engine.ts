import { parseAtomic, toAtomicString } from "../feePolicy.js";

export type DnaGuardSpendScope = "buyer" | "wallet" | "agent" | "apiKey";

export interface DnaGuardActor {
  buyerId?: string;
  walletAddress?: string;
  agentId?: string;
  apiKeyId?: string;
}

export interface DnaGuardSpendCeilings {
  buyerAtomic?: string;
  walletAtomic?: string;
  agentAtomic?: string;
  apiKeyAtomic?: string;
}

export interface DnaGuardSpendBlock {
  scope: DnaGuardSpendScope;
  actorId: string;
  attemptedAtomic: string;
  currentAtomic: string;
  limitAtomic: string;
}

export interface DnaGuardSpendDecision {
  ok: boolean;
  blocked: DnaGuardSpendBlock[];
}

export interface DnaGuardDeliveryRecord {
  providerId: string;
  endpointId?: string;
  latencyMs?: number;
  statusCode?: number;
  receiptId?: string;
  qualityAccepted?: boolean;
}

export interface DnaGuardDisputeRecord {
  providerId: string;
  endpointId?: string;
  receiptId?: string;
  reason: string;
}

export interface DnaGuardReceiptVerificationRecord {
  providerId: string;
  endpointId?: string;
  receiptId: string;
  valid: boolean;
  reason?: string;
}

export interface DnaGuardReplayAlertRecord {
  providerId: string;
  endpointId?: string;
  reason?: string;
}

export interface DnaGuardProviderSnapshot {
  providerId: string;
  endpointId?: string;
  totals: {
    requests: number;
    fulfilled: number;
    failed: number;
    qualityRejected: number;
    disputes: number;
    replayAlerts: number;
    receiptsVerified: number;
    receiptsInvalid: number;
    spendBlocked: number;
    avgLatencyMs: number;
    successRate: number;
    qualityPassRate: number;
    disputeRate: number;
    receiptVerificationRate: number;
  };
  score: number;
  riskLevel: "low" | "medium" | "high";
}

export interface DnaGuardReceiptStatus {
  receiptId: string;
  providerId: string;
  endpointId?: string;
  disputed: boolean;
  disputeReasons: string[];
  qualityRejected: boolean;
  verification?: {
    valid: boolean;
    reason?: string;
    ts: string;
  };
}

export interface DnaGuardSpendSampleSnapshot {
  scope: DnaGuardSpendScope;
  actorId: string;
  entries: Array<{
    tsMs: number;
    amountAtomic: string;
  }>;
}

export interface DnaGuardProviderStatsSnapshot {
  providerId: string;
  endpointId?: string;
  requests: number;
  fulfilled: number;
  failed: number;
  qualityRejected: number;
  disputes: number;
  replayAlerts: number;
  receiptsVerified: number;
  receiptsInvalid: number;
  spendBlocked: number;
  totalLatencyMs: number;
}

export interface DnaGuardLedgerSnapshot {
  version: 1;
  windowMs: number;
  spendByScope: DnaGuardSpendSampleSnapshot[];
  providerStats: DnaGuardProviderStatsSnapshot[];
  receiptStatuses: DnaGuardReceiptStatus[];
}

interface SpendSample {
  tsMs: number;
  amountAtomic: bigint;
}

interface MutableProviderStats {
  providerId: string;
  endpointId?: string;
  requests: number;
  fulfilled: number;
  failed: number;
  qualityRejected: number;
  disputes: number;
  replayAlerts: number;
  receiptsVerified: number;
  receiptsInvalid: number;
  spendBlocked: number;
  totalLatencyMs: number;
}

export interface DnaGuardLedgerOptions {
  windowMs?: number;
  onChange?: (snapshot: DnaGuardLedgerSnapshot) => void;
  now?: () => Date;
}

function actorIdForScope(actor: DnaGuardActor, scope: DnaGuardSpendScope): string | undefined {
  switch (scope) {
    case "buyer":
      return actor.buyerId;
    case "wallet":
      return actor.walletAddress;
    case "agent":
      return actor.agentId;
    case "apiKey":
      return actor.apiKeyId;
  }
}

function ceilingForScope(ceilings: DnaGuardSpendCeilings, scope: DnaGuardSpendScope): string | undefined {
  switch (scope) {
    case "buyer":
      return ceilings.buyerAtomic;
    case "wallet":
      return ceilings.walletAtomic;
    case "agent":
      return ceilings.agentAtomic;
    case "apiKey":
      return ceilings.apiKeyAtomic;
  }
}

function providerKey(providerId: string, endpointId?: string): string {
  return endpointId ? `${providerId}::${endpointId}` : providerId;
}

function toRiskLevel(score: number): "low" | "medium" | "high" {
  if (score >= 80) {
    return "low";
  }
  if (score >= 55) {
    return "medium";
  }
  return "high";
}

function computeScore(stats: MutableProviderStats): number {
  const requests = Math.max(0, stats.requests);
  const fulfilled = Math.max(0, stats.fulfilled);
  const failed = Math.max(0, stats.failed);
  const qualityRejected = Math.max(0, stats.qualityRejected);
  const disputes = Math.max(0, stats.disputes);
  const receiptsVerified = Math.max(0, stats.receiptsVerified);
  const receiptsInvalid = Math.max(0, stats.receiptsInvalid);
  const avgLatencyMs = fulfilled > 0 ? stats.totalLatencyMs / fulfilled : 0;

  const successRate = requests === 0 ? 1 : fulfilled / requests;
  const qualityPassRate = requests === 0 ? 1 : Math.max(0, (requests - qualityRejected) / requests);
  const disputeRate = fulfilled === 0 ? 0 : disputes / fulfilled;
  const receiptVerificationRate = (receiptsVerified + receiptsInvalid) === 0
    ? 1
    : receiptsVerified / (receiptsVerified + receiptsInvalid);

  const successPenalty = (1 - successRate) * 45;
  const qualityPenalty = (1 - qualityPassRate) * 20;
  const disputePenalty = Math.min(20, disputeRate * 50);
  const latencyPenalty = avgLatencyMs <= 750 ? 0 : Math.min(15, ((avgLatencyMs - 750) / 4_250) * 15);
  const replayPenalty = Math.min(10, stats.replayAlerts * 5);
  const receiptPenalty = Math.min(10, (1 - receiptVerificationRate) * 10);
  const blockedPenalty = Math.min(5, stats.spendBlocked);
  const score = 100 - successPenalty - qualityPenalty - disputePenalty - latencyPenalty - replayPenalty - receiptPenalty - blockedPenalty;
  return Math.max(0, Math.min(100, Math.round(score * 100) / 100));
}

export class DnaGuardLedger {
  private readonly windowMs: number;
  private readonly onChange?: (snapshot: DnaGuardLedgerSnapshot) => void;
  private readonly now: () => Date;
  private readonly spendByScope = new Map<string, SpendSample[]>();
  private readonly providerStats = new Map<string, MutableProviderStats>();
  private readonly receiptStatuses = new Map<string, DnaGuardReceiptStatus>();

  constructor(options: DnaGuardLedgerOptions = {}) {
    this.windowMs = options.windowMs ?? 86_400_000;
    this.onChange = options.onChange;
    this.now = options.now ?? (() => new Date());
  }

  private emitChange(now = this.now()): void {
    this.onChange?.(this.snapshot(now));
  }

  private pruneSpendWindow(records: SpendSample[], nowMs: number): SpendSample[] {
    return records.filter((record) => nowMs - record.tsMs <= this.windowMs);
  }

  private getSpendSamples(scope: DnaGuardSpendScope, actorId: string, nowMs: number): SpendSample[] {
    const key = `${scope}:${actorId}`;
    const current = this.pruneSpendWindow(this.spendByScope.get(key) ?? [], nowMs);
    this.spendByScope.set(key, current);
    return current;
  }

  private touchStats(providerId: string, endpointId?: string): MutableProviderStats {
    const key = providerKey(providerId, endpointId);
    const existing = this.providerStats.get(key);
    if (existing) {
      return existing;
    }
    const created: MutableProviderStats = {
      providerId,
      endpointId,
      requests: 0,
      fulfilled: 0,
      failed: 0,
      qualityRejected: 0,
      disputes: 0,
      replayAlerts: 0,
      receiptsVerified: 0,
      receiptsInvalid: 0,
      spendBlocked: 0,
      totalLatencyMs: 0,
    };
    this.providerStats.set(key, created);
    return created;
  }

  private applyToProvider(providerId: string, endpointId: string | undefined, fn: (stats: MutableProviderStats) => void): void {
    fn(this.touchStats(providerId));
    if (endpointId) {
      fn(this.touchStats(providerId, endpointId));
    }
  }

  private touchReceiptStatus(receiptId: string, providerId: string, endpointId?: string): DnaGuardReceiptStatus {
    const existing = this.receiptStatuses.get(receiptId);
    if (existing) {
      return existing;
    }
    const created: DnaGuardReceiptStatus = {
      receiptId,
      providerId,
      endpointId,
      disputed: false,
      disputeReasons: [],
      qualityRejected: false,
    };
    this.receiptStatuses.set(receiptId, created);
    return created;
  }

  checkSpend(actor: DnaGuardActor, attemptedAtomic: string, ceilings: DnaGuardSpendCeilings, now = this.now()): DnaGuardSpendDecision {
    const amountAtomic = parseAtomic(attemptedAtomic);
    const nowMs = now.getTime();
    const blocked: DnaGuardSpendBlock[] = [];

    for (const scope of ["buyer", "wallet", "agent", "apiKey"] as DnaGuardSpendScope[]) {
      const actorId = actorIdForScope(actor, scope);
      const limitAtomic = ceilingForScope(ceilings, scope);
      if (!actorId || !limitAtomic) {
        continue;
      }
      const limit = parseAtomic(limitAtomic);
      const current = this.getSpendSamples(scope, actorId, nowMs)
        .reduce((sum, sample) => sum + sample.amountAtomic, 0n);
      if (current + amountAtomic > limit) {
        blocked.push({
          scope,
          actorId,
          attemptedAtomic,
          currentAtomic: toAtomicString(current),
          limitAtomic,
        });
      }
    }

    return {
      ok: blocked.length === 0,
      blocked,
    };
  }

  commitSpend(actor: DnaGuardActor, amountAtomic: string, now = this.now()): void {
    const amount = parseAtomic(amountAtomic);
    const nowMs = now.getTime();
    for (const scope of ["buyer", "wallet", "agent", "apiKey"] as DnaGuardSpendScope[]) {
      const actorId = actorIdForScope(actor, scope);
      if (!actorId) {
        continue;
      }
      const key = `${scope}:${actorId}`;
      const current = this.getSpendSamples(scope, actorId, nowMs);
      current.push({ tsMs: nowMs, amountAtomic: amount });
      this.spendByScope.set(key, current);
    }
    this.emitChange(now);
  }

  spendSnapshot(actor: DnaGuardActor, now = this.now()): Partial<Record<DnaGuardSpendScope, string>> {
    const nowMs = now.getTime();
    const snapshot: Partial<Record<DnaGuardSpendScope, string>> = {};
    for (const scope of ["buyer", "wallet", "agent", "apiKey"] as DnaGuardSpendScope[]) {
      const actorId = actorIdForScope(actor, scope);
      if (!actorId) {
        continue;
      }
      const total = this.getSpendSamples(scope, actorId, nowMs)
        .reduce((sum, sample) => sum + sample.amountAtomic, 0n);
      snapshot[scope] = toAtomicString(total);
    }
    return snapshot;
  }

  recordDelivery(record: DnaGuardDeliveryRecord): void {
    this.applyToProvider(record.providerId, record.endpointId, (stats) => {
      stats.requests += 1;
      const ok = (record.statusCode ?? 200) < 400 && record.qualityAccepted !== false;
      if (ok) {
        stats.fulfilled += 1;
      } else {
        stats.failed += 1;
      }
      if (record.qualityAccepted === false) {
        stats.qualityRejected += 1;
      }
      if (typeof record.latencyMs === "number" && record.latencyMs >= 0) {
        stats.totalLatencyMs += record.latencyMs;
      }
    });
    if (record.receiptId && record.qualityAccepted === false) {
      const receipt = this.touchReceiptStatus(record.receiptId, record.providerId, record.endpointId);
      receipt.qualityRejected = true;
    }
    this.emitChange();
  }

  recordDispute(record: DnaGuardDisputeRecord): void {
    this.applyToProvider(record.providerId, record.endpointId, (stats) => {
      stats.disputes += 1;
    });
    if (record.receiptId) {
      const receipt = this.touchReceiptStatus(record.receiptId, record.providerId, record.endpointId);
      receipt.disputed = true;
      receipt.disputeReasons = Array.from(new Set([...receipt.disputeReasons, record.reason]));
    }
    this.emitChange();
  }

  recordReceiptVerification(record: DnaGuardReceiptVerificationRecord, now = this.now()): void {
    this.applyToProvider(record.providerId, record.endpointId, (stats) => {
      if (record.valid) {
        stats.receiptsVerified += 1;
      } else {
        stats.receiptsInvalid += 1;
      }
    });
    const receipt = this.touchReceiptStatus(record.receiptId, record.providerId, record.endpointId);
    receipt.verification = {
      valid: record.valid,
      reason: record.reason,
      ts: now.toISOString(),
    };
    this.emitChange(now);
  }

  recordReplayAlert(record: DnaGuardReplayAlertRecord): void {
    this.applyToProvider(record.providerId, record.endpointId, (stats) => {
      stats.replayAlerts += 1;
    });
    this.emitChange();
  }

  recordSpendBlocked(providerId: string, endpointId?: string): void {
    this.applyToProvider(providerId, endpointId, (stats) => {
      stats.spendBlocked += 1;
    });
    this.emitChange();
  }

  snapshot(now = this.now()): DnaGuardLedgerSnapshot {
    const nowMs = now.getTime();
    const spendByScope = Array.from(this.spendByScope.entries()).map(([key, records]) => {
      const [scope, ...actorParts] = key.split(":");
      const actorId = actorParts.join(":");
      const pruned = this.pruneSpendWindow(records, nowMs);
      return {
        scope: scope as DnaGuardSpendScope,
        actorId,
        entries: pruned.map((record) => ({
          tsMs: record.tsMs,
          amountAtomic: toAtomicString(record.amountAtomic),
        })),
      };
    }).filter((entry) => entry.entries.length > 0);

    const providerStats = Array.from(this.providerStats.values()).map((stats) => ({
      providerId: stats.providerId,
      endpointId: stats.endpointId,
      requests: stats.requests,
      fulfilled: stats.fulfilled,
      failed: stats.failed,
      qualityRejected: stats.qualityRejected,
      disputes: stats.disputes,
      replayAlerts: stats.replayAlerts,
      receiptsVerified: stats.receiptsVerified,
      receiptsInvalid: stats.receiptsInvalid,
      spendBlocked: stats.spendBlocked,
      totalLatencyMs: stats.totalLatencyMs,
    }));

    const receiptStatuses = Array.from(this.receiptStatuses.values()).map((status) => ({
      receiptId: status.receiptId,
      providerId: status.providerId,
      endpointId: status.endpointId,
      disputed: status.disputed,
      disputeReasons: [...status.disputeReasons],
      qualityRejected: status.qualityRejected,
      verification: status.verification ? { ...status.verification } : undefined,
    }));

    return {
      version: 1,
      windowMs: this.windowMs,
      spendByScope,
      providerStats,
      receiptStatuses,
    };
  }

  restore(snapshot: DnaGuardLedgerSnapshot, now = this.now()): void {
    this.spendByScope.clear();
    this.providerStats.clear();
    this.receiptStatuses.clear();

    const nowMs = now.getTime();
    for (const bucket of snapshot.spendByScope ?? []) {
      const key = `${bucket.scope}:${bucket.actorId}`;
      const entries = bucket.entries
        .map((entry) => ({
          tsMs: entry.tsMs,
          amountAtomic: parseAtomic(entry.amountAtomic),
        }))
        .filter((entry) => nowMs - entry.tsMs <= this.windowMs);
      if (entries.length > 0) {
        this.spendByScope.set(key, entries);
      }
    }

    for (const stats of snapshot.providerStats ?? []) {
      this.providerStats.set(providerKey(stats.providerId, stats.endpointId), {
        providerId: stats.providerId,
        endpointId: stats.endpointId,
        requests: stats.requests,
        fulfilled: stats.fulfilled,
        failed: stats.failed,
        qualityRejected: stats.qualityRejected,
        disputes: stats.disputes,
        replayAlerts: stats.replayAlerts,
        receiptsVerified: stats.receiptsVerified,
        receiptsInvalid: stats.receiptsInvalid,
        spendBlocked: stats.spendBlocked,
        totalLatencyMs: stats.totalLatencyMs,
      });
    }

    for (const status of snapshot.receiptStatuses ?? []) {
      this.receiptStatuses.set(status.receiptId, {
        receiptId: status.receiptId,
        providerId: status.providerId,
        endpointId: status.endpointId,
        disputed: status.disputed,
        disputeReasons: [...status.disputeReasons],
        qualityRejected: status.qualityRejected,
        verification: status.verification ? { ...status.verification } : undefined,
      });
    }
  }

  providerSnapshot(providerId: string, endpointId?: string): DnaGuardProviderSnapshot {
    const stats = this.touchStats(providerId, endpointId);
    const score = computeScore(stats);
    const requests = Math.max(0, stats.requests);
    const fulfilled = Math.max(0, stats.fulfilled);
    const avgLatencyMs = fulfilled > 0 ? Math.round((stats.totalLatencyMs / fulfilled) * 100) / 100 : 0;
    const successRate = requests === 0 ? 1 : fulfilled / requests;
    const qualityPassRate = requests === 0 ? 1 : Math.max(0, (requests - stats.qualityRejected) / requests);
    const disputeRate = fulfilled === 0 ? 0 : stats.disputes / fulfilled;
    const verificationTotal = stats.receiptsVerified + stats.receiptsInvalid;
    const receiptVerificationRate = verificationTotal === 0 ? 1 : stats.receiptsVerified / verificationTotal;
    return {
      providerId,
      endpointId,
      totals: {
        requests,
        fulfilled,
        failed: stats.failed,
        qualityRejected: stats.qualityRejected,
        disputes: stats.disputes,
        replayAlerts: stats.replayAlerts,
        receiptsVerified: stats.receiptsVerified,
        receiptsInvalid: stats.receiptsInvalid,
        spendBlocked: stats.spendBlocked,
        avgLatencyMs,
        successRate: Math.round(successRate * 10_000) / 10_000,
        qualityPassRate: Math.round(qualityPassRate * 10_000) / 10_000,
        disputeRate: Math.round(disputeRate * 10_000) / 10_000,
        receiptVerificationRate: Math.round(receiptVerificationRate * 10_000) / 10_000,
      },
      score,
      riskLevel: toRiskLevel(score),
    };
  }

  leaderboard(limit = 20): DnaGuardProviderSnapshot[] {
    return Array.from(this.providerStats.values())
      .filter((stats) => !stats.endpointId)
      .map((stats) => this.providerSnapshot(stats.providerId))
      .sort((a, b) => b.score - a.score || b.totals.fulfilled - a.totals.fulfilled || a.providerId.localeCompare(b.providerId))
      .slice(0, Math.max(1, limit));
  }

  receiptStatus(receiptId: string): DnaGuardReceiptStatus | undefined {
    return this.receiptStatuses.get(receiptId);
  }

  summary(): {
    providers: number;
    receiptsTracked: number;
    disputes: number;
    replayAlerts: number;
    spendBlocked: number;
  } {
    const providers = Array.from(this.providerStats.values()).filter((stats) => !stats.endpointId).length;
    const disputes = Array.from(this.providerStats.values())
      .filter((stats) => !stats.endpointId)
      .reduce((sum, stats) => sum + stats.disputes, 0);
    const replayAlerts = Array.from(this.providerStats.values())
      .filter((stats) => !stats.endpointId)
      .reduce((sum, stats) => sum + stats.replayAlerts, 0);
    const spendBlocked = Array.from(this.providerStats.values())
      .filter((stats) => !stats.endpointId)
      .reduce((sum, stats) => sum + stats.spendBlocked, 0);
    return {
      providers,
      receiptsTracked: this.receiptStatuses.size,
      disputes,
      replayAlerts,
      spendBlocked,
    };
  }
}
