export interface FeePolicy {
  baseFeeAtomic: bigint;
  feeBps: number;
  minFeeAtomic: bigint;
  accrueThresholdAtomic: bigint;
  minSettleAtomic: bigint;
}

export function parseAtomic(value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid atomic amount: ${value}`);
  }
  return BigInt(value);
}

export function toAtomicString(value: bigint): string {
  if (value < 0n) {
    throw new Error("Atomic amount cannot be negative");
  }
  return value.toString(10);
}

export function calculateFeeAtomic(policy: FeePolicy, amountAtomic: bigint): bigint {
  if (amountAtomic < 0n) {
    throw new Error("Amount cannot be negative");
  }
  const bpsFee = (amountAtomic * BigInt(policy.feeBps)) / 10_000n;
  const computed = policy.baseFeeAtomic + bpsFee;
  return computed >= policy.minFeeAtomic ? computed : policy.minFeeAtomic;
}

export function calculateTotalAtomic(policy: FeePolicy, amountAtomic: bigint): bigint {
  return amountAtomic + calculateFeeAtomic(policy, amountAtomic);
}

export function shouldUseNetting(policy: FeePolicy, amountAtomic: bigint): boolean {
  return policy.minSettleAtomic > 0n && amountAtomic < policy.minSettleAtomic;
}
