import { describe, expect, it } from "vitest";
import { calculateFeeAtomic, calculateTotalAtomic, shouldUseNetting } from "../src/feePolicy.js";

describe("fee policy", () => {
  it("computes base + bps fee", () => {
    const policy = {
      baseFeeAtomic: 10n,
      feeBps: 50,
      minFeeAtomic: 0n,
      accrueThresholdAtomic: 100n,
      minSettleAtomic: 0n,
    };

    const fee = calculateFeeAtomic(policy, 10_000n);
    expect(fee).toBe(60n); // 10 + 0.5% of 10_000

    const total = calculateTotalAtomic(policy, 10_000n);
    expect(total).toBe(10_060n);
  });

  it("applies min fee floor for nano payments", () => {
    const policy = {
      baseFeeAtomic: 0n,
      feeBps: 1,
      minFeeAtomic: 50n,
      accrueThresholdAtomic: 100n,
      minSettleAtomic: 0n,
    };

    expect(calculateFeeAtomic(policy, 100n)).toBe(50n);
  });

  it("does not force hard min reject; only signals netting", () => {
    const policy = {
      baseFeeAtomic: 0n,
      feeBps: 0,
      minFeeAtomic: 0n,
      accrueThresholdAtomic: 100n,
      minSettleAtomic: 1_000n,
    };

    expect(shouldUseNetting(policy, 999n)).toBe(true);
    expect(shouldUseNetting(policy, 1_000n)).toBe(false);
  });
});
