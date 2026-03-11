import { EventEmitter } from "node:events";
import type { Request, RequestHandler, Response, Router } from "express";
import { describe, expect, it } from "vitest";
import { AuditLogger } from "../src/logging/audit.js";
import { createDnaGuard } from "../src/sdk/guard.js";

class MockResponse extends EventEmitter {
  statusCode = 200;
  body: unknown;
  headersSent = false;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(body: unknown): this {
    this.body = body;
    this.headersSent = true;
    this.emit("finish");
    return this;
  }

  send(body: unknown): this {
    this.body = body;
    this.headersSent = true;
    this.emit("finish");
    return this;
  }
}

function makeRequest(input: {
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
    params: input.params ?? {},
    path: input.path ?? "/",
    protocol: "https",
    query: input.query ?? {},
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

function runMiddleware(middleware: RequestHandler, req: Request, res: Response, handler?: RequestHandler): boolean {
  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
    handler?.(req, res, () => undefined);
  });
  return nextCalled;
}

function routeHandler(router: Router, method: "get" | "post", path: string): RequestHandler {
  const stack = (router as Router & {
    stack: Array<{
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{ handle: RequestHandler }>;
      };
    }>;
  }).stack;
  const layer = stack.find((entry) => entry.route?.path === path && entry.route.methods[method]);
  if (!layer?.route?.stack?.[0]?.handle) {
    throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  }
  return layer.route.stack[0].handle;
}

function invokeRoute(
  router: Router,
  method: "get" | "post",
  path: string,
  input: {
    headers?: Record<string, string>;
    query?: Record<string, unknown>;
    body?: unknown;
    params?: Record<string, string>;
  } = {},
): MockResponse {
  const req = makeRequest({ ...input, path });
  const res = makeResponse() as unknown as MockResponse & Response;
  routeHandler(router, method, path)(req, res, () => undefined);
  return res;
}

