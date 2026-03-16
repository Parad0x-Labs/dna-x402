import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWith402, InMemoryReceiptStore } from "../src/client.js";
import { computeRequestDigest, computeResponseDigest, ReceiptSigner } from "../src/receipts.js";
import type { SignedReceipt } from "../src/types.js";
import { encodeCanonicalRequiredHeader } from "../src/x402/compat/parse.js";

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...(headers ?? {}),
    },
  });
}

function compat402Response(overrides: Partial<{
  amountAtomic: string;
  mint: string;
  recipient: string;
  memo: string;
}> = {}): Response {
  return jsonResponse({ error: "payment_required" }, 402, {
    "payment-required": encodeCanonicalRequiredHeader({
      version: "x402-v1",
      network: "solana",
      currency: "USDC",
      amountAtomic: overrides.amountAtomic ?? "1000",
      recipient: overrides.recipient ?? "recipient-1",
      memo: overrides.memo ?? "memo-compat-1",
      expiresAt: Date.parse("2026-03-16T00:10:00.000Z"),
      settlement: {
        mode: "spl_transfer",
        mint: overrides.mint ?? "mint-1",
      },
      raw: { headers: {} },
    }),
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
    requestDigest: computeRequestDigest({
      method: "GET",
      path: "/resource",
    }),
    responseDigest: computeResponseDigest({
      status: 200,
      body: {
        ok: true,
        data: "resource payload",
      },
    }),
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
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        data: "resource payload",
        receipt,
      }, 200));

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
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        data: "resource payload",
        receipt,
      }, 200));

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

  it("rejects unlocked responses that do not match the signed response digest", async () => {
    const receipt = makeSignedReceipt();

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
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        data: "tampered payload",
        receipt,
      }, 200));

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
    })).rejects.toThrow(/response digest mismatch/i);
  });

  it("rejects unlocked responses when the signed request digest does not match the delivered request", async () => {
    const receipt = makeSignedReceipt({
      requestDigest: computeRequestDigest({
        method: "GET",
        path: "/wrong-resource",
      }),
    });

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
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        data: "resource payload",
        receipt,
      }, 200));

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
    })).rejects.toThrow(/request digest mismatch/i);
  });

  it("verifies and stores embedded receipts in x402 header-compat flow", async () => {
    const store = new InMemoryReceiptStore();
    const receipt = makeSignedReceipt({
      quoteId: "compat-quote-unused",
      commitId: "compat-commit-unused",
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(compat402Response())
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        data: "resource payload",
        receipt,
      }, 200));

    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchWith402("https://seller.test/resource", {
      wallet: {
        async payTransfer() {
          return {
            settlement: "transfer",
            txSignature: "tx-ok-client-1234567890123456789012345",
          };
        },
      },
      maxSpendAtomic: "1000",
      receiptStore: store,
      proofHeaderStyle: "X-PAYMENT",
    });

    expect(result.response.status).toBe(200);
    expect(result.receipt?.payload.receiptId).toBe("receipt-1");
    expect(store.receipts.size).toBe(1);
  });

  it("rejects tampered embedded receipts in x402 header-compat flow", async () => {
    const receipt = makeSignedReceipt({
      responseDigest: computeResponseDigest({
        status: 200,
        body: {
          ok: true,
          data: "different payload",
        },
      }),
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(compat402Response())
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        data: "resource payload",
        receipt,
      }, 200));

    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWith402("https://seller.test/resource", {
      wallet: {
        async payTransfer() {
          return {
            settlement: "transfer",
            txSignature: "tx-ok-client-1234567890123456789012345",
          };
        },
      },
      maxSpendAtomic: "1000",
      proofHeaderStyle: "X-PAYMENT",
    })).rejects.toThrow(/embedded receipt binding mismatch/i);
  });
});
