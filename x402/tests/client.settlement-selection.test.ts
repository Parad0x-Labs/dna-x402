import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWith402 } from "../src/client.js";
import { computeRequestDigest, computeResponseDigest, ReceiptSigner } from "../src/receipts.js";
import type { PaymentProof, SignedReceipt } from "../src/types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function makeSignedFinalizeReceipt(paymentProof: PaymentProof): SignedReceipt {
  const signer = ReceiptSigner.generate();
  return signer.sign({
    receiptId: "receipt-1",
    quoteId: "quote-1",
    commitId: "commit-1",
    resource: "/paid",
    requestId: "commit-1",
    requestDigest: computeRequestDigest({
      method: "POST",
      path: "/finalize",
      body: {
        commitId: "commit-1",
        paymentProof,
      },
    }),
    responseDigest: computeResponseDigest({
      status: 200,
      body: {
        ok: true,
        receiptId: "receipt-1",
        commitId: "commit-1",
        settlement: paymentProof.settlement,
      },
    }),
    shopId: "self",
    payerCommitment32B: "aa".repeat(32),
    recipient: "recipient-1",
    mint: "mint-1",
    amountAtomic: "1000",
    feeAtomic: "0",
    totalAtomic: "1000",
    settlement: paymentProof.settlement,
    settledOnchain: paymentProof.settlement === "transfer",
    txSignature: paymentProof.settlement === "transfer" ? paymentProof.txSignature : undefined,
    createdAt: "2026-03-16T00:00:00.000Z",
  });
}

function paymentRequiredResponse(recommendedMode: "transfer" | "netting"): Response {
  return jsonResponse({
    paymentRequirements: {
      version: "x402-dnp-v1",
      quote: {
        quoteId: "quote-1",
        amount: "1000",
        feeAtomic: "0",
        totalAtomic: "1000",
        mint: "mint-1",
        recipient: "recipient-1",
        expiresAt: "2026-03-16T00:10:00.000Z",
        settlement: ["transfer", "netting"],
        memoHash: "memo-1",
      },
      accepts: [{
        scheme: "solana-spl",
        network: "solana-devnet",
        mint: "mint-1",
        maxAmount: "1000",
        recipient: "recipient-1",
        mode: "transfer",
      }, {
        scheme: "solana-spl",
        network: "solana-devnet",
        mint: "mint-1",
        maxAmount: "1000",
        recipient: "recipient-1",
        mode: "netting",
      }],
      recommendedMode,
      commitEndpoint: "https://seller.test/commit",
      finalizeEndpoint: "https://seller.test/finalize",
      receiptEndpoint: "https://seller.test/receipt/:receiptId",
    },
  }, 402);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchWith402 settlement selection", () => {
  it("defaults to transfer when netting is available but not explicitly preferred", async () => {
    const transferProof: PaymentProof = {
      settlement: "transfer",
      txSignature: "tx-ok-client-12345678901234567890",
    };
    const transferReceipt = makeSignedFinalizeReceipt(transferProof);
    const payTransfer = vi.fn().mockResolvedValue(transferProof);
    const payNetted = vi.fn().mockResolvedValue({
      settlement: "netting",
      amountAtomic: "1000",
      note: "net-1",
    } satisfies PaymentProof);

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(paymentRequiredResponse("transfer"))
      .mockResolvedValueOnce(jsonResponse({ commitId: "commit-1" }, 201))
      .mockResolvedValueOnce(jsonResponse({ ok: true, receiptId: "receipt-1", commitId: "commit-1", settlement: "transfer" }))
      .mockResolvedValueOnce(jsonResponse(transferReceipt))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: "paid" })));

    const result = await fetchWith402("https://seller.test/paid", {
      wallet: {
        payTransfer,
        payNetted,
      },
      maxSpendAtomic: "1000",
    });

    expect(result.response.status).toBe(200);
    expect(payTransfer).toHaveBeenCalledTimes(1);
    expect(payNetted).not.toHaveBeenCalled();
  });

  it("uses netting only when explicitly preferred", async () => {
    const nettingProof: PaymentProof = {
      settlement: "netting",
      amountAtomic: "1000",
      note: "net-1",
    };
    const nettingReceipt = makeSignedFinalizeReceipt(nettingProof);
    const payTransfer = vi.fn().mockResolvedValue({
      settlement: "transfer",
      txSignature: "tx-should-not-be-used-123456789012345",
    } satisfies PaymentProof);
    const payNetted = vi.fn().mockResolvedValue(nettingProof);

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(paymentRequiredResponse("transfer"))
      .mockResolvedValueOnce(jsonResponse({ commitId: "commit-1" }, 201))
      .mockResolvedValueOnce(jsonResponse({ ok: true, receiptId: "receipt-1", commitId: "commit-1", settlement: "netting" }))
      .mockResolvedValueOnce(jsonResponse(nettingReceipt))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: "paid" })));

    const result = await fetchWith402("https://seller.test/paid", {
      wallet: {
        payTransfer,
        payNetted,
      },
      maxSpendAtomic: "1000",
      preferNetting: true,
    });

    expect(result.response.status).toBe(200);
    expect(payNetted).toHaveBeenCalledTimes(1);
    expect(payTransfer).not.toHaveBeenCalled();
  });
});
