import { describe, expect, it } from "vitest";
import {
  computeRequestDigest,
  computeResponseDigest,
  createDarkNullPrivacyRequest,
  ReceiptSigner,
  resolveDnaX402SettlementPath,
  verifyDarkNullPrivacyRequest,
} from "../src/index.js";
import type { ReceiptPayload } from "../src/types.js";

function makeSignedReceipt() {
  const signer = ReceiptSigner.generate();
  const payload: ReceiptPayload = {
    receiptId: "receipt_dark_null_demo",
    quoteId: "quote_dark_null_demo",
    commitId: "commit_dark_null_demo",
    resource: "https://provider.example/private-alpha?buyer=alice",
    requestId: "request_dark_null_demo",
    requestDigest: computeRequestDigest({
      method: "POST",
      path: "/private-alpha?buyer=alice",
      body: { ask: "hidden" },
    }),
    responseDigest: computeResponseDigest({
      status: 200,
      body: { paid: true, result: "hidden" },
    }),
    shopId: "shop_dark_null_demo",
    payerCommitment32B: "a".repeat(64),
    recipient: "merchant-vault-devnet",
    mint: "usdc-devnet-mint",
    amountAtomic: "2499",
    feeAtomic: "1",
    totalAtomic: "2500",
    settlement: "transfer",
    settledOnchain: true,
    txSignature: "tx-ok-dark-null-demo-12345678901234567890",
    createdAt: "2026-05-25T12:00:00.000Z",
  };
  return signer.sign(payload);
}

describe("Dark Null optional privacy path", () => {
  it("keeps normal DNA x402 as the default settlement path", () => {
    expect(resolveDnaX402SettlementPath()).toBe("normal");
    expect(resolveDnaX402SettlementPath("normal")).toBe("normal");
    expect(resolveDnaX402SettlementPath("dark-null")).toBe("dark-null");
    expect(() => resolveDnaX402SettlementPath("private" as never)).toThrow(/normal or dark-null/);
  });

  it("creates a hash-only Dark Null request from a signed DNA receipt", () => {
    const request = createDarkNullPrivacyRequest({
      signedReceipt: makeSignedReceipt(),
      target: {
        cluster: "devnet",
        programId: "2stas3cZYnBiWpndcTXQDGLXwfQ7kjEYYrW52DsUAcxF",
        manifestLabel: "canonical-devnet-root-2",
      },
      settlementSlot: 434395918,
      confirmationStatus: "finalized",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    });

    expect(request.settlementPath).toBe("dark-null");
    expect(request.normalPath).toBe("dna-x402");
    expect(request.privacy.rawResourceStored).toBe(false);
    expect(request.privacy.rawPaymentHeaderStored).toBe(false);
    expect(JSON.stringify(request)).not.toContain("provider.example");
    expect(JSON.stringify(request)).not.toContain("buyer=alice");
    expect(verifyDarkNullPrivacyRequest(request)).toMatchObject({ ok: true, failures: [] });
  });

  it("fails closed without canonical transfer settlement evidence", () => {
    const receipt = makeSignedReceipt();
    delete receipt.payload.txSignature;

    expect(() => createDarkNullPrivacyRequest({
      signedReceipt: receipt,
      target: {
        cluster: "devnet",
        programId: "2stas3cZYnBiWpndcTXQDGLXwfQ7kjEYYrW52DsUAcxF",
        manifestLabel: "canonical-devnet-root-2",
      },
      settlementSlot: 434395918,
    })).toThrow(/txSignature/);
  });

  it("rejects tampered privacy request hashes", () => {
    const request = createDarkNullPrivacyRequest({
      signedReceipt: makeSignedReceipt(),
      target: {
        cluster: "devnet",
        programId: "2stas3cZYnBiWpndcTXQDGLXwfQ7kjEYYrW52DsUAcxF",
        manifestLabel: "canonical-devnet-root-2",
      },
      settlementSlot: 434395918,
    });

    const tampered = {
      ...request,
      dna: {
        ...request.dna,
        amountAtomic: "9999",
      },
    };

    expect(verifyDarkNullPrivacyRequest(tampered).ok).toBe(false);
  });
});
