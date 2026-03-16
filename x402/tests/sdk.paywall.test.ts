import { EventEmitter } from "node:events";
import express, { type Request, type RequestHandler, type Response } from "express";
import { describe, expect, it, vi } from "vitest";
import type { PaymentVerifier } from "../src/paymentVerifier.js";
import { verifySignedReceipt } from "../src/receipts.js";
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
      },
    });
    expect(verifySignedReceipt(receiptRes.body as Parameters<typeof verifySignedReceipt>[0])).toBe(true);

    let nextCalled = false;
    await invoke(
      middleware,
      makeRequest(app, {
        method: "GET",
        path: "/api/cheap",
        headers: { "x-dnp-commit-id": commitId },
      }),
      makeResponse(),
      () => {
        nextCalled = true;
      },
    );

    expect(nextCalled).toBe(true);
    expect(onPaymentVerified).toHaveBeenCalledTimes(1);
  });
});
