import { parseAtomic } from "../../src/feePolicy.js";
import { SignedReceipt } from "../../src/types.js";

export interface FeeReconcileInput {
  receipts: SignedReceipt[];
  nettingBatches: Array<{
    settleAmountAtomic: string;
    providerAmountAtomic: string;
    platformFeeAtomic: string;
  }>;
  toleranceAtomicPerTx?: bigint;
  tolerancePercent?: number;
}

export interface FeeReconcileResult {
  expectedPlatformFeeAtomic: string;
  observedPlatformFeeAtomic: string;
  deltaAtomic: string;
  deltaPercent: number;
  toleranceAtomic: string;
  withinTolerance: boolean;
  providerPlusFeeEqualsTotal: boolean;
}

export function reconcileFees(input: FeeReconcileInput): FeeReconcileResult {
  const toleranceAtomicPerTx = input.toleranceAtomicPerTx ?? 2n;
  const tolerancePercent = input.tolerancePercent ?? 0.5;
  const nettingReceipts = input.receipts.filter((receipt) => receipt.payload.settlement === "netting");
  const expected = nettingReceipts.reduce((sum, receipt) => sum + parseAtomic(receipt.payload.feeAtomic), 0n);
  const observed = input.nettingBatches.reduce((sum, batch) => sum + parseAtomic(batch.platformFeeAtomic), 0n);
  const delta = observed - expected;
  const absDelta = delta < 0n ? -delta : delta;
  const txTolerance = toleranceAtomicPerTx * BigInt(Math.max(1, nettingReceipts.length));
  const pctTolerance = BigInt(Math.ceil(Number(expected) * (tolerancePercent / 100)));
  const tolerance = txTolerance > pctTolerance ? txTolerance : pctTolerance;
  const deltaPercent = expected === 0n
    ? 0
    : Number(((Number(absDelta) / Number(expected)) * 100).toFixed(6));

  const providerPlusFeeEqualsTotal = input.nettingBatches.every((batch) => {
    const settle = parseAtomic(batch.settleAmountAtomic);
    const provider = parseAtomic(batch.providerAmountAtomic);
    const fee = parseAtomic(batch.platformFeeAtomic);
    return settle === provider + fee;
  });

  return {
    expectedPlatformFeeAtomic: expected.toString(10),
    observedPlatformFeeAtomic: observed.toString(10),
    deltaAtomic: delta.toString(10),
    deltaPercent,
    toleranceAtomic: tolerance.toString(10),
    withinTolerance: absDelta <= tolerance && observed >= 0n,
    providerPlusFeeEqualsTotal,
  };
}

