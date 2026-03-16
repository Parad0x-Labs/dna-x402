import { EventEmitter } from "node:events";
import express, { type Request, type RequestHandler, type Response } from "express";
import { describe, expect, it, vi } from "vitest";
import type { PaymentVerifier } from "../src/paymentVerifier.js";
import {
  computeRequestDigest,
  computeResponseDigest,
  decodeReceiptHeader,
  RECEIPT_HEADER_NAME,
  verifySignedReceipt,
} from "../src/receipts.js";
import type { PaymentProof, Quote } from "../src/types.js";
import { dnaPaywall } from "../src/sdk/paywall.js";

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

class RecordingVerifier implements PaymentVerifier {
  lastQuote?: Quote;

  async verify(quote: Quote, _paymentProof: PaymentProof) {
    this.lastQuote = quote;
    return {
      ok: true,
      settledOnchain: true,
      txSignature: "tx-ok-paywall-recording-12345678901234567890",
    } as const;
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

function makeRequest(app: express.Express, input: {
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
    app,
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

describe("dnaPaywall", () => {
  it("uses a network-aware USDC mint by default", async () => {
    const app = express();
    const devnetMiddleware = dnaPaywall({
      priceAtomic: "1000",
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      paymentVerifier: new FakeVerifier({
        ok: true,
        settledOnchain: true,
        txSignature: "tx-ok-paywall-default-devnet-1234567890",
      }),
    });
    const mainnetMiddleware = dnaPaywall({
      priceAtomic: "1000",
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      network: "solana-mainnet",
      paymentVerifier: new FakeVerifier({
        ok: true,
        settledOnchain: true,
        txSignature: "tx-ok-paywall-default-mainnet-1234567890",
      }),
    });

    const devnetRes = makeResponse() as Response & MockResponse;
    await invoke(devnetMiddleware, makeRequest(app, { method: "GET", path: "/api/devnet" }), devnetRes);
    expect(devnetRes.body).toMatchObject({
      paymentRequirements: {
        quote: { mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" },
      },
    });

    const mainnetRes = makeResponse() as Response & MockResponse;
    await invoke(mainnetMiddleware, makeRequest(app, { method: "GET", path: "/api/mainnet" }), mainnetRes);
    expect(mainnetRes.body).toMatchObject({
      paymentRequirements: {
        quote: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
      },
    });
  });

  it("rejects malformed payer commitments during commit", async () => {
    const app = express();
    const middleware = dnaPaywall({
      priceAtomic: "1000",
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      paymentVerifier: new FakeVerifier({
        ok: true,
        settledOnchain: true,
        txSignature: "tx-ok-paywall-bad-commit-1234567890",
      }),
    });

    const firstRes = makeResponse() as Response & MockResponse;
    await invoke(middleware, makeRequest(app, { method: "GET", path: "/api/commit-check" }), firstRes);
    const quoteId = (firstRes.body as {
      paymentRequirements: { quote: { quoteId: string } };
    }).paymentRequirements.quote.quoteId;

    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest(app, {
      method: "POST",
      path: "/commit",
      body: { quoteId, payerCommitment32B: "not-a-32-byte-hex" },
    }), commitRes);

    expect(commitRes.statusCode).toBe(400);
    expect(commitRes.body).toMatchObject({
      error: "payerCommitment32B must be 32-byte hex (64 chars)",
    });
  });

  it("mounts commit/finalize/receipt routes and unlocks the route after verification", async () => {
    const app = express();
    const onPaymentVerified = vi.fn();
    const middleware = dnaPaywall({
      priceAtomic: "1000",
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      network: "solana-devnet",
      paymentVerifier: new FakeVerifier({
        ok: true,
        settledOnchain: true,
        txSignature: "tx-ok-paywall-12345678901234567890",
      }),
      onPaymentVerified,
    });

    const firstRes = makeResponse() as Response & MockResponse;
    await invoke(middleware, makeRequest(app, { method: "GET", path: "/api/cheap" }), firstRes);
    expect(firstRes.statusCode).toBe(402);
    expect(firstRes.body).toMatchObject({
      paymentRequirements: {
        accepts: [{ network: "solana-devnet", mode: "transfer" }],
        commitEndpoint: "https://example.test/commit",
        finalizeEndpoint: "https://example.test/finalize",
      },
    });

    const quoteId = (firstRes.body as {
      paymentRequirements: { quote: { quoteId: string } };
    }).paymentRequirements.quote.quoteId;

    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest(app, {
      method: "POST",
      path: "/commit",
      body: { quoteId, payerCommitment32B: "0x" + "33".repeat(32) },
    }), commitRes);
    expect(commitRes.statusCode).toBe(201);
    const commitId = (commitRes.body as { commitId: string }).commitId;

    const finalizeRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/finalize"), makeRequest(app, {
      method: "POST",
      path: "/finalize",
      body: {
        commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-paywall-12345678901234567890",
        },
      },
    }), finalizeRes);
    expect(finalizeRes.statusCode).toBe(200);
    const finalizeBody = finalizeRes.body as { receiptId: string; commitId: string; settlement: string };
    const receiptId = (finalizeRes.body as { receiptId: string }).receiptId;

    const receiptRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "get", "/receipt/:id"), makeRequest(app, {
      method: "GET",
      path: `/receipt/${receiptId}`,
      params: { id: receiptId },
    }), receiptRes);
    expect(receiptRes.body).toMatchObject({
      payload: {
        settlement: "transfer",
        settledOnchain: true,
        txSignature: "tx-ok-paywall-12345678901234567890",
        requestDigest: computeRequestDigest({
          method: "POST",
          path: "/finalize",
          body: {
            commitId,
            paymentProof: {
              settlement: "transfer",
              txSignature: "tx-ok-paywall-12345678901234567890",
            },
          },
        }),
        responseDigest: computeResponseDigest({ status: 200, body: finalizeBody }),
      },
    });
    expect(verifySignedReceipt(receiptRes.body as Parameters<typeof verifySignedReceipt>[0])).toBe(true);

