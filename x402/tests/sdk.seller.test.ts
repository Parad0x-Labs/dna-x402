import { EventEmitter } from "node:events";
import express, { type Request, type RequestHandler, type Response } from "express";
import { describe, expect, it } from "vitest";
import type { PaymentVerifier } from "../src/paymentVerifier.js";
import {
  computeRequestDigest,
  computeResponseDigest,
  decodeReceiptHeader,
  RECEIPT_HEADER_NAME,
  verifySignedReceipt,
} from "../src/receipts.js";
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

function makeRequest(input: {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  params?: Record<string, string>;
  path?: string;
  originalUrl?: string;
} = {}): Request {
  const headers = Object.fromEntries(
    Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    body: input.body,
    method: input.method ?? "GET",
    params: input.params ?? {},
    path: input.path ?? "/",
    originalUrl: input.originalUrl ?? input.path ?? "/",
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

  it("verifies stream proofs through a configured streamflow client and preserves streamId in receipts", async () => {
    const app = express();
    const seller = dnaSeller(app, {
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      network: "solana-devnet",
      settlement: ["stream"],
      streamflowClient: {
        async getOne() {
          return {
            recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
            mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
            depositedAmount: { toString: () => "9000" } as any,
            withdrawnAmount: { toString: () => "1000" } as any,
            closed: false,
          };
        },
      },
    });

    const quote = seller.createQuote("/api/stream-quote", "5000", "https://example.test");

    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest({
      method: "POST",
      path: "/commit",
      body: { quoteId: quote.quoteId, payerCommitment32B: "0x" + "12".repeat(32) },
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
          settlement: "stream",
          streamId: "stream-seller-verified-1234567890",
          amountAtomic: "8000",
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
        settlement: "stream",
        settledOnchain: true,
        streamId: "stream-seller-verified-1234567890",
      },
    });
    expect(verifySignedReceipt(receiptRes.body as Parameters<typeof verifySignedReceipt>[0])).toBe(true);

    const unlockedRes = makeResponse() as Response & MockResponse;
    await invoke(
      dnaPrice("5000", seller),
      makeRequest({
        method: "GET",
        path: "/api/stream-quote",
        headers: { "x-dnp-commit-id": commitId },
      }),
      unlockedRes,
      () => {
        unlockedRes.json({ ok: true, mode: "stream" });
      },
    );

    const unlockedBody = unlockedRes.body as { ok: boolean; mode: string; receipt: Parameters<typeof verifySignedReceipt>[0] };
    expect(unlockedBody.mode).toBe("stream");
    expect(unlockedBody.receipt.payload.streamId).toBe("stream-seller-verified-1234567890");
    expect(verifySignedReceipt(unlockedBody.receipt)).toBe(true);
  });

  it("rejects a transfer verification result that omits the canonical txSignature", async () => {
    const app = express();
    const seller = dnaSeller(app, {
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      paymentVerifier: {
        async verify() {
          return { ok: true, settledOnchain: true } as const;
        },
      },
    });

    const quote = seller.createQuote("/api/transfer-missing-sig", "5000", "https://example.test");

    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest({
      method: "POST",
      path: "/commit",
      body: { quoteId: quote.quoteId, payerCommitment32B: "0x" + "15".repeat(32) },
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
          txSignature: "tx-seller-missing-sig-12345678901234567890",
        },
      },
    }), finalizeRes);

    expect(finalizeRes.statusCode).toBe(422);
    expect(finalizeRes.body).toMatchObject({
      ok: false,
      error: {
        code: "PAYMENT_INVALID",
        message: "Verified transfer settlement is missing canonical txSignature",
        retryable: false,
      },
    });
  });

  it("rejects reusing the same stream proof across different commits", async () => {
    const app = express();
    const seller = dnaSeller(app, {
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      settlement: ["stream"],
      streamflowClient: {
        async getOne() {
          return {
            recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
            mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
            depositedAmount: { toString: () => "9000" } as any,
            withdrawnAmount: { toString: () => "0" } as any,
            closed: false,
          };
        },
      },
    });

    const firstQuote = seller.createQuote("/api/stream-a", "5000", "https://example.test");
    const secondQuote = seller.createQuote("/api/stream-b", "5000", "https://example.test");

    const firstCommitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest({
      method: "POST",
      path: "/commit",
      body: { quoteId: firstQuote.quoteId, payerCommitment32B: "0x" + "13".repeat(32) },
    }), firstCommitRes);
    const firstCommitId = (firstCommitRes.body as { commitId: string }).commitId;

    const secondCommitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest({
      method: "POST",
      path: "/commit",
      body: { quoteId: secondQuote.quoteId, payerCommitment32B: "0x" + "14".repeat(32) },
    }), secondCommitRes);
    const secondCommitId = (secondCommitRes.body as { commitId: string }).commitId;

    await invoke(routeHandler(app, "post", "/finalize"), makeRequest({
      method: "POST",
      path: "/finalize",
      body: {
        commitId: firstCommitId,
        paymentProof: {
          settlement: "stream",
          streamId: "stream-seller-replay-1234567890",
          amountAtomic: "9000",
        },
      },
    }), makeResponse());

    const replayRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/finalize"), makeRequest({
      method: "POST",
      path: "/finalize",
      body: {
        commitId: secondCommitId,
        paymentProof: {
          settlement: "stream",
          streamId: "stream-seller-replay-1234567890",
          amountAtomic: "9000",
        },
      },
    }), replayRes);

    expect(replayRes.statusCode).toBe(409);
    expect(replayRes.body).toMatchObject({
      error: "Stream proof already used",
      commitId: firstCommitId,
    });
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
    expect(unlockedRes.headers[RECEIPT_HEADER_NAME]).toBeTruthy();
  });

  it("emits a signed delivery receipt header on unlocked text responses", async () => {
    const app = express();
    const seller = dnaSeller(app, {
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      paymentVerifier: new FakeVerifier({
        ok: true,
        settledOnchain: true,
        txSignature: "tx-ok-seller-text-12345678901234567890",
      }),
    });

    const quote = seller.createQuote("/api/text", "5000", "https://example.test");
    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest({
      method: "POST",
      path: "/commit",
      body: { quoteId: quote.quoteId, payerCommitment32B: "0x" + "88".repeat(32) },
    }), commitRes);
    const commitId = (commitRes.body as { commitId: string }).commitId;

    await invoke(routeHandler(app, "post", "/finalize"), makeRequest({
      method: "POST",
      path: "/finalize",
      body: {
        commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-seller-text-12345678901234567890",
        },
      },
    }), makeResponse());

    const unlockedRes = makeResponse() as Response & MockResponse;
    await invoke(
      dnaPrice("5000", seller),
      makeRequest({
        method: "GET",
        path: "/api/text",
        headers: { "x-dnp-commit-id": commitId },
      }),
      unlockedRes,
      () => {
        unlockedRes.send("plain premium output");
      },
    );

    expect(unlockedRes.body).toBe("plain premium output");
    expect(unlockedRes.headers[RECEIPT_HEADER_NAME]).toBeTruthy();
    const receipt = decodeReceiptHeader(unlockedRes.headers[RECEIPT_HEADER_NAME] as string);
    expect(verifySignedReceipt(receipt)).toBe(true);
    expect(receipt.payload.requestDigest).toBe(computeRequestDigest({
      method: "GET",
      path: "/api/text",
    }));
    expect(receipt.payload.responseDigest).toBe(computeResponseDigest({
      status: 200,
      body: "plain premium output",
    }));
  });

  it("emits a signed delivery receipt header on unlocked binary responses", async () => {
    const app = express();
    const seller = dnaSeller(app, {
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      paymentVerifier: new FakeVerifier({
        ok: true,
        settledOnchain: true,
        txSignature: "tx-ok-seller-binary-12345678901234567890",
      }),
    });

    const quote = seller.createQuote("/api/blob", "5000", "https://example.test");
    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest({
      method: "POST",
      path: "/commit",
      body: { quoteId: quote.quoteId, payerCommitment32B: "0x" + "99".repeat(32) },
    }), commitRes);
    const commitId = (commitRes.body as { commitId: string }).commitId;

    await invoke(routeHandler(app, "post", "/finalize"), makeRequest({
      method: "POST",
      path: "/finalize",
      body: {
        commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-seller-binary-12345678901234567890",
        },
      },
    }), makeResponse());

    const payload = Buffer.from([1, 2, 3, 4, 5, 6]);
    const unlockedRes = makeResponse() as Response & MockResponse;
    await invoke(
      dnaPrice("5000", seller),
      makeRequest({
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
    const seller = dnaSeller(app, {
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      paymentVerifier: new FakeVerifier({
        ok: true,
        settledOnchain: true,
        txSignature: "tx-ok-seller-json-array-1234567890123456",
      }),
    });

    const quote = seller.createQuote("/api/list", "5000", "https://example.test");
    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest({
      method: "POST",
      path: "/commit",
      body: { quoteId: quote.quoteId, payerCommitment32B: "0x" + "5a".repeat(32) },
    }), commitRes);
    const commitId = (commitRes.body as { commitId: string }).commitId;

    await invoke(routeHandler(app, "post", "/finalize"), makeRequest({
      method: "POST",
      path: "/finalize",
      body: {
        commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-seller-json-array-1234567890123456",
        },
      },
    }), makeResponse());

    const payload = ["alpha", "beta"];
    const unlockedRes = makeResponse() as Response & MockResponse;
    await invoke(
      dnaPrice("5000", seller),
      makeRequest({
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

  it("fails closed on streamed protected responses and restores the paid commit", async () => {
    const app = express();
    const seller = dnaSeller(app, {
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      paymentVerifier: new FakeVerifier({
        ok: true,
        settledOnchain: true,
        txSignature: "tx-ok-seller-stream-12345678901234567890",
      }),
    });

    const quote = seller.createQuote("/api/stream", "5000", "https://example.test");
    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest({
      method: "POST",
      path: "/commit",
      body: { quoteId: quote.quoteId, payerCommitment32B: "0x" + "88".repeat(32) },
    }), commitRes);
    const commitId = (commitRes.body as { commitId: string }).commitId;

    await invoke(routeHandler(app, "post", "/finalize"), makeRequest({
      method: "POST",
      path: "/finalize",
      body: {
        commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-seller-stream-12345678901234567890",
        },
      },
    }), makeResponse());

    const streamedRes = makeResponse() as Response & MockResponse;
    await invoke(
      dnaPrice("5000", seller),
      makeRequest({
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
      message: "dnaPrice protected responses must use res.json or res.send for verifiable delivery",
    });
    expect(streamedRes.headers[RECEIPT_HEADER_NAME]).toBeUndefined();
    expect(seller.paidCommits.has(commitId)).toBe(true);
  });

  it("fails closed on redirect-based protected responses and restores the paid commit", async () => {
    const app = express();
    const seller = dnaSeller(app, {
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      paymentVerifier: new FakeVerifier({
        ok: true,
        settledOnchain: true,
        txSignature: "tx-ok-seller-redirect-123456789012345678",
      }),
    });

    const quote = seller.createQuote("/api/redirect", "5000", "https://example.test");
    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest({
      method: "POST",
      path: "/commit",
      body: { quoteId: quote.quoteId, payerCommitment32B: "0x" + "aa".repeat(32) },
    }), commitRes);
    const commitId = (commitRes.body as { commitId: string }).commitId;

    await invoke(routeHandler(app, "post", "/finalize"), makeRequest({
      method: "POST",
      path: "/finalize",
      body: {
        commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-seller-redirect-123456789012345678",
        },
      },
    }), makeResponse());

    const redirectRes = makeResponse() as Response & MockResponse;
    await invoke(
      dnaPrice("5000", seller),
      makeRequest({
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
      message: "dnaPrice protected responses must use res.json or res.send for verifiable delivery",
    });
    expect(redirectRes.headers[RECEIPT_HEADER_NAME]).toBeUndefined();
    expect(seller.paidCommits.has(commitId)).toBe(true);
  });

  it("restores a paid commit after a 4xx protected response", async () => {
    const app = express();
    const seller = dnaSeller(app, {
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      paymentVerifier: new FakeVerifier({
        ok: true,
        settledOnchain: true,
        txSignature: "tx-ok-seller-4xx-123456789012345678901234",
      }),
    });

    const quote = seller.createQuote("/api/retry-4xx", "5000", "https://example.test");
    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest({
      method: "POST",
      path: "/commit",
      body: { quoteId: quote.quoteId, payerCommitment32B: "0x" + "ab".repeat(32) },
    }), commitRes);
    const commitId = (commitRes.body as { commitId: string }).commitId;

    await invoke(routeHandler(app, "post", "/finalize"), makeRequest({
      method: "POST",
      path: "/finalize",
      body: {
        commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-seller-4xx-123456789012345678901234",
        },
      },
    }), makeResponse());

    const failedRes = makeResponse() as Response & MockResponse;
    await invoke(
      dnaPrice("5000", seller),
      makeRequest({
        method: "GET",
        path: "/api/retry-4xx",
        headers: { "x-dnp-commit-id": commitId },
      }),
      failedRes,
      () => {
        failedRes.status(422).json({ error: "invalid_input" });
      },
    );

    expect(seller.paidCommits.has(commitId)).toBe(true);
    expect((failedRes.body as { receipt?: unknown }).receipt).toBeUndefined();
  });

  it("does not unlock a different priced route with a finalized commit from another resource", async () => {
    const app = express();
    const seller = dnaSeller(app, {
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      paymentVerifier: new FakeVerifier({
        ok: true,
        settledOnchain: true,
        txSignature: "tx-ok-seller-resource-bind-12345678901234",
      }),
    });

    const quote = seller.createQuote("/api/alpha", "5000", "https://example.test");
    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest({
      method: "POST",
      path: "/commit",
      body: { quoteId: quote.quoteId, payerCommitment32B: "0x" + "cc".repeat(32) },
    }), commitRes);
    const commitId = (commitRes.body as { commitId: string }).commitId;

    await invoke(routeHandler(app, "post", "/finalize"), makeRequest({
      method: "POST",
      path: "/finalize",
      body: {
        commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-seller-resource-bind-12345678901234",
        },
      },
    }), makeResponse());

    const wrongRouteRes = makeResponse() as Response & MockResponse;
    await invoke(
      dnaPrice("5000", seller),
      makeRequest({
        method: "GET",
        path: "/api/beta",
        headers: { "x-dnp-commit-id": commitId },
      }),
      wrongRouteRes,
    );

    expect(wrongRouteRes.statusCode).toBe(402);
    expect((wrongRouteRes.body as { error: string }).error).toBe("payment_required");
    expect(seller.paidCommits.has(commitId)).toBe(true);

    const correctRouteRes = makeResponse() as Response & MockResponse;
    await invoke(
      dnaPrice("5000", seller),
      makeRequest({
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
    expect(seller.paidCommits.has(commitId)).toBe(false);
  });

  it("does not unlock the same path with a different query string", async () => {
    const app = express();
    const seller = dnaSeller(app, {
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      paymentVerifier: new FakeVerifier({
        ok: true,
        settledOnchain: true,
        txSignature: "tx-ok-seller-query-bind-1234567890123456",
      }),
    });

    const firstQuoteRes = makeResponse() as Response & MockResponse;
    await invoke(
      dnaPrice("5000", seller),
      makeRequest({
        method: "GET",
        path: "/api/search",
        originalUrl: "/api/search?q=alpha",
      }),
      firstQuoteRes,
    );
    const quoteId = (firstQuoteRes.body as {
      paymentRequirements: { quote: { quoteId: string } };
    }).paymentRequirements.quote.quoteId;

    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest({
      method: "POST",
      path: "/commit",
      body: { quoteId, payerCommitment32B: "0x" + "ce".repeat(32) },
    }), commitRes);
    const commitId = (commitRes.body as { commitId: string }).commitId;

    await invoke(routeHandler(app, "post", "/finalize"), makeRequest({
      method: "POST",
      path: "/finalize",
      body: {
        commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-seller-query-bind-1234567890123456",
        },
      },
    }), makeResponse());

    const wrongQueryRes = makeResponse() as Response & MockResponse;
    await invoke(
      dnaPrice("5000", seller),
      makeRequest({
        method: "GET",
        path: "/api/search",
        originalUrl: "/api/search?q=beta",
        headers: { "x-dnp-commit-id": commitId },
      }),
      wrongQueryRes,
    );

    expect(wrongQueryRes.statusCode).toBe(402);
    expect((wrongQueryRes.body as { error: string }).error).toBe("payment_required");
    expect(seller.paidCommits.has(commitId)).toBe(true);

    const correctQueryRes = makeResponse() as Response & MockResponse;
    await invoke(
      dnaPrice("5000", seller),
      makeRequest({
        method: "GET",
        path: "/api/search",
        originalUrl: "/api/search?q=alpha",
        headers: { "x-dnp-commit-id": commitId },
      }),
      correctQueryRes,
      () => {
        correctQueryRes.json({ ok: true, query: "alpha" });
      },
    );

    expect(correctQueryRes.statusCode).toBe(200);
    expect((correctQueryRes.body as { receipt?: SignedReceipt }).receipt).toBeTruthy();
    expect(seller.paidCommits.has(commitId)).toBe(false);
  });

  it("does not unlock the same path with a different HTTP method", async () => {
    const app = express();
    const seller = dnaSeller(app, {
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      paymentVerifier: new FakeVerifier({
        ok: true,
        settledOnchain: true,
        txSignature: "tx-ok-seller-method-bind-123456789012345",
      }),
    });

    const firstQuoteRes = makeResponse() as Response & MockResponse;
    await invoke(
      dnaPrice("5000", seller),
      makeRequest({
        method: "GET",
        path: "/api/method-bound",
      }),
      firstQuoteRes,
    );
    const quoteId = (firstQuoteRes.body as {
      paymentRequirements: { quote: { quoteId: string } };
    }).paymentRequirements.quote.quoteId;

    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest({
      method: "POST",
      path: "/commit",
      body: { quoteId, payerCommitment32B: "0x" + "cd".repeat(32) },
    }), commitRes);
    const commitId = (commitRes.body as { commitId: string }).commitId;

    await invoke(routeHandler(app, "post", "/finalize"), makeRequest({
      method: "POST",
      path: "/finalize",
      body: {
        commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-seller-method-bind-123456789012345",
        },
      },
    }), makeResponse());

    const wrongMethodRes = makeResponse() as Response & MockResponse;
    await invoke(
      dnaPrice("5000", seller),
      makeRequest({
        method: "POST",
        path: "/api/method-bound",
        headers: { "x-dnp-commit-id": commitId },
      }),
      wrongMethodRes,
    );

    expect(wrongMethodRes.statusCode).toBe(402);
    expect((wrongMethodRes.body as { error: string }).error).toBe("payment_required");
    expect(seller.paidCommits.has(commitId)).toBe(true);

    const correctMethodRes = makeResponse() as Response & MockResponse;
    await invoke(
      dnaPrice("5000", seller),
      makeRequest({
        method: "GET",
        path: "/api/method-bound",
        headers: { "x-dnp-commit-id": commitId },
      }),
      correctMethodRes,
      () => {
        correctMethodRes.json({ ok: true, method: "GET" });
      },
    );

    expect(correctMethodRes.statusCode).toBe(200);
    expect((correctMethodRes.body as { receipt?: SignedReceipt }).receipt).toBeTruthy();
    expect(seller.paidCommits.has(commitId)).toBe(false);
  });

  it("rejects reusing the same transfer proof across different commits", async () => {
    const app = express();
    const seller = dnaSeller(app, {
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      paymentVerifier: new FakeVerifier({
        ok: true,
        settledOnchain: true,
        txSignature: "tx-ok-seller-proof-reuse-12345678901234",
      }),
    });

    const firstQuote = seller.createQuote("/api/reuse-a", "5000", "https://example.test");
    const secondQuote = seller.createQuote("/api/reuse-b", "5000", "https://example.test");

    const firstCommitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest({
      method: "POST",
      path: "/commit",
      body: { quoteId: firstQuote.quoteId, payerCommitment32B: "0x" + "d1".repeat(32) },
    }), firstCommitRes);
    const firstCommitId = (firstCommitRes.body as { commitId: string }).commitId;

    const secondCommitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest({
      method: "POST",
      path: "/commit",
      body: { quoteId: secondQuote.quoteId, payerCommitment32B: "0x" + "d2".repeat(32) },
    }), secondCommitRes);
    const secondCommitId = (secondCommitRes.body as { commitId: string }).commitId;

    await invoke(routeHandler(app, "post", "/finalize"), makeRequest({
      method: "POST",
      path: "/finalize",
      body: {
        commitId: firstCommitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-seller-proof-reuse-12345678901234",
        },
      },
    }), makeResponse());

    const duplicateFinalizeRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/finalize"), makeRequest({
      method: "POST",
      path: "/finalize",
      body: {
        commitId: secondCommitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-seller-proof-reuse-12345678901234",
        },
      },
    }), duplicateFinalizeRes);

    expect(duplicateFinalizeRes.statusCode).toBe(409);
    expect(duplicateFinalizeRes.body).toEqual({
      error: "Transfer proof already used",
      commitId: firstCommitId,
    });
    expect(seller.commits.get(secondCommitId)?.finalized).toBe(false);
  });
});
