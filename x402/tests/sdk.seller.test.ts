import { EventEmitter } from "node:events";
import express, { type Request, type RequestHandler, type Response } from "express";
import { describe, expect, it } from "vitest";
import type { PaymentVerifier } from "../src/paymentVerifier.js";
import { computeRequestDigest, computeResponseDigest, verifySignedReceipt } from "../src/receipts.js";
import type { PaymentProof, Quote } from "../src/types.js";
import { dnaPrice, dnaSeller } from "../src/sdk/seller.js";

class FakeVerifier implements PaymentVerifier {
  constructor(
    private readonly response:
      | { ok: true; settledOnchain: boolean; txSignature?: string }
      | { ok: false; settledOnchain: false; error?: string; errorCode?: "INVALID_PROOF" | "PAYMENT_INVALID"; retryable?: boolean },
  ) {}

  async verify(_quote: Quote, _paymentProof: PaymentProof) {
    return this.response;
  }
}

class MockResponse extends EventEmitter {
  statusCode = 200;
  body: unknown;
  headers: Record<string, string> = {};

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(body: unknown): this {
    this.body = body;
    this.emit("finish");
    return this;
  }

  send(body: unknown): this {
    this.body = body;
    this.emit("finish");
    return this;
  }

  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }
}

function makeRequest(input: {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  params?: Record<string, string>;
  path?: string;
} = {}): Request {
  const headers = Object.fromEntries(
    Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    body: input.body,
    method: input.method ?? "GET",
    params: input.params ?? {},
    path: input.path ?? "/",
    protocol: "https",
    headers,
    header(name: string) {
      return headers[name.toLowerCase()];
    },
    get(name: string) {
      if (name.toLowerCase() === "host") {
        return "example.test";
      }
      return headers[name.toLowerCase()];
    },
  } as Request;
}

function makeResponse(): Response {
  return new MockResponse() as unknown as Response;
}

async function invoke(handler: RequestHandler, req: Request, res: Response, next?: () => void): Promise<void> {
  await Promise.resolve(handler(req, res, next ?? (() => undefined)));
}

function routeHandler(app: express.Express, method: "get" | "post", pathName: string): RequestHandler {
  const stack = (app as express.Express & { _router?: { stack: Array<any> } })._router?.stack ?? [];
  const layer = stack.find((entry) => entry.route?.path === pathName && entry.route.methods?.[method]);
  if (!layer?.route?.stack?.[0]?.handle) {
    throw new Error(`Route not found: ${method.toUpperCase()} ${pathName}`);
  }
  return layer.route.stack[0].handle as RequestHandler;
}

