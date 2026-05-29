import { EventEmitter } from "node:events";
import express from "express";
import { describe, expect, it } from "vitest";
import type { PaymentVerifier } from "../src/paymentVerifier.js";
import type { PaymentProof, Quote } from "../src/types.js";
import { dnaPaywall } from "../src/sdk/paywall.js";
import { SESSION_ID_HEADER } from "../src/sdk/sessionKey.js";

// ── Test plumbing ─────────────────────────────────────────────────────────────

class FakeVerifier implements PaymentVerifier {
  async verify(_q: Quote, _p: PaymentProof) {
    return { ok: true as const, settledOnchain: false, txSignature: "fake-tx-sig" };
  }
}

class MockResponse extends EventEmitter {
  statusCode = 200;
  body: unknown;
  ended = false;
  private _headers: Record<string, string> = {};

  status(code: number): this { this.statusCode = code; return this; }
  json(body: unknown): this { this.body = body; this.ended = true; this.emit("finish"); return this; }
  send(body: unknown): this { this.body = body; this.ended = true; this.emit("finish"); return this; }
  setHeader(n: string, v: string): void { this._headers[n.toLowerCase()] = v; }
  header(n: string, v: string): void { this._headers[n.toLowerCase()] = v; }
  getHeader(n: string): string | undefined { return this._headers[n.toLowerCase()]; }
}

function makeRequest(
  app: express.Express,
  opts: { headers?: Record<string, string>; path?: string } = {},
): express.Request {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    headers[k.toLowerCase()] = v;
  }
  return {
    app, body: {}, method: "GET", params: {},
    path: opts.path ?? "/api/test",
    originalUrl: opts.path ?? "/api/test",
    protocol: "https",
    headers,
    header(name: string) { return headers[name.toLowerCase()]; },
    get(name: string) {
      if (name.toLowerCase() === "host") return "example.test";
      return headers[name.toLowerCase()];
    },
  } as unknown as express.Request;
}

const BASE = {
  priceAtomic: "1000",
  recipient: "RecipientWallet11111111111111111111111111111",
  paymentVerifier: new FakeVerifier(),
  settlement: ["transfer" as const],
};

function callMiddleware(
  middleware: ReturnType<typeof dnaPaywall>,
  app: express.Express,
  headers: Record<string, string> = {},
): { statusCode: number; body: Record<string, unknown>; res: MockResponse } {
  const req = makeRequest(app, { headers });
  const res = new MockResponse() as unknown as express.Response;
  middleware(req, res, () => {});
  return {
    statusCode: (res as unknown as MockResponse).statusCode,
    body: (res as unknown as MockResponse).body as Record<string, unknown>,
    res: res as unknown as MockResponse,
  };
}

// ── Session gate: no session configured ───────────────────────────────────────

describe("session gate — not configured", () => {
  it("ignores session header when session is not enabled", () => {
    const app = express();
    const mw = dnaPaywall({ ...BASE }); // no session
    const { statusCode } = callMiddleware(mw, app, {
      [SESSION_ID_HEADER]: "some-session-id",
    });
    // Should return 402 (no valid payment) not 200 (session bypass)
    expect(statusCode).toBe(402);
  });
});

// ── Session gate: bad session IDs ─────────────────────────────────────────────

describe("session gate — unknown / expired sessions", () => {
  it("returns 402 with sessionError for unknown session ID", () => {
    const app = express();
    const mw = dnaPaywall({ ...BASE, session: { enabled: true, maxCalls: 5 } });
    const { statusCode, body } = callMiddleware(mw, app, {
      [SESSION_ID_HEADER]: "does-not-exist",
    });
    expect(statusCode).toBe(402);
    expect(body.sessionError).toMatch(/not found/i);
  });
});

// ── Session policy advertisement ──────────────────────────────────────────────

describe("session policy in 402 response", () => {
  it("does not expose internal session state in the 402 challenge", () => {
    const app = express();
    const mw = dnaPaywall({ ...BASE, session: { enabled: true, maxCalls: 10, ttlSeconds: 60 } });
    const { statusCode, body } = callMiddleware(mw, app);
    expect(statusCode).toBe(402);
    // paymentRequirements should still be present
    expect(body.paymentRequirements).toBeDefined();
    // No session state leaks into unauthenticated 402
    expect((body as Record<string, unknown>).sessionId).toBeUndefined();
  });
});

