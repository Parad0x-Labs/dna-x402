import { describe, expect, it } from "vitest";
import { NettingLedger } from "../src/nettingLedger.js";

describe("netting ledger", () => {
  it("aggregates many tiny charges into a single settlement batch", () => {
    const ledger = new NettingLedger({
      settleThresholdAtomic: 10_000n,
      settleIntervalMs: 60_000,
    });

    const now = Date.now();
    for (let i = 0; i < 100; i += 1) {
      ledger.add({
        payerCommitment32B: "aa".repeat(32),
        providerId: "provider-1",
        amountAtomic: "100",
        feeAtomic: "1",
        quoteId: `q-${i}`,
        commitId: `c-${i}`,
        createdAtMs: now,
      });
    }

    const batches = ledger.flushReady(now + 1_000);
    expect(batches).toHaveLength(1);
    expect(batches[0].settleAmountAtomic).toBe("10100");
    expect(batches[0].providerAmountAtomic).toBe("10000");
    expect(batches[0].platformFeeAtomic).toBe("100");
    expect(batches[0].quoteIds).toHaveLength(100);
  });

  it("flushes when accrued platform fee reaches threshold", () => {
    const ledger = new NettingLedger({
      settleThresholdAtomic: 1_000_000n,
      settleIntervalMs: 60_000,
      feeAccrualThresholdAtomic: 50n,
    });

    const now = Date.now();
    for (let i = 0; i < 10; i += 1) {
      ledger.add({
        payerCommitment32B: "bb".repeat(32),
        providerId: "provider-2",
        amountAtomic: "10",
        feeAtomic: "5",
        quoteId: `fq-${i}`,
        commitId: `fc-${i}`,
        createdAtMs: now,
      });
    }

    const batches = ledger.flushReady(now + 1_000);
    expect(batches).toHaveLength(1);
    expect(batches[0].platformFeeAtomic).toBe("50");
    expect(batches[0].providerAmountAtomic).toBe("100");
  });
});
