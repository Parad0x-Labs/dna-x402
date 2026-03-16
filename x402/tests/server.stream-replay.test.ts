import { EventEmitter } from "node:events";
import type { Express, Request, RequestHandler, Response, Router } from "express";
import { describe, expect, it } from "vitest";
import { X402Config } from "../src/config.js";
import { PaymentVerifier } from "../src/paymentVerifier.js";
import { ReceiptSigner } from "../src/receipts.js";
import { createX402App } from "../src/server.js";
import { PaymentProof, Quote } from "../src/types.js";

class StreamVerifier implements PaymentVerifier {
  async verify(_quote: Quote, paymentProof: PaymentProof) {
    if (paymentProof.settlement === "stream") {
      return { ok: true, settledOnchain: true, streamId: paymentProof.streamId };
    }
    return { ok: false, settledOnchain: false, error: "bad" };
  }
}

class BrokenStreamVerifier implements PaymentVerifier {
  async verify(_quote: Quote, paymentProof: PaymentProof) {
    if (paymentProof.settlement === "stream") {
      return { ok: true, settledOnchain: true };
    }
    return { ok: false, settledOnchain: false, error: "bad" };
  }
}

class BrokenTransferVerifier implements PaymentVerifier {
  async verify(_quote: Quote, paymentProof: PaymentProof) {
    if (paymentProof.settlement === "transfer") {
      return { ok: true, settledOnchain: true };
    }
    return { ok: false, settledOnchain: false, error: "bad" };
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
    traceId: "trace-server-stream-replay",
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

async function issueQuoteAndCommit(app: Express, resource: string, commitmentHex: string): Promise<{ quoteId: string; commitId: string }> {
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
    body: { quoteId, payerCommitment32B: commitmentHex },
  }), commitRes);
  expect(commitRes.statusCode).toBe(201);
  return { quoteId, commitId: (commitRes.body as { commitId: string }).commitId };
}

describe("server stream settlement safety", () => {
  it("rejects reusing the same streamId across different commits", async () => {
    const { app } = createX402App(baseConfig(), {
      paymentVerifier: new StreamVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    });

    const first = await issueQuoteAndCommit(app, "/stream-access", "0x" + "41".repeat(32));
    const firstFinalize = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/finalize"), makeRequest({
      method: "POST",
      path: "/finalize",
      body: {
        commitId: first.commitId,
        paymentProof: {
          settlement: "stream",
          streamId: "stream-server-replay-1234567890",
          amountAtomic: "100",
        },
      },
    }), firstFinalize);
    expect(firstFinalize.statusCode).toBe(200);

    const second = await issueQuoteAndCommit(app, "/stream-access", "0x" + "42".repeat(32));
    const replayRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/finalize"), makeRequest({
      method: "POST",
      path: "/finalize",
      body: {
        commitId: second.commitId,
        paymentProof: {
          settlement: "stream",
          streamId: "stream-server-replay-1234567890",
          amountAtomic: "100",
        },
      },
    }), replayRes);

    expect(replayRes.statusCode).toBe(409);
    expect(replayRes.body).toMatchObject({
      error: {
        code: "X402_REPLAY_DETECTED",
      },
    });
  });

  it("rejects a stream verifier result that omits canonical streamId", async () => {
    const { app } = createX402App(baseConfig(), {
      paymentVerifier: new BrokenStreamVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    });

    const { commitId } = await issueQuoteAndCommit(app, "/stream-access", "0x" + "43".repeat(32));
    const finalizeRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/finalize"), makeRequest({
      method: "POST",
      path: "/finalize",
      body: {
        commitId,
        paymentProof: {
          settlement: "stream",
          streamId: "stream-server-missing-1234567890",
          amountAtomic: "100",
        },
      },
    }), finalizeRes);

    expect(finalizeRes.statusCode).toBe(400);
    expect(finalizeRes.body).toMatchObject({
      error: {
        code: "X402_PROOF_INVALID",
      },
    });
  });

  it("rejects a transfer verifier result that omits canonical txSignature", async () => {
    const { app } = createX402App(baseConfig(), {
      paymentVerifier: new BrokenTransferVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    });

    const { commitId } = await issueQuoteAndCommit(app, "/resource", "0x" + "44".repeat(32));
    const finalizeRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/finalize"), makeRequest({
      method: "POST",
      path: "/finalize",
      body: {
        commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-server-missing-sig-12345678901234567890",
        },
      },
    }), finalizeRes);

    expect(finalizeRes.statusCode).toBe(400);
    expect(finalizeRes.body).toMatchObject({
      error: {
        code: "X402_PROOF_INVALID",
      },
    });
  });
});
