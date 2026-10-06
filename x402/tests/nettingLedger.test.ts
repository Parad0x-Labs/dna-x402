import { describe, expect, it } from "vitest";
import { NettingLedger, type NettingSettleVoucher } from "../src/nettingLedger.js";

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

  it("flushes voucher-carrying entries to the lane B2 sink, latest voucher per pair", async () => {
    const ledger = new NettingLedger({ settleThresholdAtomic: 1_000n, settleIntervalMs: 60_000 });
    const now = Date.now();
    const v = (cum: number): NettingSettleVoucher => ({
      payer: "Payer111111111111111111111111111111111111111",
      payee: "Payee111111111111111111111111111111111111111",
      scope: "3",
      cumulativeAtomic: String(cum),
      expirySlot: "999",
      quoteHash: "ab".repeat(32),
      signature: "cd".repeat(64),
    });
    for (let i = 1; i <= 12; i += 1) {
      ledger.add({
        payerCommitment32B: "cc".repeat(32),
        providerId: "provider-b2",
        amountAtomic: "100",
        quoteId: `bq-${i}`,
        commitId: `bc-${i}`,
        createdAtMs: now,
        settleVoucher: v(i * 100),
      });
    }
    ledger.add({
      payerCommitment32B: "dd".repeat(32),
      providerId: "provider-plain",
      amountAtomic: "5000",
      quoteId: "pq",
      commitId: "pc",
      createdAtMs: now,
    });

    const failing = { submit: async () => Promise.reject(new Error("rpc down")) };
    await expect(ledger.flushToSettlement(now + 1, failing)).rejects.toThrow("rpc down");
    expect(ledger.snapshot()).toHaveLength(2);

    const seen: NettingSettleVoucher[][] = [];
    const sink = {
      submit: async (vs: NettingSettleVoucher[]) => {
        seen.push(vs);
        return { signatures: ["sig-1"] };
      },
    };
    const out = await ledger.flushToSettlement(now + 1, sink);
    expect(out.signatures).toEqual(["sig-1"]);
    expect(out.settled).toHaveLength(1);
    expect(seen[0]).toHaveLength(1);
    expect(seen[0][0].cumulativeAtomic).toBe("1200");
    expect(out.settled[0].settleAmountAtomic).toBe("1200");
    // The entry without a voucher stays for flushReady.
    const rest = ledger.flushReady(now + 1);
    expect(rest).toHaveLength(1);
    expect(rest[0].providerId).toBe("provider-plain");
    expect(rest[0]).not.toHaveProperty("settleVoucher");
  });
});
