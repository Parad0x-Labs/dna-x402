import { EventEmitter } from "node:events";
import type { Express, Request, RequestHandler, Response, Router } from "express";
import { describe, expect, it } from "vitest";
import { X402Config } from "../src/config.js";
import { PaymentVerifier } from "../src/paymentVerifier.js";
import {
  computeRequestDigest,
  computeResponseDigest,
  ReceiptSigner,
  verifySignedReceipt,
} from "../src/receipts.js";
import { createX402App } from "../src/server.js";
import { PaymentProof, Quote, SignedReceipt } from "../src/types.js";

class FakeVerifier implements PaymentVerifier {
  async verify(_quote: Quote, paymentProof: PaymentProof) {
    if (paymentProof.settlement === "transfer") {
      return { ok: true, settledOnchain: true, txSignature: paymentProof.txSignature };
    }
    return { ok: true, settledOnchain: false };
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

function baseConfig(): X402Config {
  return {
    port: 8080,
    appVersion: "test",
    solanaRpcUrl: "https://api.devnet.solana.com",
    usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    paymentRecipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
    defaultCurrency: "USDC",
    enabledPricingModels: ["flat", "surge", "stream"],
    marketplaceSelection: "cheapest_sla_else_limit_order",
    quoteTtlSeconds: 120,
    feePolicy: {
      baseFeeAtomic: 0n,
      feeBps: 0,
      minFeeAtomic: 0n,
      accrueThresholdAtomic: 100n,
      minSettleAtomic: 0n,
    },
    nettingThresholdAtomic: 10_000n,
    nettingIntervalMs: 10_000,
    pauseMarket: false,
    pauseFinalize: false,
    pauseOrders: false,
    disabledShops: [],
    autoDisableReportThreshold: 0,
  };
}

function makeRequest(input: {
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
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
    query: input.query ?? {},
    traceId: "trace-server-receipt",
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
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

function routeHandler(container: Express | Router, method: "get" | "post", pathName: string): RequestHandler {
  const stack = (container as Express & {
    _router?: { stack: Array<any> };
    stack?: Array<any>;
  })._router?.stack ?? (container as Router & { stack?: Array<any> }).stack ?? [];
  const layer = stack.find((entry) => entry.route?.path === pathName && entry.route.methods?.[method]);
  if (!layer?.route?.stack?.[0]?.handle) {
    throw new Error(`Route not found: ${method.toUpperCase()} ${pathName}`);
  }
  return layer.route.stack[0].handle as RequestHandler;
}

function expectResponseDigest(receipt: SignedReceipt, body: Record<string, unknown>): void {
  expect(receipt.payload.responseDigest).toBe(computeResponseDigest({ status: 200, body }));
  expect(verifySignedReceipt(receipt)).toBe(true);
}

function expectRequestDigest(receipt: SignedReceipt, path: string): void {
  expect(receipt.payload.requestDigest).toBe(computeRequestDigest({
    method: "GET",
    path,
  }));
}

describe("server receipt response binding", () => {
  it("binds /resource receipts to the unlocked protected payload", async () => {
    const { app, context } = createX402App(baseConfig(), {
      paymentVerifier: new FakeVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    });

    const quoteRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "get", "/quote"), makeRequest({
      method: "GET",
      path: "/quote",
      query: { resource: "/resource" },
    }), quoteRes);
    expect(quoteRes.statusCode).toBe(200);
    const quoteId = (quoteRes.body as { quoteId: string }).quoteId;

    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest({
      method: "POST",
      path: "/commit",
      body: {
        quoteId,
        payerCommitment32B: "0x" + "44".repeat(32),
      },
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
          txSignature: "tx-ok-server-receipt-12345678901234567890",
        },
      },
    }), finalizeRes);
    expect(finalizeRes.statusCode).toBe(200);
    const receiptId = (finalizeRes.body as { receiptId: string }).receiptId;
    const receipt = context.receipts.get(receiptId);
    expect(receipt).toBeTruthy();

    const protectedBody = { ok: true, data: "resource payload" };
    expectRequestDigest(receipt as SignedReceipt, "/resource");
    expectResponseDigest(receipt as SignedReceipt, protectedBody);

    const resourceRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "get", "/resource"), makeRequest({
      method: "GET",
      path: "/resource",
      headers: { "x-dnp-commit-id": commitId },
    }), resourceRes);
    expect(resourceRes.statusCode).toBe(200);
    const delivered = resourceRes.body as Record<string, unknown> & { receipt: SignedReceipt };
    const { receipt: deliveredReceipt, ...businessBody } = delivered;
    expect(deliveredReceipt.payload.receiptId).toBe(receiptId);
    expectResponseDigest(deliveredReceipt, businessBody);
  });

  it("consumes finalized commits after one protected delivery", async () => {
    const { app, context } = createX402App(baseConfig(), {
      paymentVerifier: new FakeVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    });

    const quoteRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "get", "/quote"), makeRequest({
      method: "GET",
      path: "/quote",
      query: { resource: "/resource" },
    }), quoteRes);
    const quoteId = (quoteRes.body as { quoteId: string }).quoteId;

    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest({
      method: "POST",
      path: "/commit",
      body: {
        quoteId,
        payerCommitment32B: "0x" + "77".repeat(32),
      },
    }), commitRes);
    const commitId = (commitRes.body as { commitId: string }).commitId;

    await invoke(routeHandler(app, "post", "/finalize"), makeRequest({
      method: "POST",
      path: "/finalize",
      body: {
        commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-server-receipt-consume-1234567890123",
        },
      },
    }), makeResponse());

    const firstDelivery = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "get", "/resource"), makeRequest({
      method: "GET",
      path: "/resource",
      headers: { "x-dnp-commit-id": commitId },
    }), firstDelivery);
    expect(firstDelivery.statusCode).toBe(200);
    expect(context.commits.get(commitId)?.consumedAt).toBeTruthy();

    const secondDelivery = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "get", "/resource"), makeRequest({
      method: "GET",
      path: "/resource",
      headers: { "x-dnp-commit-id": commitId },
    }), secondDelivery);
    expect(secondDelivery.statusCode).toBe(402);
    expect(secondDelivery.body).toMatchObject({ error: "payment_required" });
  });

  it("binds /inference receipts to the unlocked protected payload", async () => {
    const { app, context } = createX402App(baseConfig(), {
      paymentVerifier: new FakeVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    });

    const quoteRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "get", "/quote"), makeRequest({
      method: "GET",
      path: "/quote",
      query: { resource: "/inference" },
    }), quoteRes);
    expect(quoteRes.statusCode).toBe(200);
    const quoteId = (quoteRes.body as { quoteId: string }).quoteId;

    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest({
      method: "POST",
      path: "/commit",
      body: {
        quoteId,
        payerCommitment32B: "0x" + "55".repeat(32),
      },
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
          txSignature: "tx-ok-server-receipt-inference-1234567890",
        },
      },
    }), finalizeRes);
    expect(finalizeRes.statusCode).toBe(200);
    const receiptId = (finalizeRes.body as { receiptId: string }).receiptId;
    const receipt = context.receipts.get(receiptId);
    expect(receipt).toBeTruthy();

    const protectedBody = { ok: true, output: "inference result" };
    expectRequestDigest(receipt as SignedReceipt, "/inference");
    expectResponseDigest(receipt as SignedReceipt, protectedBody);

    const inferenceRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "get", "/inference"), makeRequest({
      method: "GET",
      path: "/inference",
      headers: { "x-dnp-commit-id": commitId },
    }), inferenceRes);
    expect(inferenceRes.statusCode).toBe(200);
    const delivered = inferenceRes.body as Record<string, unknown> & { receipt: SignedReceipt };
    const { receipt: deliveredReceipt, ...businessBody } = delivered;
    expect(deliveredReceipt.payload.receiptId).toBe(receiptId);
    expectResponseDigest(deliveredReceipt, businessBody);
  });

  it("binds audit fixture receipts to the canonical fixture payload", async () => {
    const { app, context } = createX402App(baseConfig(), {
      paymentVerifier: new FakeVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    });

    const resource = "/audit/primitives/fixed-price";
    const quoteRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "get", "/quote"), makeRequest({
      method: "GET",
      path: "/quote",
      query: { resource },
    }), quoteRes);
    expect(quoteRes.statusCode).toBe(200);
    const quoteId = (quoteRes.body as { quoteId: string }).quoteId;

    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest({
      method: "POST",
      path: "/commit",
      body: {
        quoteId,
        payerCommitment32B: "0x" + "66".repeat(32),
      },
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
          txSignature: "tx-ok-server-receipt-fixture-1234567890123",
        },
      },
    }), finalizeRes);
    expect(finalizeRes.statusCode).toBe(200);
    const receiptId = (finalizeRes.body as { receiptId: string }).receiptId;
    const receipt = context.receipts.get(receiptId);
    expect(receipt).toBeTruthy();

    const protectedBody = {
      ok: true,
      fixtureId: "fixed_price_tool",
      title: "Fixed-Price Tool",
      seller_defined: true,
      output: {
        primitive: "fixed_price_tool",
        mode: "audit-fixture",
      },
    };
    expectRequestDigest(receipt as SignedReceipt, resource);
    expectResponseDigest(receipt as SignedReceipt, protectedBody);
  });
});
