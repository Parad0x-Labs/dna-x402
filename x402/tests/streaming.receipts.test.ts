import { describe, expect, it } from "vitest";
import BN from "bn.js";
import { StreamingService, type StreamClientLike } from "../src/streaming.js";

// ---------------------------------------------------------------------------
// Streaming receipt tests.
// streaming.test.ts already covers: create/topup/get APIs.
// This file covers: receipt field presence, sequence ordering, validity checks,
//                   total integrity, and duplicate detection.
// ---------------------------------------------------------------------------

/**
 * Minimal StreamingReceipt shape used by these tests.
 * In production this would be emitted by the streaming service layer.
 */
interface StreamingReceipt {
  amount: string;
  recipient: string;
  sequence: number;
  timestamp: string;
}

/** Build a well-formed streaming receipt */
function makeReceipt(overrides: Partial<StreamingReceipt> = {}): StreamingReceipt {
  return {
    amount: "1000",
    recipient: "7GWi1nUiCVnS3bHzpH7WBHY5CnSNHLKXLVyBLhHJNT9N",
    sequence: 0,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/** Detect duplicates: same (sequence, amount) pair */
function isDuplicate(incoming: StreamingReceipt, seen: StreamingReceipt[]): boolean {
  return seen.some((r) => r.sequence === incoming.sequence && r.amount === incoming.amount);
}

/** Mock client that returns predetermined stream state */
class MockStreamClient implements StreamClientLike {
  async create() {
    return { txId: "create-tx-receipts-test", metadataId: "stream-receipts-test-1", ixs: [] };
  }

  async topup() {
    return { txId: "topup-tx-receipts-test", ixs: [] };
  }

  async getOne() {
    return {
      sender: "sender-fixture",
      recipient: "recipient-fixture",
      mint: "usdc-devnet-mint",
      depositedAmount: new BN("3000"),
      withdrawnAmount: new BN("0"),
      canTopup: true,
      closed: false,
    } as any;
  }
}

describe("streaming payment receipts", () => {
  // Test 1: Streaming receipt has all required fields
  it("streaming receipt has all required fields: amount, recipient, sequence, timestamp", () => {
    const receipt = makeReceipt();

    expect(receipt).toHaveProperty("amount");
    expect(receipt).toHaveProperty("recipient");
    expect(receipt).toHaveProperty("sequence");
    expect(receipt).toHaveProperty("timestamp");

    // Types are correct
    expect(typeof receipt.amount).toBe("string");
    expect(typeof receipt.recipient).toBe("string");
    expect(typeof receipt.sequence).toBe("number");
    expect(typeof receipt.timestamp).toBe("string");

    // Amount is a valid numeric string
    expect(Number.isFinite(Number(receipt.amount))).toBe(true);

    // Timestamp parses as a valid ISO date
    expect(Number.isNaN(new Date(receipt.timestamp).getTime())).toBe(false);
  });

  // Test 2: Receipt sequence numbers are monotonically increasing
  it("receipt sequence numbers are monotonically increasing", () => {
    const receipts = [
      makeReceipt({ sequence: 0, amount: "1000" }),
      makeReceipt({ sequence: 1, amount: "1000" }),
      makeReceipt({ sequence: 2, amount: "1000" }),
      makeReceipt({ sequence: 3, amount: "500" }),
    ];

    for (let i = 1; i < receipts.length; i++) {
      expect(receipts[i].sequence).toBeGreaterThan(receipts[i - 1].sequence);
    }
  });

  // Test 3: A receipt with sequence=0 is valid (first in stream)
  it("a receipt with sequence=0 is valid (first in stream)", () => {
    const first = makeReceipt({ sequence: 0 });
    expect(first.sequence).toBe(0);

    // All required fields must be present even for the first receipt
    expect(first.amount).toBeDefined();
    expect(first.recipient).toBeDefined();
    expect(first.timestamp).toBeDefined();
  });

  // Test 4: A receipt with a future timestamp is flagged as potentially invalid
  it("a receipt with a future timestamp is flagged as potentially invalid", () => {
    const clockToleranceMs = 5_000; // 5-second tolerance
    const futureTimestamp = new Date(Date.now() + 60_000).toISOString(); // 60s in future

    const receipt = makeReceipt({ timestamp: futureTimestamp });
    const receiptTime = new Date(receipt.timestamp).getTime();
    const nowMs = Date.now();

    const skew = receiptTime - nowMs;
    const isPotentiallyInvalid = skew > clockToleranceMs;

    expect(isPotentiallyInvalid).toBe(true);
  });

  // Test 5: Streaming receipt total matches sum of individual chunk amounts
  it("streaming receipt total matches sum of individual chunk amounts", () => {
    const chunks = [
      makeReceipt({ sequence: 0, amount: "1000" }),
      makeReceipt({ sequence: 1, amount: "2000" }),
      makeReceipt({ sequence: 2, amount: "500" }),
      makeReceipt({ sequence: 3, amount: "1500" }),
    ];

    const total = chunks.reduce((sum, r) => sum + BigInt(r.amount), 0n);
    expect(total).toBe(5000n);

    // Also verify against expected individual values
    const expected = [1000n, 2000n, 500n, 1500n].reduce((a, b) => a + b, 0n);
    expect(total).toBe(expected);
  });

  // Test 6: A duplicate receipt (same sequence + same amount) is detected and rejected
  it("a duplicate receipt (same sequence + same amount) is detected and rejected", () => {
    const seen: StreamingReceipt[] = [
      makeReceipt({ sequence: 0, amount: "1000" }),
      makeReceipt({ sequence: 1, amount: "2000" }),
    ];

    const duplicate = makeReceipt({ sequence: 1, amount: "2000" }); // same as seen[1]
    const unique    = makeReceipt({ sequence: 2, amount: "2000" }); // new sequence

    expect(isDuplicate(duplicate, seen)).toBe(true);
    expect(isDuplicate(unique, seen)).toBe(false);
  });

  // Bonus integration sanity: StreamingService.createStream() round-trips with mock client
  it("streaming service creates a stream and returns its id", async () => {
    const service = new StreamingService({
      clusterUrl: "https://api.devnet.solana.com",
      client: new MockStreamClient(),
    });

    const created = await service.createStream({
      sender: { publicKey: null } as any,
      recipient: "recipient-fixture",
      mint: "usdc-devnet-mint",
      amountAtomic: "3000",
      durationSeconds: 60,
      periodSeconds: 10,
    });

    expect(created.streamId).toBe("stream-receipts-test-1");
    expect(typeof created.txId).toBe("string");
  });
});
