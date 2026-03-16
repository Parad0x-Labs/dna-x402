import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWith402, InMemoryReceiptStore } from "../src/client.js";
import { ReceiptSigner } from "../src/receipts.js";
import type { SignedReceipt } from "../src/types.js";

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...(headers ?? {}),
    },
  });
}

function makeSignedReceipt(overrides: Partial<SignedReceipt["payload"]> = {}): SignedReceipt {
  const signer = ReceiptSigner.generate();
  return signer.sign({
    receiptId: "receipt-1",
    quoteId: "quote-1",
    commitId: "commit-1",
    resource: "/resource",
    requestId: "commit-1",
    requestDigest: "memo-1",
    responseDigest: "",
    shopId: "self",
    payerCommitment32B: "aa".repeat(32),
    recipient: "recipient-1",
    mint: "mint-1",
    amountAtomic: "1000",
    feeAtomic: "0",
    totalAtomic: "1000",
    settlement: "transfer",
    settledOnchain: true,
    txSignature: "tx-ok-client-12345678901234567890",
    createdAt: "2026-03-16T00:00:00.000Z",
    ...overrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchWith402 receipt verification", () => {
  it("rejects tampered signed receipts", async () => {
    const receipt = makeSignedReceipt();
    receipt.payload.totalAtomic = "9999";

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
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
            settlement: ["transfer"],
            memoHash: "memo-1",
          },
          accepts: [{
            scheme: "solana-spl",
            network: "solana-devnet",
            mint: "mint-1",
            maxAmount: "1000",
            recipient: "recipient-1",
            mode: "transfer",
          }],
          recommendedMode: "transfer",
          commitEndpoint: "https://seller.test/commit",
          finalizeEndpoint: "https://seller.test/finalize",
          receiptEndpoint: "https://seller.test/receipt/:receiptId",
        },
      }, 402))
      .mockResolvedValueOnce(jsonResponse({ commitId: "commit-1" }, 201))
      .mockResolvedValueOnce(jsonResponse({ ok: true, receiptId: "receipt-1" }))
      .mockResolvedValueOnce(jsonResponse(receipt))
      .mockResolvedValueOnce(jsonResponse({ ok: true }, 200));

    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWith402("https://seller.test/resource", {
      wallet: {
        async payTransfer() {
          return {
            settlement: "transfer",
            txSignature: "tx-ok-client-12345678901234567890",
          };
        },
      },
      maxSpendAtomic: "1000",
      receiptStore: new InMemoryReceiptStore(),
    })).rejects.toThrow(/invalid signature|tampered payload/i);
  });

  it("rejects receipts that do not match the quoted recipient or total", async () => {
    const receipt = makeSignedReceipt({ recipient: "wrong-recipient" });
    const store = new InMemoryReceiptStore();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
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
            settlement: ["transfer"],
            memoHash: "memo-1",
          },
          accepts: [{
            scheme: "solana-spl",
            network: "solana-devnet",
            mint: "mint-1",
            maxAmount: "1000",
            recipient: "recipient-1",
            mode: "transfer",
          }],
          recommendedMode: "transfer",
          commitEndpoint: "https://seller.test/commit",
          finalizeEndpoint: "https://seller.test/finalize",
          receiptEndpoint: "https://seller.test/receipt/:receiptId",
        },
      }, 402))
      .mockResolvedValueOnce(jsonResponse({ commitId: "commit-1" }, 201))
      .mockResolvedValueOnce(jsonResponse({ ok: true, receiptId: "receipt-1" }))
      .mockResolvedValueOnce(jsonResponse(receipt))
      .mockResolvedValueOnce(jsonResponse({ ok: true }, 200));

    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWith402("https://seller.test/resource", {
      wallet: {
        async payTransfer() {
          return {
            settlement: "transfer",
            txSignature: "tx-ok-client-12345678901234567890",
          };
        },
      },
      maxSpendAtomic: "1000",
      receiptStore: store,
    })).rejects.toThrow(/recipient mismatch/i);

    expect(store.receipts.size).toBe(0);
  });
});