    let nextCalled = false;
    const unlockedRes = makeResponse() as Response & MockResponse;
    await invoke(
      middleware,
      makeRequest(app, {
        method: "GET",
        path: "/api/cheap",
        headers: { "x-dnp-commit-id": commitId },
      }),
      unlockedRes,
      () => {
        nextCalled = true;
        unlockedRes.json({ ok: true, data: "paid response" });
      },
    );

    expect(nextCalled).toBe(true);
    expect(onPaymentVerified).toHaveBeenCalledTimes(1);
  });

  it("verifies payments against the quoted protected resource instead of /finalize", async () => {
    const app = express();
    const verifier = new RecordingVerifier();
    const middleware = dnaPaywall({
      priceAtomic: "1000",
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      paymentVerifier: verifier,
    });

    const firstRes = makeResponse() as Response & MockResponse;
    await invoke(middleware, makeRequest(app, { method: "GET", path: "/api/resource-check" }), firstRes);
    const quoteId = (firstRes.body as {
      paymentRequirements: { quote: { quoteId: string } };
    }).paymentRequirements.quote.quoteId;

    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest(app, {
      method: "POST",
      path: "/commit",
      body: { quoteId, payerCommitment32B: "0x" + "34".repeat(32) },
    }), commitRes);
    const commitId = (commitRes.body as { commitId: string }).commitId;

    await invoke(routeHandler(app, "post", "/finalize"), makeRequest(app, {
      method: "POST",
      path: "/finalize",
      body: {
        commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-paywall-recording-12345678901234567890",
        },
      },
    }), makeResponse());

    expect(verifier.lastQuote?.resource).toBe("/api/resource-check");
  });

  it("emits a delivery-bound receipt on unlocked JSON responses", async () => {
    const app = express();
    const middleware = dnaPaywall({
      priceAtomic: "1000",
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      paymentVerifier: new FakeVerifier({
        ok: true,
        settledOnchain: true,
        txSignature: "tx-ok-paywall-delivery-123456789012345678",
      }),
    });

    const firstRes = makeResponse() as Response & MockResponse;
    await invoke(middleware, makeRequest(app, { method: "GET", path: "/api/delivery" }), firstRes);
    const quoteId = (firstRes.body as {
      paymentRequirements: { quote: { quoteId: string } };
    }).paymentRequirements.quote.quoteId;

    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest(app, {
      method: "POST",
      path: "/commit",
      body: { quoteId, payerCommitment32B: "0x" + "55".repeat(32) },
    }), commitRes);
    const commitId = (commitRes.body as { commitId: string }).commitId;

    await invoke(routeHandler(app, "post", "/finalize"), makeRequest(app, {
      method: "POST",
      path: "/finalize",
      body: {
        commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-paywall-delivery-123456789012345678",
        },
      },
    }), makeResponse());

    const unlockedRes = makeResponse() as Response & MockResponse;
    await invoke(
      middleware,
      makeRequest(app, {
        method: "GET",
        path: "/api/delivery",
        headers: { "x-dnp-commit-id": commitId },
      }),
      unlockedRes,
      () => {
        unlockedRes.json({ ok: true, data: "delivery output" });
      },
    );

    const unlockedBody = unlockedRes.body as {
      ok: boolean;
      data: string;
      receipt: SignedReceipt;
    };
    expect(unlockedBody.data).toBe("delivery output");
    expect(verifySignedReceipt(unlockedBody.receipt)).toBe(true);
    expect(unlockedBody.receipt.payload.requestDigest).toBe(computeRequestDigest({
      method: "GET",
      path: "/api/delivery",
    }));
    expect(unlockedBody.receipt.payload.responseDigest).toBe(computeResponseDigest({
      status: 200,
      body: {
        ok: true,
        data: "delivery output",
      },
    }));
    expect(unlockedRes.headers[RECEIPT_HEADER_NAME]).toBeTruthy();
  });

  it("emits a signed delivery receipt header on unlocked text responses", async () => {
    const app = express();
    const middleware = dnaPaywall({
      priceAtomic: "1000",
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      paymentVerifier: new FakeVerifier({
        ok: true,
        settledOnchain: true,
        txSignature: "tx-ok-paywall-text-12345678901234567890",
      }),
    });

    const firstRes = makeResponse() as Response & MockResponse;
    await invoke(middleware, makeRequest(app, { method: "GET", path: "/api/text" }), firstRes);
    const quoteId = (firstRes.body as {
      paymentRequirements: { quote: { quoteId: string } };
    }).paymentRequirements.quote.quoteId;

    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest(app, {
      method: "POST",
      path: "/commit",
      body: { quoteId, payerCommitment32B: "0x" + "56".repeat(32) },
    }), commitRes);
    const commitId = (commitRes.body as { commitId: string }).commitId;

    await invoke(routeHandler(app, "post", "/finalize"), makeRequest(app, {
      method: "POST",
      path: "/finalize",
      body: {
        commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-paywall-text-12345678901234567890",
        },
      },
    }), makeResponse());

    const unlockedRes = makeResponse() as Response & MockResponse;
    await invoke(
      middleware,
      makeRequest(app, {
        method: "GET",
        path: "/api/text",
        headers: { "x-dnp-commit-id": commitId },
      }),
      unlockedRes,
      () => {
        unlockedRes.send("plain paywall output");
      },
    );

    expect(unlockedRes.body).toBe("plain paywall output");
    expect(unlockedRes.headers[RECEIPT_HEADER_NAME]).toBeTruthy();
    const receipt = decodeReceiptHeader(unlockedRes.headers[RECEIPT_HEADER_NAME] as string);
    expect(verifySignedReceipt(receipt)).toBe(true);
    expect(receipt.payload.requestDigest).toBe(computeRequestDigest({
      method: "GET",
      path: "/api/text",
    }));
    expect(receipt.payload.responseDigest).toBe(computeResponseDigest({
      status: 200,
      body: "plain paywall output",
    }));
  });

  it("restores a paid commit after a 500 response and fires onPaymentVerified only after success", async () => {
    const app = express();
    const onPaymentVerified = vi.fn();
    const middleware = dnaPaywall({
      priceAtomic: "1000",
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      paymentVerifier: new FakeVerifier({
        ok: true,
        settledOnchain: true,
        txSignature: "tx-ok-paywall-retry-123456789012345678",
      }),
      onPaymentVerified,
    });

    const firstRes = makeResponse() as Response & MockResponse;
    await invoke(middleware, makeRequest(app, { method: "GET", path: "/api/retry" }), firstRes);
    const quoteId = (firstRes.body as {
      paymentRequirements: { quote: { quoteId: string } };
    }).paymentRequirements.quote.quoteId;

    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest(app, {
      method: "POST",
      path: "/commit",
      body: { quoteId, payerCommitment32B: "0x" + "77".repeat(32) },
    }), commitRes);
    const commitId = (commitRes.body as { commitId: string }).commitId;

    await invoke(routeHandler(app, "post", "/finalize"), makeRequest(app, {
      method: "POST",
      path: "/finalize",
      body: {
        commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-paywall-retry-123456789012345678",
        },
      },
    }), makeResponse());

    const failedRes = makeResponse() as Response & MockResponse;
    await invoke(
      middleware,
      makeRequest(app, {
        method: "GET",
        path: "/api/retry",
        headers: { "x-dnp-commit-id": commitId },
      }),
      failedRes,
      () => {
        failedRes.status(500).json({ error: "boom" });
      },
    );

    expect(onPaymentVerified).not.toHaveBeenCalled();

    const retryRes = makeResponse() as Response & MockResponse;
    await invoke(
      middleware,
      makeRequest(app, {
        method: "GET",
        path: "/api/retry",
        headers: { "x-dnp-commit-id": commitId },
      }),
      retryRes,
      () => {
        retryRes.json({ ok: true, data: "retry worked" });
      },
    );

    expect(onPaymentVerified).toHaveBeenCalledTimes(1);
    expect((retryRes.body as { receipt?: SignedReceipt }).receipt).toBeTruthy();
  });
});
