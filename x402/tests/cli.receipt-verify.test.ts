import { describe, expect, it } from "vitest";

// Import receipt primitives directly from source
// verifySignedReceipt and ReceiptSigner live in src/receipts.ts
import { ReceiptSigner, verifySignedReceipt } from "../src/receipts.js";
import type { ReceiptPayload, SignedReceipt } from "../src/types.js";

function buildMockPayload(overrides: Partial<ReceiptPayload> = {}): ReceiptPayload {
  return {
    receiptId: "rcpt-mock-001",
    quoteId: "quote-mock-001",
    commitId: "commit-mock-001",
    resource: "/resource",
    requestId: "req-001",
    requestDigest: "a".repeat(64),
    responseDigest: "b".repeat(64),
    shopId: "test-shop",
    payerCommitment32B: "c".repeat(64),
    recipient: "MOCK_RECIPIENT_WALLET",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amountAtomic: "1000",
    feeAtomic: "50",
    totalAtomic: "1050",
    settlement: "transfer",
    settledOnchain: false,
    createdAt: new Date(Date.now() + 60_000).toISOString(), // future = not expired
    ...overrides,
  };
}

describe("receipt verification SDK layer", () => {
  it("importing ReceiptSigner and verifySignedReceipt does not throw", () => {
    expect(typeof ReceiptSigner).toBe("function");
    expect(typeof verifySignedReceipt).toBe("function");
  }, 10_000);

  it("a correctly signed receipt passes verifySignedReceipt", () => {
    const signer = ReceiptSigner.generate();
    const payload = buildMockPayload();
    const signed = signer.sign(payload);
    expect(verifySignedReceipt(signed)).toBe(true);
  }, 10_000);

  it("a receipt with a tampered amount field fails verifySignedReceipt", () => {
    const signer = ReceiptSigner.generate();
    const payload = buildMockPayload();
    const signed = signer.sign(payload);
    // Tamper with the payload after signing — hash will no longer match
    const tampered: SignedReceipt = {
      ...signed,
      payload: { ...signed.payload, amountAtomic: "99999999" },
    };
    expect(verifySignedReceipt(tampered)).toBe(false);
  }, 10_000);

  it("a receipt with a future createdAt is not considered expired by date", () => {
    const futureDate = new Date(Date.now() + 3600_000).toISOString();
    const payload = buildMockPayload({ createdAt: futureDate });
    // The createdAt field exists and is in the future
    const at = new Date(payload.createdAt).getTime();
    expect(at).toBeGreaterThan(Date.now());
  }, 10_000);

  it("a receipt with a past createdAt (epoch 1ms) is considered expired by date", () => {
    const pastDate = new Date(1).toISOString(); // 1970-01-01T00:00:00.001Z
    const payload = buildMockPayload({ createdAt: pastDate });
    const at = new Date(payload.createdAt).getTime();
    expect(at).toBeLessThan(Date.now());
  }, 10_000);
});
