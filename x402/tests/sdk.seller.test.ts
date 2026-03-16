import { EventEmitter } from "node:events";
import express, { type Request, type RequestHandler, type Response } from "express";
import { describe, expect, it } from "vitest";
import type { PaymentVerifier } from "../src/paymentVerifier.js";
import type { PaymentProof, Quote } from "../src/types.js";
import { dnaSeller } from "../src/sdk/seller.js";

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

async function invoke(handler: RequestHandler, req: Request, res: Response): Promise<void> {
  await Promise.resolve(handler(req, res, () => undefined));
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
      },
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
});
