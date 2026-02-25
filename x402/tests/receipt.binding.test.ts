import { describe, expect, it } from "vitest";
import {
  computeRequestDigest,
  computeResponseDigest,
  ReceiptSigner,
  verifyReceiptBinding,
  verifySignedReceipt,
} from "../src/receipts.js";

describe("receipt binding", () => {
  it("validates request/response digest binding and rejects tampering", () => {
    const signer = ReceiptSigner.generate();
    const requestDigest = computeRequestDigest({ method: "GET", path: "/resource", body: { q: 1 } });
    const responseDigest = computeResponseDigest({ status: 200, body: { ok: true } });

    const receipt = signer.sign({
      receiptId: "rb-1",
      quoteId: "q-1",
      commitId: "c-1",
      resource: "/resource",
      requestId: "req-1",
      requestDigest,
      responseDigest,
      shopId: "dnp-core",
      payerCommitment32B: "aa".repeat(32),
      recipient: "recipient",
      mint: "mint",
      amountAtomic: "100",
      feeAtomic: "0",
      totalAtomic: "100",
      settlement: "transfer",
      settledOnchain: true,
      txSignature: "sig-1",
      createdAt: new Date().toISOString(),
    });

    expect(verifySignedReceipt(receipt)).toBe(true);
    expect(verifyReceiptBinding(receipt, {
      requestDigest,
      responseDigest,
      recipient: "recipient",
      mint: "mint",
      totalAtomic: "100",
    })).toBe(true);

    expect(verifyReceiptBinding(receipt, {
      requestDigest,
      responseDigest: computeResponseDigest({ status: 200, body: { ok: false } }),
      recipient: "recipient",
      mint: "mint",
      totalAtomic: "100",
    })).toBe(false);
  });
});
