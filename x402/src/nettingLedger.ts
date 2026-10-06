import { parseAtomic, toAtomicString } from "./feePolicy.js";

/**
 * Payer-signed cumulative voucher for lane B2 of the x402_settle program
 * (`packages/x402-settle`). `cumulativeAtomic` is the payer's running total
 * to this payee in the escrow scope, so only the latest voucher of a pair is
 * settled on chain.
 */
export interface NettingSettleVoucher {
  payer: string;
  payee: string;
  scope: string;
  cumulativeAtomic: string;
  expirySlot: string;
  quoteHash: string;
  signature: string;
}

/** Settles vouchers on chain, for example `createB2FlushSink` from `packages/x402-settle`. */
export interface NettingSettlementSink {
  submit(vouchers: NettingSettleVoucher[]): Promise<{ signatures: string[] }>;
}

export interface NettingCharge {
  payerCommitment32B: string;
  providerId: string;
  amountAtomic: string;
  feeAtomic?: string;
  quoteId: string;
  commitId: string;
  createdAtMs: number;
  /** Optional lane B2 voucher; without it the entry flushes only through `flushReady`. */
  settleVoucher?: NettingSettleVoucher;
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
  settleVoucher?: NettingSettleVoucher;
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
  settleVoucher?: NettingSettleVoucher;
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
  settleVoucher?: NettingSettleVoucher;
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
        ...(charge.settleVoucher ? { settleVoucher: charge.settleVoucher } : {}),
      });
    } else {
      existing.grossDelta += gross;
      existing.providerDue += amount;
      existing.platformFeeDue += fee;
      existing.charges += 1;
      existing.lastUpdatedMs = nowMs;
      existing.quoteIds.push(charge.quoteId);
      existing.commitIds.push(charge.commitId);
      if (
        charge.settleVoucher &&
        (!existing.settleVoucher ||
          BigInt(charge.settleVoucher.cumulativeAtomic) > BigInt(existing.settleVoucher.cumulativeAtomic))
      ) {
        existing.settleVoucher = charge.settleVoucher;
      }
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

    for (const [key, entry] of this.entries.entries()) {
      if (!this.isReady(entry, nowMs)) {
        continue;
      }
      ready.push(this.toBatch(key, entry));
      this.entries.delete(key);
    }

    return ready;
  }

  /**
   * Flushes ready entries that carry a payer-signed voucher through `sink`
   * (lane B2 of x402_settle: one V1 transaction per ~25 pairs). Entries are
   * removed only after the sink succeeds; on error they stay for a retry.
   * Entries without a voucher are left for `flushReady`.
   */
  async flushToSettlement(
    nowMs: number,
    sink: NettingSettlementSink,
  ): Promise<{ settled: NettingBatch[]; signatures: string[] }> {
    const keys: string[] = [];
    const settled: NettingBatch[] = [];
    for (const [key, entry] of this.entries.entries()) {
      if (entry.settleVoucher && this.isReady(entry, nowMs)) {
        keys.push(key);
        settled.push(this.toBatch(key, entry));
      }
    }
    if (settled.length === 0) {
      return { settled, signatures: [] };
    }
    const { signatures } = await sink.submit(settled.map((b) => b.settleVoucher!));
    for (const key of keys) {
      this.entries.delete(key);
    }
    return { settled, signatures };
  }

  private isReady(entry: InternalEntry, nowMs: number): boolean {
    const feeThreshold = this.options.feeAccrualThresholdAtomic ?? 0n;
    const thresholdHit = entry.grossDelta >= this.options.settleThresholdAtomic;
    const feeThresholdHit = feeThreshold > 0n && entry.platformFeeDue >= feeThreshold;
    const intervalHit = nowMs - entry.firstSeenMs >= this.options.settleIntervalMs;
    return thresholdHit || feeThresholdHit || intervalHit;
  }

  private toBatch(key: string, entry: InternalEntry): NettingBatch {
    return {
      key,
      payerCommitment32B: entry.payerCommitment32B,
      providerId: entry.providerId,
      settleAmountAtomic: toAtomicString(entry.grossDelta),
      providerAmountAtomic: toAtomicString(entry.providerDue),
      platformFeeAtomic: toAtomicString(entry.platformFeeDue),
      quoteIds: [...entry.quoteIds],
      commitIds: [...entry.commitIds],
      ...(entry.settleVoucher ? { settleVoucher: entry.settleVoucher } : {}),
    };
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
      ...(entry.settleVoucher ? { settleVoucher: entry.settleVoucher } : {}),
    };
  }
}