// ── parseChainDepth ───────────────────────────────────────────────────────────

import { parseChainDepth, MAX_CHAIN_DEPTH } from "../src/sdk/receiptChain.js";

describe("parseChainDepth", () => {
  it("returns 0 for undefined", () => expect(parseChainDepth(undefined)).toBe(0));
  it("returns 0 for empty string", () => expect(parseChainDepth("")).toBe(0));
  it("returns 0 for negative", () => expect(parseChainDepth("-1")).toBe(0));
  it("returns 0 for NaN string", () => expect(parseChainDepth("abc")).toBe(0));
  it("returns 1 for '1'", () => expect(parseChainDepth("1")).toBe(1));
  it("returns 3 for '3'", () => expect(parseChainDepth("3")).toBe(3));
  it("clamps to MAX+1 for huge values", () => {
    expect(parseChainDepth("9999")).toBe(MAX_CHAIN_DEPTH + 1);
  });
  it("MAX_CHAIN_DEPTH is 4", () => expect(MAX_CHAIN_DEPTH).toBe(4));
});

// ── Chain depth enforcement in middleware ─────────────────────────────────────

describe("chain depth enforcement", () => {
  it("returns 400 when chain depth exceeds MAX_CHAIN_DEPTH", () => {
    const app = express();
    const mw = dnaPaywall({ ...BASE });
    const { statusCode, body } = callMiddleware(mw, app, {
      "x-dnp-parent-receipt": "some-receipt-id",
      "x-dnp-chain-depth": String(MAX_CHAIN_DEPTH + 1),
    });
    expect(statusCode).toBe(400);
    expect(String(body.error)).toMatch(/chain/i);
  });

  it("allows chain depth at exactly MAX_CHAIN_DEPTH", () => {
    const app = express();
    const mw = dnaPaywall({ ...BASE });
    const { statusCode } = callMiddleware(mw, app, {
      "x-dnp-parent-receipt": "some-receipt-id",
      "x-dnp-chain-depth": String(MAX_CHAIN_DEPTH),
    });
    // 402 = payment required (depth is ok, just no payment)
    expect(statusCode).toBe(402);
  });

  it("allows no chain headers (depth = 0)", () => {
    const app = express();
    const mw = dnaPaywall({ ...BASE });
    const { statusCode } = callMiddleware(mw, app);
    expect(statusCode).toBe(402);
  });
});

// ── Session policy field validation ──────────────────────────────────────────

describe("SessionPolicy fields", () => {
  it("session with maxCalls still issues normal 402 to unpaid requests", () => {
    const app = express();
    const mw = dnaPaywall({ ...BASE, session: { enabled: true, maxCalls: 3 } });
    const { statusCode, body } = callMiddleware(mw, app);
    expect(statusCode).toBe(402);
    expect(body.paymentRequirements).toBeDefined();
  });

  it("session with maxSpendAtomic still issues normal 402 to unpaid requests", () => {
    const app = express();
    const mw = dnaPaywall({ ...BASE, session: { enabled: true, maxSpendAtomic: "9999" } });
    const { statusCode, body } = callMiddleware(mw, app);
    expect(statusCode).toBe(402);
    expect(body.paymentRequirements).toBeDefined();
  });

  it("session with all fields combined does not break paywall", () => {
    const app = express();
    const mw = dnaPaywall({
      ...BASE,
      session: { enabled: true, maxCalls: 10, maxSpendAtomic: "5000", ttlSeconds: 300 },
    });
    const { statusCode } = callMiddleware(mw, app);
    expect(statusCode).toBe(402);
  });
});

// ── Session + negotiation combined ────────────────────────────────────────────

describe("session + negotiation combined", () => {
  it("negotiation counter still fires when session not present", () => {
    const app = express();
    const mw = dnaPaywall({
      ...BASE,
      session: { enabled: true, maxCalls: 5 },
      negotiation: { enabled: true, floorPriceAtomic: "500", maxRounds: 2 },
    });
    const { statusCode, body } = callMiddleware(mw, app, { "x-dnp-offer": "100" });
    expect(statusCode).toBe(402);
    const neg = body.negotiation as Record<string, unknown> | undefined;
    expect(neg?.counterPriceAtomic).toBeDefined();
  });
});
