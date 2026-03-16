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
  ended = false;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(body: unknown): this {
    this.body = body;
    this.emit("finish");
    this.ended = true;
    return this;
  }

  send(body: unknown): this {
    this.body = body;
    this.emit("finish");
    this.ended = true;
    return this;
  }

  write(chunk: unknown): boolean {
    if (this.ended) {
      return false;
    }
    if (this.body === undefined) {
      this.body = chunk;
    } else if (Buffer.isBuffer(this.body) && Buffer.isBuffer(chunk)) {
      this.body = Buffer.concat([this.body, chunk]);
    } else {
      this.body = String(this.body) + String(chunk);
    }
    return true;
  }

  end(chunk?: unknown): this {
    if (chunk !== undefined) {
      this.write(chunk);
    }
    this.ended = true;
    this.emit("finish");
    return this;
  }

  redirect(location: string): this {
    if (this.ended) {
      return this;
    }
    this.statusCode = this.statusCode === 200 ? 302 : this.statusCode;
    this.body = { location };
    this.ended = true;
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

  it("emits a signed delivery receipt header on unlocked binary responses", async () => {
    const app = express();
    const middleware = dnaPaywall({
      priceAtomic: "1000",
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      paymentVerifier: new FakeVerifier({
        ok: true,
        settledOnchain: true,
        txSignature: "tx-ok-paywall-binary-12345678901234567890",
      }),
    });

    const firstRes = makeResponse() as Response & MockResponse;
    await invoke(middleware, makeRequest(app, { method: "GET", path: "/api/blob" }), firstRes);
    const quoteId = (firstRes.body as {
      paymentRequirements: { quote: { quoteId: string } };
    }).paymentRequirements.quote.quoteId;

    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest(app, {
      method: "POST",
      path: "/commit",
      body: { quoteId, payerCommitment32B: "0x" + "57".repeat(32) },
    }), commitRes);
    const commitId = (commitRes.body as { commitId: string }).commitId;

    await invoke(routeHandler(app, "post", "/finalize"), makeRequest(app, {
      method: "POST",
      path: "/finalize",
      body: {
        commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-paywall-binary-12345678901234567890",
        },
      },
    }), makeResponse());

    const payload = Buffer.from([9, 8, 7, 6, 5, 4]);
    const unlockedRes = makeResponse() as Response & MockResponse;
    await invoke(
      middleware,
      makeRequest(app, {
        method: "GET",
        path: "/api/blob",
        headers: { "x-dnp-commit-id": commitId },
      }),
      unlockedRes,
      () => {
        unlockedRes.send(payload);
      },
    );

    expect(unlockedRes.body).toEqual(payload);
    expect(unlockedRes.headers[RECEIPT_HEADER_NAME]).toBeTruthy();
    const receipt = decodeReceiptHeader(unlockedRes.headers[RECEIPT_HEADER_NAME] as string);
    expect(verifySignedReceipt(receipt)).toBe(true);
    expect(receipt.payload.responseDigest).toBe(computeResponseDigest({
      status: 200,
      body: payload,
    }));
  });

  it("emits a signed delivery receipt header on unlocked JSON array responses without mutating the body shape", async () => {
    const app = express();
    const middleware = dnaPaywall({
      priceAtomic: "1000",
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      paymentVerifier: new FakeVerifier({
        ok: true,
        settledOnchain: true,
        txSignature: "tx-ok-paywall-json-array-123456789012345",
      }),
    });

    const firstRes = makeResponse() as Response & MockResponse;
    await invoke(middleware, makeRequest(app, { method: "GET", path: "/api/list" }), firstRes);
    const quoteId = (firstRes.body as {
      paymentRequirements: { quote: { quoteId: string } };
    }).paymentRequirements.quote.quoteId;

    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest(app, {
      method: "POST",
      path: "/commit",
      body: { quoteId, payerCommitment32B: "0x" + "5b".repeat(32) },
    }), commitRes);
    const commitId = (commitRes.body as { commitId: string }).commitId;

    await invoke(routeHandler(app, "post", "/finalize"), makeRequest(app, {
      method: "POST",
      path: "/finalize",
      body: {
        commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-paywall-json-array-123456789012345",
        },
      },
    }), makeResponse());

    const payload = ["alpha", "beta"];
    const unlockedRes = makeResponse() as Response & MockResponse;
    await invoke(
      middleware,
      makeRequest(app, {
        method: "GET",
        path: "/api/list",
        headers: { "x-dnp-commit-id": commitId },
      }),
      unlockedRes,
      () => {
        unlockedRes.json(payload);
      },
    );

    expect(unlockedRes.body).toEqual(payload);
    expect(unlockedRes.headers[RECEIPT_HEADER_NAME]).toBeTruthy();
    const receipt = decodeReceiptHeader(unlockedRes.headers[RECEIPT_HEADER_NAME] as string);
    expect(verifySignedReceipt(receipt)).toBe(true);
    expect(receipt.payload.responseDigest).toBe(computeResponseDigest({
      status: 200,
      body: payload,
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

  it("fails closed on streamed protected responses and restores the paid commit", async () => {
    const app = express();
    const middleware = dnaPaywall({
      priceAtomic: "1000",
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      paymentVerifier: new FakeVerifier({
        ok: true,
        settledOnchain: true,
        txSignature: "tx-ok-paywall-stream-123456789012345678",
      }),
    });

    const firstRes = makeResponse() as Response & MockResponse;
    await invoke(middleware, makeRequest(app, { method: "GET", path: "/api/stream" }), firstRes);
    const quoteId = (firstRes.body as {
      paymentRequirements: { quote: { quoteId: string } };
    }).paymentRequirements.quote.quoteId;

    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest(app, {
      method: "POST",
      path: "/commit",
      body: { quoteId, payerCommitment32B: "0x" + "99".repeat(32) },
    }), commitRes);
    const commitId = (commitRes.body as { commitId: string }).commitId;

    await invoke(routeHandler(app, "post", "/finalize"), makeRequest(app, {
      method: "POST",
      path: "/finalize",
      body: {
        commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-paywall-stream-123456789012345678",
        },
      },
    }), makeResponse());

    const streamedRes = makeResponse() as Response & MockResponse;
    await invoke(
      middleware,
      makeRequest(app, {
        method: "GET",
        path: "/api/stream",
        headers: { "x-dnp-commit-id": commitId },
      }),
      streamedRes,
      () => {
        streamedRes.write("chunk-1");
        streamedRes.end("chunk-2");
      },
    );

    expect(streamedRes.statusCode).toBe(501);
    expect(streamedRes.body).toEqual({
      error: "unsupported_delivery_mode",
      message: "dnaPaywall protected responses must use res.json or res.send for verifiable delivery",
    });
    expect(streamedRes.headers[RECEIPT_HEADER_NAME]).toBeUndefined();
    const runtime = (app.locals as { __dnaPaywallRuntime?: { paidCommits: Set<string> } }).__dnaPaywallRuntime;
    expect(runtime?.paidCommits.has(commitId)).toBe(true);
  });

  it("fails closed on redirect-based protected responses and restores the paid commit", async () => {
    const app = express();
    const middleware = dnaPaywall({
      priceAtomic: "1000",
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      paymentVerifier: new FakeVerifier({
        ok: true,
        settledOnchain: true,
        txSignature: "tx-ok-paywall-redirect-12345678901234567",
      }),
    });

    const firstRes = makeResponse() as Response & MockResponse;
    await invoke(middleware, makeRequest(app, { method: "GET", path: "/api/redirect" }), firstRes);
    const quoteId = (firstRes.body as {
      paymentRequirements: { quote: { quoteId: string } };
    }).paymentRequirements.quote.quoteId;

    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest(app, {
      method: "POST",
      path: "/commit",
      body: { quoteId, payerCommitment32B: "0x" + "bb".repeat(32) },
    }), commitRes);
    const commitId = (commitRes.body as { commitId: string }).commitId;

    await invoke(routeHandler(app, "post", "/finalize"), makeRequest(app, {
      method: "POST",
      path: "/finalize",
      body: {
        commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-paywall-redirect-12345678901234567",
        },
      },
    }), makeResponse());

    const redirectRes = makeResponse() as Response & MockResponse;
    await invoke(
      middleware,
      makeRequest(app, {
        method: "GET",
        path: "/api/redirect",
        headers: { "x-dnp-commit-id": commitId },
      }),
      redirectRes,
      () => {
        redirectRes.redirect("https://example.test/private");
      },
    );

    expect(redirectRes.statusCode).toBe(501);
    expect(redirectRes.body).toEqual({
      error: "unsupported_delivery_mode",
      message: "dnaPaywall protected responses must use res.json or res.send for verifiable delivery",
    });
    expect(redirectRes.headers[RECEIPT_HEADER_NAME]).toBeUndefined();
    const runtime = (app.locals as { __dnaPaywallRuntime?: { paidCommits: Set<string> } }).__dnaPaywallRuntime;
    expect(runtime?.paidCommits.has(commitId)).toBe(true);
  });

  it("restores a paid commit after a 4xx protected response and does not fire onPaymentVerified", async () => {
    const app = express();
    const onPaymentVerified = vi.fn();
    const middleware = dnaPaywall({
      priceAtomic: "1000",
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      paymentVerifier: new FakeVerifier({
        ok: true,
        settledOnchain: true,
        txSignature: "tx-ok-paywall-4xx-1234567890123456789012",
      }),
      onPaymentVerified,
    });

    const firstRes = makeResponse() as Response & MockResponse;
    await invoke(middleware, makeRequest(app, { method: "GET", path: "/api/retry-4xx" }), firstRes);
    const quoteId = (firstRes.body as {
      paymentRequirements: { quote: { quoteId: string } };
    }).paymentRequirements.quote.quoteId;

    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest(app, {
      method: "POST",
      path: "/commit",
      body: { quoteId, payerCommitment32B: "0x" + "ac".repeat(32) },
    }), commitRes);
    const commitId = (commitRes.body as { commitId: string }).commitId;

    await invoke(routeHandler(app, "post", "/finalize"), makeRequest(app, {
      method: "POST",
      path: "/finalize",
      body: {
        commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-paywall-4xx-1234567890123456789012",
        },
      },
    }), makeResponse());

    const failedRes = makeResponse() as Response & MockResponse;
    await invoke(
      middleware,
      makeRequest(app, {
        method: "GET",
        path: "/api/retry-4xx",
        headers: { "x-dnp-commit-id": commitId },
      }),
      failedRes,
      () => {
        failedRes.status(422).json({ error: "invalid_input" });
      },
    );

    expect(onPaymentVerified).not.toHaveBeenCalled();
    const runtime = (app.locals as { __dnaPaywallRuntime?: { paidCommits: Set<string> } }).__dnaPaywallRuntime;
    expect(runtime?.paidCommits.has(commitId)).toBe(true);
    expect((failedRes.body as { receipt?: unknown }).receipt).toBeUndefined();
  });

  it("does not unlock a different paywalled route with a finalized commit from another resource", async () => {
    const app = express();
    const middleware = dnaPaywall({
      priceAtomic: "1000",
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      paymentVerifier: new FakeVerifier({
        ok: true,
        settledOnchain: true,
        txSignature: "tx-ok-paywall-resource-bind-1234567890123",
      }),
    });

    const firstRes = makeResponse() as Response & MockResponse;
    await invoke(middleware, makeRequest(app, { method: "GET", path: "/api/alpha" }), firstRes);
    const quoteId = (firstRes.body as {
      paymentRequirements: { quote: { quoteId: string } };
    }).paymentRequirements.quote.quoteId;

    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest(app, {
      method: "POST",
      path: "/commit",
      body: { quoteId, payerCommitment32B: "0x" + "dd".repeat(32) },
    }), commitRes);
    const commitId = (commitRes.body as { commitId: string }).commitId;

    await invoke(routeHandler(app, "post", "/finalize"), makeRequest(app, {
      method: "POST",
      path: "/finalize",
      body: {
        commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-paywall-resource-bind-1234567890123",
        },
      },
    }), makeResponse());

    const wrongRouteRes = makeResponse() as Response & MockResponse;
    await invoke(
      middleware,
      makeRequest(app, {
        method: "GET",
        path: "/api/beta",
        headers: { "x-dnp-commit-id": commitId },
      }),
      wrongRouteRes,
    );

    expect(wrongRouteRes.statusCode).toBe(402);
    expect((wrongRouteRes.body as { error: string }).error).toBe("payment_required");
    const runtime = (app.locals as { __dnaPaywallRuntime?: { paidCommits: Set<string> } }).__dnaPaywallRuntime;
    expect(runtime?.paidCommits.has(commitId)).toBe(true);

    const correctRouteRes = makeResponse() as Response & MockResponse;
    await invoke(
      middleware,
      makeRequest(app, {
        method: "GET",
        path: "/api/alpha",
        headers: { "x-dnp-commit-id": commitId },
      }),
      correctRouteRes,
      () => {
        correctRouteRes.json({ ok: true, route: "alpha" });
      },
    );

    expect(correctRouteRes.statusCode).toBe(200);
    expect((correctRouteRes.body as { receipt?: SignedReceipt }).receipt).toBeTruthy();
    expect(runtime?.paidCommits.has(commitId)).toBe(false);
  });
});
