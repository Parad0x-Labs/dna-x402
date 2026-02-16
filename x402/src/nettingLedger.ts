import { parseAtomic, toAtomicString } from "./feePolicy.js";

export interface NettingCharge {
  payerCommitment32B: string;
  providerId: string;
  amountAtomic: string;
  feeAtomic?: string;
  quoteId: string;
  commitId: string;
  createdAtMs: number;
}

export interface NettingEntry {
  key: string;
  payerCommitment32B: string;
  providerId: string;
  balanceDeltaAtomic: string;
  providerDueAtomic: string;
  platformFeeAtomic: string;
  charges: number;
  lastUpdatedMs: number;
  quoteIds: string[];
  commitIds: string[];
}

export interface NettingBatch {
  key: string;
  payerCommitment32B: string;
  providerId: string;
  settleAmountAtomic: string;
  providerAmountAtomic: string;
  platformFeeAtomic: string;
  quoteIds: string[];
  commitIds: string[];
}

interface InternalEntry {
  payerCommitment32B: string;
  providerId: string;
  grossDelta: bigint;
  providerDue: bigint;
  platformFeeDue: bigint;
  charges: number;
  firstSeenMs: number;
  lastUpdatedMs: number;
  quoteIds: string[];
  commitIds: string[];
}

export interface NettingLedgerOptions {
  settleThresholdAtomic: bigint;
  settleIntervalMs: number;
  feeAccrualThresholdAtomic?: bigint;
}

export class NettingLedger {
  private readonly entries = new Map<string, InternalEntry>();

  constructor(private readonly options: NettingLedgerOptions) {}

  static keyOf(payerCommitment32B: string, providerId: string): string {
    return `${payerCommitment32B.toLowerCase()}::${providerId}`;
  }

  add(charge: NettingCharge): NettingEntry {
    const key = NettingLedger.keyOf(charge.payerCommitment32B, charge.providerId);
    const existing = this.entries.get(key);
    const amount = parseAtomic(charge.amountAtomic);
    const fee = parseAtomic(charge.feeAtomic ?? "0");
    const gross = amount + fee;
    const nowMs = charge.createdAtMs;

    if (!existing) {
      this.entries.set(key, {
        payerCommitment32B: charge.payerCommitment32B.toLowerCase(),
        providerId: charge.providerId,
        grossDelta: gross,
        providerDue: amount,
        platformFeeDue: fee,
        charges: 1,
        firstSeenMs: nowMs,
        lastUpdatedMs: nowMs,
        quoteIds: [charge.quoteId],
        commitIds: [charge.commitId],
      });
    } else {
      existing.grossDelta += gross;
      existing.providerDue += amount;
      existing.platformFeeDue += fee;
      existing.charges += 1;
      existing.lastUpdatedMs = nowMs;
      existing.quoteIds.push(charge.quoteId);
      existing.commitIds.push(charge.commitId);
    }

    return this.snapshotEntry(key)!;
  }

  snapshot(): NettingEntry[] {
    return Array.from(this.entries.keys())
      .sort()
      .map((key) => this.snapshotEntry(key))
      .filter((x): x is NettingEntry => Boolean(x));
  }

  flushReady(nowMs: number): NettingBatch[] {
    const ready: NettingBatch[] = [];
    const feeThreshold = this.options.feeAccrualThresholdAtomic ?? 0n;

    for (const [key, entry] of this.entries.entries()) {
      const thresholdHit = entry.grossDelta >= this.options.settleThresholdAtomic;
      const feeThresholdHit = feeThreshold > 0n && entry.platformFeeDue >= feeThreshold;
      const intervalHit = nowMs - entry.firstSeenMs >= this.options.settleIntervalMs;
      if (!thresholdHit && !feeThresholdHit && !intervalHit) {
        continue;
      }

      ready.push({
        key,
        payerCommitment32B: entry.payerCommitment32B,
        providerId: entry.providerId,
        settleAmountAtomic: toAtomicString(entry.grossDelta),
        providerAmountAtomic: toAtomicString(entry.providerDue),
        platformFeeAtomic: toAtomicString(entry.platformFeeDue),
        quoteIds: [...entry.quoteIds],
        commitIds: [...entry.commitIds],
      });

      this.entries.delete(key);
    }

    return ready;
  }

  private snapshotEntry(key: string): NettingEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    return {
      key,
      payerCommitment32B: entry.payerCommitment32B,
      providerId: entry.providerId,
      balanceDeltaAtomic: toAtomicString(entry.grossDelta),
      providerDueAtomic: toAtomicString(entry.providerDue),
      platformFeeAtomic: toAtomicString(entry.platformFeeDue),
      charges: entry.charges,
      lastUpdatedMs: entry.lastUpdatedMs,
      quoteIds: [...entry.quoteIds],
      commitIds: [...entry.commitIds],
    };
  }
}
