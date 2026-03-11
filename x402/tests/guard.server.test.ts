import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Express, Request, RequestHandler, Response, Router } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createAdminRouter } from "../src/admin/router.js";
import { X402Config } from "../src/config.js";
import { PaymentVerifier } from "../src/paymentVerifier.js";
import { ReceiptSigner } from "../src/receipts.js";
import { createX402App } from "../src/server.js";
import { PaymentProof, Quote } from "../src/types.js";

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

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
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
    traceId: "trace-guard-server",
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

function baseConfig(snapshotPath?: string): X402Config {
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
    dnaGuard: {
      enabled: true,
      failMode: "fail-closed",
      windowMs: 86_400_000,
      snapshotPath,
      spendCeilings: {
        buyerAtomic: "1500",
      },
    },
  };
}

describe("DNA Guard x402 server integration", () => {
  it("blocks quote issuance when guard ceilings are exceeded and exposes guard status", async () => {
    const config = baseConfig();
    const { app, context } = createX402App(config, {
      paymentVerifier: new FakeVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    });

    context.guard?.ledger.commitSpend({ buyerId: "buyer-1" }, "1000", new Date("2026-03-11T10:00:00.000Z"));

    const quoteReq = makeRequest({
      method: "GET",
      path: "/quote",
      query: { resource: "/inference" },
      headers: { "x-dna-buyer-id": "buyer-1" },
    });
    const quoteRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "get", "/quote"), quoteReq, quoteRes);

    expect(quoteRes.statusCode).toBe(429);
    expect(quoteRes.body).toMatchObject({ error: "dna_guard_spend_blocked" });

    const healthRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "get", "/health"), makeRequest({ method: "GET", path: "/health" }), healthRes);
    expect(healthRes.body).toMatchObject({
      guard: {
        enabled: true,
        failMode: "fail-closed",
        summary: { spendBlocked: 1 },
      },
    });

    const adminRouter = createAdminRouter({
      context,
      auditLog: context.auditLog,
      config,
      adminSecret: config.adminSecret,
    });
    const adminRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(adminRouter, "get", "/guard"), makeRequest({ method: "GET", path: "/guard" }), adminRes);
    expect(adminRes.body).toMatchObject({
      enabled: true,
      summary: { spendBlocked: 1 },
    });
  });

  it("persists guard spend and provider stats across app restarts", async () => {
    const dir = makeTempDir("dna-guard-server-");
    const snapshotPath = path.join(dir, "guard.json");
    const config = baseConfig(snapshotPath);
    const { app, context } = createX402App(config, {
      paymentVerifier: new FakeVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    });

    const quoteRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "get", "/quote"), makeRequest({
      method: "GET",
      path: "/quote",
      query: { resource: "/resource" },
      headers: { "x-dna-buyer-id": "buyer-2" },
    }), quoteRes);
    expect(quoteRes.statusCode).toBe(200);
    const quoteId = (quoteRes.body as { quoteId: string }).quoteId;

    const commitRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/commit"), makeRequest({
      method: "POST",
      path: "/commit",
      headers: { "x-dna-buyer-id": "buyer-2" },
      body: {
        quoteId,
        payerCommitment32B: "0x" + "77".repeat(32),
      },
    }), commitRes);
    expect(commitRes.statusCode).toBe(201);
    const commitId = (commitRes.body as { commitId: string }).commitId;

    const finalizeRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "post", "/finalize"), makeRequest({
      method: "POST",
      path: "/finalize",
      headers: { "x-dna-buyer-id": "buyer-2" },
      body: {
        commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-guard-server-12345678901234567890",
        },
      },
    }), finalizeRes);
    expect(finalizeRes.statusCode).toBe(200);
    const receiptId = (finalizeRes.body as { receiptId: string }).receiptId;

    const resourceRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(app, "get", "/resource"), makeRequest({
      method: "GET",
      path: "/resource",
      headers: { "x-dnp-commit-id": commitId },
    }), resourceRes);
    expect(resourceRes.statusCode).toBe(200);

    const restarted = createX402App(config, {
      paymentVerifier: new FakeVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    });

    expect(restarted.context.guard?.spendSnapshot({ buyerId: "buyer-2" })).toEqual({ buyer: "1000" });
    expect(restarted.context.guard?.providerSnapshot("dnp-core").totals.fulfilled).toBe(1);

    const guardRouter = restarted.context.guard?.router();
    expect(guardRouter).toBeTruthy();
    const receiptRes = makeResponse() as Response & MockResponse;
    await invoke(routeHandler(guardRouter as Router, "get", "/receipt/:receiptId/verify"), makeRequest({
      method: "GET",
      path: `/receipt/${receiptId}/verify`,
      params: { receiptId },
    }), receiptRes);
    expect(receiptRes.statusCode).toBe(200);
    expect(receiptRes.body).toMatchObject({
      receiptId,
      verification: { valid: true },
    });
  });
});