describe("dnaSeller", () => {
  it("uses a network-aware USDC mint by default", () => {
    const app = express();
    const devnetSeller = dnaSeller(app, {
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
    });
    const mainnetSeller = dnaSeller(app, {
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      network: "solana-mainnet",
    });

    expect(devnetSeller.createQuote("/api/devnet", "5000", "https://example.test").mint)
      .toBe("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    expect(mainnetSeller.createQuote("/api/mainnet", "5000", "https://example.test").mint)
      .toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  });

  it("uses bigint-safe fee math for large quotes", () => {
    const app = express();
    const seller = dnaSeller(app, {
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      feeBps: 30,
    });

    const quote = seller.createQuote("https://example.test/api/huge", "900719925474099312345", "https://example.test");
    const expectedFee = ((900719925474099312345n * 30n) + 9_999n) / 10_000n;

    expect(quote.feeAtomic).toBe(expectedFee.toString());
    expect(quote.totalAtomic).toBe((900719925474099312345n + expectedFee).toString());
  });

  it("verifies transfer proofs and emits on-chain receipt data", async () => {
    const app = express();
    const seller = dnaSeller(app, {
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      network: "solana-devnet",
      paymentVerifier: new FakeVerifier({
        ok: true,
        settledOnchain: true,
        txSignature: "tx-ok-seller-12345678901234567890",
      }),
    });

    const quote = seller.createQuote("/api/inference", "5000", "https://example.test");

    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest({
      method: "POST",
      path: "/commit",
      body: { quoteId: quote.quoteId, payerCommitment32B: "0x" + "11".repeat(32) },
    }), commitRes);
    expect(commitRes.statusCode).toBe(201);
    const commitId = (commitRes.body as { commitId: string }).commitId;

    const finalizeRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/finalize"), makeRequest({
      method: "POST",
      path: "/finalize",
      body: {
        commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-seller-12345678901234567890",
        },
      },
    }), finalizeRes);

    expect(finalizeRes.statusCode).toBe(200);
    const finalizeBody = finalizeRes.body as { receiptId: string; commitId: string; settlement: string };
    const receiptId = (finalizeRes.body as { receiptId: string }).receiptId;

    const receiptRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "get", "/receipt/:id"), makeRequest({
      method: "GET",
      path: `/receipt/${receiptId}`,
      params: { id: receiptId },
    }), receiptRes);

    expect(receiptRes.body).toMatchObject({
      payload: {
        settlement: "transfer",
        settledOnchain: true,
        txSignature: "tx-ok-seller-12345678901234567890",
        requestDigest: computeRequestDigest({
          method: "POST",
          path: "/finalize",
          body: {
            commitId,
            paymentProof: {
              settlement: "transfer",
              txSignature: "tx-ok-seller-12345678901234567890",
            },
          },
        }),
        responseDigest: computeResponseDigest({ status: 200, body: finalizeBody }),
      },
    });
    expect(verifySignedReceipt(receiptRes.body as Parameters<typeof verifySignedReceipt>[0])).toBe(true);
  });

  it("rejects malformed payer commitments during commit", async () => {
    const app = express();
    const seller = dnaSeller(app, {
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      paymentVerifier: new FakeVerifier({
        ok: true,
        settledOnchain: true,
        txSignature: "tx-ok-seller-commit-12345678901234567890",
      }),
    });

    const quote = seller.createQuote("/api/inference", "5000", "https://example.test");
    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest({
      method: "POST",
      path: "/commit",
      body: { quoteId: quote.quoteId, payerCommitment32B: "not-a-32-byte-hex" },
    }), commitRes);

    expect(commitRes.statusCode).toBe(400);
    expect(commitRes.body).toMatchObject({
      error: "payerCommitment32B must be 32-byte hex (64 chars)",
    });
  });

  it("rejects invalid proofs instead of unlocking the paid commit", async () => {
    const app = express();
    const seller = dnaSeller(app, {
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      paymentVerifier: new FakeVerifier({
        ok: false,
        settledOnchain: false,
        error: "invalid tx signature format",
        errorCode: "INVALID_PROOF",
        retryable: false,
      }),
    });

    const quote = seller.createQuote("/api/inference", "5000", "https://example.test");
    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest({
      method: "POST",
      path: "/commit",
      body: { quoteId: quote.quoteId, payerCommitment32B: "0x" + "22".repeat(32) },
    }), commitRes);
    const commitId = (commitRes.body as { commitId: string }).commitId;

    const finalizeRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/finalize"), makeRequest({
      method: "POST",
      path: "/finalize",
      body: {
        commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "not-a-real-signature",
        },
      },
    }), finalizeRes);

    expect(finalizeRes.statusCode).toBe(422);
    expect(finalizeRes.body).toMatchObject({
      ok: false,
      error: { code: "INVALID_PROOF" },
    });
    expect(seller.paidCommits.has(commitId)).toBe(false);
  });

  it("emits a delivery-bound receipt on unlocked JSON responses", async () => {
    const app = express();
    const seller = dnaSeller(app, {
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      paymentVerifier: new FakeVerifier({
        ok: true,
        settledOnchain: true,
        txSignature: "tx-ok-seller-delivery-123456789012345678",
      }),
    });

    const quote = seller.createQuote("/api/premium", "5000", "https://example.test");
    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest({
      method: "POST",
      path: "/commit",
      body: { quoteId: quote.quoteId, payerCommitment32B: "0x" + "44".repeat(32) },
    }), commitRes);
    const commitId = (commitRes.body as { commitId: string }).commitId;

    await invoke(routeHandler(app, "post", "/finalize"), makeRequest({
      method: "POST",
      path: "/finalize",
      body: {
        commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-seller-delivery-123456789012345678",
        },
      },
    }), makeResponse());

    const gate = dnaPrice("5000", seller);
    const unlockedRes = makeResponse() as Response & MockResponse;
    await invoke(
      gate,
      makeRequest({
        method: "GET",
        path: "/api/premium",
        headers: { "x-dnp-commit-id": commitId },
      }),
      unlockedRes,
      () => {
        unlockedRes.json({ ok: true, result: "premium output" });
      },
    );

    expect(unlockedRes.statusCode).toBe(200);
    const unlockedBody = unlockedRes.body as {
      ok: boolean;
      result: string;
      receipt: SignedReceipt;
    };
    expect(unlockedBody.result).toBe("premium output");
    expect(verifySignedReceipt(unlockedBody.receipt)).toBe(true);
    expect(unlockedBody.receipt.payload.requestDigest).toBe(computeRequestDigest({
      method: "GET",
      path: "/api/premium",
    }));
    expect(unlockedBody.receipt.payload.responseDigest).toBe(computeResponseDigest({
      status: 200,
      body: {
        ok: true,
        result: "premium output",
      },
    }));
  });

  it("restores a paid commit after a 500 response and consumes it only after success", async () => {
    const app = express();
    const seller = dnaSeller(app, {
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      paymentVerifier: new FakeVerifier({
        ok: true,
        settledOnchain: true,
        txSignature: "tx-ok-seller-retry-12345678901234567890",
      }),
    });

    const quote = seller.createQuote("/api/retry", "5000", "https://example.test");
    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest({
      method: "POST",
      path: "/commit",
      body: { quoteId: quote.quoteId, payerCommitment32B: "0x" + "66".repeat(32) },
    }), commitRes);
    const commitId = (commitRes.body as { commitId: string }).commitId;

    await invoke(routeHandler(app, "post", "/finalize"), makeRequest({
      method: "POST",
      path: "/finalize",
      body: {
        commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-seller-retry-12345678901234567890",
        },
      },
    }), makeResponse());

    const failedRes = makeResponse() as Response & MockResponse;
    await invoke(
      dnaPrice("5000", seller),
      makeRequest({
        method: "GET",
        path: "/api/retry",
        headers: { "x-dnp-commit-id": commitId },
      }),
      failedRes,
      () => {
        failedRes.status(500).json({ error: "boom" });
      },
    );

    expect(seller.paidCommits.has(commitId)).toBe(true);
    expect((failedRes.body as { receipt?: unknown }).receipt).toBeUndefined();

    const okRes = makeResponse() as Response & MockResponse;
    await invoke(
      dnaPrice("5000", seller),
      makeRequest({
        method: "GET",
        path: "/api/retry",
        headers: { "x-dnp-commit-id": commitId },
      }),
      okRes,
      () => {
        okRes.json({ ok: true, result: "retry worked" });
      },
    );

    expect(seller.paidCommits.has(commitId)).toBe(false);
    expect((okRes.body as { receipt?: SignedReceipt }).receipt).toBeTruthy();
  });
});
