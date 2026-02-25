import { describe, expect, it } from "vitest";
import { ReceiptSigner, verifySignedReceipt } from "../src/receipts.js";

describe("receipt chain", () => {
  it("creates verifiable signed hash-chained receipts", () => {
    const signer = ReceiptSigner.generate();

    const r1 = signer.sign({
      receiptId: "r1",
      quoteId: "q1",
      commitId: "c1",
      resource: "/resource",
      requestId: "req1",
      requestDigest: "digest-req1",
      responseDigest: "digest-res1",
      shopId: "dnp-core",
      payerCommitment32B: "aa".repeat(32),
      recipient: "recipient",
      mint: "mint",
      amountAtomic: "100",
      feeAtomic: "1",
      totalAtomic: "101",
      settlement: "transfer",
      settledOnchain: true,
      txSignature: "sig1",
      createdAt: new Date().toISOString(),
    });

    const r2 = signer.sign({
      receiptId: "r2",
      quoteId: "q2",
      commitId: "c2",
      resource: "/resource",
      requestId: "req2",
      requestDigest: "digest-req2",
      responseDigest: "digest-res2",
      shopId: "dnp-core",
      payerCommitment32B: "bb".repeat(32),
      recipient: "recipient",
      mint: "mint",
      amountAtomic: "200",
      feeAtomic: "1",
      totalAtomic: "201",
      settlement: "netting",
      settledOnchain: false,
      createdAt: new Date().toISOString(),
    });

    expect(verifySignedReceipt(r1)).toBe(true);
    expect(verifySignedReceipt(r2)).toBe(true);
    expect(r2.prevHash).toBe(r1.receiptHash);
  });

  it("fails verification if receipt payload is tampered", () => {
    const signer = ReceiptSigner.generate();
    const receipt = signer.sign({
      receiptId: "r3",
      quoteId: "q3",
      commitId: "c3",
      resource: "/resource",
      requestId: "req3",
      requestDigest: "digest-req3",
      responseDigest: "digest-res3",
      shopId: "dnp-core",
      payerCommitment32B: "cc".repeat(32),
      recipient: "recipient",
      mint: "mint",
      amountAtomic: "300",
      feeAtomic: "2",
      totalAtomic: "302",
      settlement: "transfer",
      settledOnchain: true,
      txSignature: "sig3",
      createdAt: new Date().toISOString(),
    });

    receipt.payload.totalAtomic = "999";
    expect(verifySignedReceipt(receipt)).toBe(false);
  });
});
