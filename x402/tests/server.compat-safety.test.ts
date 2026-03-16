import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import type { Express, Request, RequestHandler, Response } from "express";
import { describe, expect, it } from "vitest";
import { X402Config } from "../src/config.js";
import { PaymentVerifier } from "../src/paymentVerifier.js";
import { ReceiptSigner } from "../src/receipts.js";
import { createX402App } from "../src/server.js";
import type { PaymentProof, Quote } from "../src/types.js";

class MissingIdentityVerifier implements PaymentVerifier {
  async verify(_quote: Quote, _paymentProof: PaymentProof) {
    return { ok: true, settledOnchain: true };
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
    originalUrl: input.path ?? "/",
    protocol: "https",
    query: input.query ?? {},
    traceId: "trace-server-compat-safety",
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

function routeHandler(app: Express, method: "get" | "post", pathName: string): RequestHandler {
  const stack = (app as Express & { _router?: { stack: Array<any> } })._router?.stack ?? [];
  const layer = stack.find((entry) => entry.route?.path === pathName && entry.route.methods?.[method]);
  if (!layer?.route?.stack?.[0]?.handle) {
    throw new Error(`Route not found: ${method.toUpperCase()} ${pathName}`);
  }
  return layer.route.stack[0].handle as RequestHandler;
}

describe("server compat safety", () => {
  it("fails closed when compat transfer verification omits the canonical txSignature", async () => {
    const { app } = createX402App(baseConfig(), {
      paymentVerifier: new MissingIdentityVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    });

    const first = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "get", "/resource"), makeRequest({
      method: "GET",
      path: "/resource",
    }), first);
    expect(first.statusCode).toBe(402);

    const paymentRequired = first.headers["payment-required"];
    expect(paymentRequired).toBeTruthy();

    const proofPayload = Buffer.from(JSON.stringify({
      txSig: "tx-ok-compat-missing-id-12345678901234567890",
      scheme: "solana_spl",
    }), "utf8").toString("base64");

    const paid = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "get", "/resource"), makeRequest({
      method: "GET",
      path: "/resource",
      headers: {
        "payment-required": paymentRequired,
        "x-payment": proofPayload,
      },
    }), paid);

    expect(paid.statusCode).toBe(400);
    expect(paid.body).toMatchObject({
      error: {
        code: "X402_PROOF_INVALID",
      },
    });
  });
});