describe("DNA Guard middleware and router", () => {
  it("blocks spend ceiling breaches in fail-closed mode", () => {
    const auditLog = new AuditLogger({ stdout: false });
    const guard = createDnaGuard({ auditLog });
    const protectedRoute = guard.protect({
      providerId: "seller-1",
      endpointId: "chat",
      amountAtomic: "60",
      actor: (req) => ({ buyerId: req.header("x-buyer-id") ?? undefined }),
      spendCeilings: { buyerAtomic: "50" },
      failMode: "fail-closed",
    });

    const req = makeRequest({ headers: { "x-buyer-id": "buyer-1" }, path: "/protected" });
    const res = makeResponse();
    const nextCalled = runMiddleware(protectedRoute, req, res, (_req, response) => {
      response.json({ ok: true, receiptId: "receipt-1" });
    });

    expect(nextCalled).toBe(false);
    expect((res as unknown as MockResponse).statusCode).toBe(429);
    expect((res as unknown as MockResponse).body).toEqual({
      error: "dna_guard_spend_blocked",
      blocked: [{
        scope: "buyer",
        actorId: "buyer-1",
        attemptedAtomic: "60",
        currentAtomic: "0",
        limitAtomic: "50",
      }],
    });
    expect(guard.providerSnapshot("seller-1").totals.spendBlocked).toBe(1);
    expect(guard.spendSnapshot({ buyerId: "buyer-1" })).toEqual({ buyer: "0" });
    expect(auditLog.query({ kind: "GUARD_SPEND_BLOCKED" })).toHaveLength(1);
  });

  it("fails open on guard runtime errors and exposes receipt verification state", () => {
    const auditLog = new AuditLogger({ stdout: false });
    const guard = createDnaGuard({ auditLog });
    const protectedRoute = guard.protect({
      providerId: "seller-open",
      endpointId: "inference",
      amountAtomic: "40",
      actor: (req) => ({ buyerId: req.header("x-dna-buyer-id") ?? undefined }),
      replayDetector: () => {
        throw new Error("cache unavailable");
      },
      receiptId: (_req, body) => (body as { receiptId?: string }).receiptId,
      failMode: "fail-open",
    });

    const req = makeRequest({ headers: { "x-dna-buyer-id": "buyer-open" }, path: "/stable" });
    const res = makeResponse();
    const nextCalled = runMiddleware(protectedRoute, req, res, (_req, response) => {
      response.json({ ok: true, receiptId: "receipt-open" });
    });

    expect(nextCalled).toBe(true);
    expect((res as unknown as MockResponse).statusCode).toBe(200);
    expect(guard.spendSnapshot({ buyerId: "buyer-open" })).toEqual({ buyer: "40" });

    const router = guard.router();
    const verifyRes = invokeRoute(router, "post", "/receipt/:receiptId/verify", {
      params: { receiptId: "receipt-open" },
      body: {
        providerId: "seller-open",
        endpointId: "inference",
        valid: false,
        reason: "signature_mismatch",
      },
    });
    expect(verifyRes.statusCode).toBe(201);

    const receiptRes = invokeRoute(router, "get", "/receipt/:receiptId/verify", {
      params: { receiptId: "receipt-open" },
    });
    expect(receiptRes.statusCode).toBe(200);
    expect(receiptRes.body).toMatchObject({
      receiptId: "receipt-open",
      providerId: "seller-open",
      verification: {
        valid: false,
        reason: "signature_mismatch",
      },
    });
    expect(guard.providerSnapshot("seller-open").totals.receiptsInvalid).toBe(1);
    expect(auditLog.query({ kind: "GUARD_FAIL_OPEN" })).toHaveLength(1);
    expect(auditLog.query({ kind: "GUARD_RECEIPT_INVALID" })).toHaveLength(1);
  });

  it("tags validation failures, ranks providers, and recommends the best provider", () => {
    const guard = createDnaGuard();
    const validator = (body: unknown) => ({
      ok: Boolean((body as { ok?: boolean }).ok),
      reason: "schema_validation_failed",
    });

    const alphaRoute = guard.protect({
      providerId: "provider-alpha",
      endpointId: "inference",
      amountAtomic: "20",
      actor: () => ({ buyerId: "buyer-alpha" }),
      receiptId: (_req, body) => (body as { receiptId?: string }).receiptId,
      qualityValidator: validator,
    });
    const betaRoute = guard.protect({
      providerId: "provider-beta",
      endpointId: "inference",
      amountAtomic: "20",
      actor: () => ({ buyerId: "buyer-beta" }),
      receiptId: (_req, body) => (body as { receiptId?: string }).receiptId,
      qualityValidator: validator,
      failMode: "fail-closed",
    });

    runMiddleware(alphaRoute, makeRequest({ path: "/alpha" }), makeResponse(), (_req, res) => {
      res.json({ ok: true, receiptId: "receipt-alpha" });
    });
    const betaRes = makeResponse();
    runMiddleware(betaRoute, makeRequest({ path: "/beta" }), betaRes, (_req, res) => {
      res.json({ ok: false, receiptId: "receipt-beta" });
    });

    expect((betaRes as unknown as MockResponse).statusCode).toBe(502);
    expect((betaRes as unknown as MockResponse).body).toEqual({
      error: "dna_guard_validation_failed",
      reason: "schema_validation_failed",
      receiptId: "receipt-beta",
    });

    const router = guard.router();
    const compareRes = invokeRoute(router, "get", "/compare", {
      query: { providers: "provider-alpha,provider-beta" },
    });
    expect(compareRes.statusCode).toBe(200);
    expect(compareRes.body).toMatchObject({
      bestProviderId: "provider-alpha",
    });

    const bestRes = invokeRoute(router, "get", "/quote/best", {
      query: { providers: "provider-alpha,provider-beta", minScore: "50" },
    });
    expect(bestRes.statusCode).toBe(200);
    expect(bestRes.body).toMatchObject({
      provider: { providerId: "provider-alpha" },
    });

    const reputationRes = invokeRoute(router, "get", "/reputation/:providerId", {
      params: { providerId: "provider-beta" },
    });
    expect(reputationRes.statusCode).toBe(200);
    expect(reputationRes.body).toMatchObject({
      providerId: "provider-beta",
      riskLevel: "high",
      metrics: { qualityRejected: 1 },
    });

    const disputedReceipt = invokeRoute(router, "get", "/receipt/:receiptId/verify", {
      params: { receiptId: "receipt-beta" },
    });
    expect(disputedReceipt.statusCode).toBe(200);
    expect(disputedReceipt.body).toEqual({
      receiptId: "receipt-beta",
      providerId: "provider-beta",
      endpointId: "inference",
      disputed: true,
      disputeReasons: [
        "schema_validation_failed",
        "delivery_failed_502",
      ],
      qualityRejected: true,
    });
  });
});
