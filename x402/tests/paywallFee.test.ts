import { describe, expect, it } from "vitest";
import {
  computePaywallFees,
  assertFeeRecipientNotProgramId,
} from "../src/fees/paywallFee.js";

// ── computePaywallFees ────────────────────────────────────────────────────────

describe("computePaywallFees — zero fees", () => {
  it("returns all zeros when both bps are 0", () => {
    const r = computePaywallFees("1000", 0, 0);
    expect(r.operatorFeeAtomic).toBe("0");
    expect(r.protocolFeeAtomic).toBe("0");
    expect(r.totalFeeAtomic).toBe("0");
    expect(r.providerNetAtomic).toBe("1000");
  });

  it("works on a zero-price quote with zero fees", () => {
    const r = computePaywallFees("0", 0, 0);
    expect(r.totalFeeAtomic).toBe("0");
    expect(r.providerNetAtomic).toBe("0");
  });
});

describe("computePaywallFees — operator fee only", () => {
  it("50 bps (0.5%) of 10000 = 50 atomic", () => {
    // 10000 * 50 / 10000 = 50
    const r = computePaywallFees("10000", 50, 0);
    expect(r.operatorFeeAtomic).toBe("50");
    expect(r.protocolFeeAtomic).toBe("0");
    expect(r.totalFeeAtomic).toBe("50");
    expect(r.providerNetAtomic).toBe("9950");
  });

  it("100 bps (1%) of 1000 = 10 atomic", () => {
    const r = computePaywallFees("1000", 100, 0);
    expect(r.operatorFeeAtomic).toBe("10");
    expect(r.providerNetAtomic).toBe("990");
  });

  it("2000 bps (20%) max operator fee of 5000 = 1000 atomic", () => {
    const r = computePaywallFees("5000", 2000, 0);
    expect(r.operatorFeeAtomic).toBe("1000");
    expect(r.providerNetAtomic).toBe("4000");
  });
});

describe("computePaywallFees — protocol fee only", () => {
  it("5 bps (0.05%) of 10000 = 5 atomic", () => {
    const r = computePaywallFees("10000", 0, 5);
    expect(r.protocolFeeAtomic).toBe("5");
    expect(r.operatorFeeAtomic).toBe("0");
    expect(r.totalFeeAtomic).toBe("5");
    expect(r.providerNetAtomic).toBe("9995");
  });

  it("5 bps of 100 = 0 (floor division, dust is zero)", () => {
    // 100 * 5 / 10000 = 0.05 → floor = 0
    const r = computePaywallFees("100", 0, 5);
    expect(r.protocolFeeAtomic).toBe("0");
    expect(r.providerNetAtomic).toBe("100");
  });

  it("100 bps (1%) of 1000 = 10 atomic", () => {
    const r = computePaywallFees("1000", 0, 100);
    expect(r.protocolFeeAtomic).toBe("10");
    expect(r.providerNetAtomic).toBe("990");
  });
});

describe("computePaywallFees — combined operator + protocol", () => {
  it("50 bps operator + 5 bps protocol of 10000", () => {
    // 10000 * 50 / 10000 = 50  |  10000 * 5 / 10000 = 5  |  total = 55
    const r = computePaywallFees("10000", 50, 5);
    expect(r.operatorFeeAtomic).toBe("50");
    expect(r.protocolFeeAtomic).toBe("5");
    expect(r.totalFeeAtomic).toBe("55");
    expect(r.providerNetAtomic).toBe("9945");
  });

  it("mainnet-commercial config: 50 bps + 5 bps on 1000000 atomic", () => {
    const r = computePaywallFees("1000000", 50, 5);
    expect(r.operatorFeeAtomic).toBe("5000");   // 0.5%
    expect(r.protocolFeeAtomic).toBe("500");    // 0.05%
    expect(r.totalFeeAtomic).toBe("5500");
    expect(r.providerNetAtomic).toBe("994500");
  });

  it("floor division: 50 + 5 bps of 9 atomic = 0 + 0 = all to provider", () => {
    // 9 * 50 / 10000 = 0.045 → 0  |  9 * 5 / 10000 = 0.0045 → 0
    const r = computePaywallFees("9", 50, 5);
    expect(r.totalFeeAtomic).toBe("0");
    expect(r.providerNetAtomic).toBe("9");
  });
});

describe("computePaywallFees — range validation", () => {
  it("throws on negative operatorFeeBps", () => {
    expect(() => computePaywallFees("1000", -1, 0)).toThrow(/operatorFeeBps.*range/i);
  });

  it("throws on operatorFeeBps > 2000", () => {
    expect(() => computePaywallFees("1000", 2001, 0)).toThrow(/operatorFeeBps.*range/i);
  });

  it("throws on negative protocolFeeBps", () => {
    expect(() => computePaywallFees("1000", 0, -1)).toThrow(/protocolFeeBps.*range/i);
  });

  it("throws on protocolFeeBps > 100", () => {
    expect(() => computePaywallFees("1000", 0, 101)).toThrow(/protocolFeeBps.*range/i);
  });

  it("throws on non-integer bps", () => {
    expect(() => computePaywallFees("1000", 1.5, 0)).toThrow(/operatorFeeBps.*range/i);
    expect(() => computePaywallFees("1000", 0, 0.5)).toThrow(/protocolFeeBps.*range/i);
  });

  it("allows operatorFeeBps = 0 and protocolFeeBps = 0", () => {
    expect(() => computePaywallFees("1000", 0, 0)).not.toThrow();
  });

  it("allows operatorFeeBps = 2000 (max)", () => {
    expect(() => computePaywallFees("1000", 2000, 0)).not.toThrow();
  });

  it("allows protocolFeeBps = 100 (max 1%)", () => {
    expect(() => computePaywallFees("1000", 0, 100)).not.toThrow();
  });
});

// ── assertFeeRecipientNotProgramId ────────────────────────────────────────────

describe("assertFeeRecipientNotProgramId", () => {
  it("accepts a valid Solana wallet address (44 chars)", () => {
    expect(() =>
      assertFeeRecipientNotProgramId("CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2"),
    ).not.toThrow();
  });

  it("accepts a 43-char address", () => {
    expect(() =>
      assertFeeRecipientNotProgramId("So11111111111111111111111111111111111111112"),
    ).not.toThrow();
  });

  it("throws on empty string", () => {
    expect(() => assertFeeRecipientNotProgramId("")).toThrow(/non-empty/i);
  });

  it("throws on address too short (< 32 chars)", () => {
    expect(() => assertFeeRecipientNotProgramId("short")).toThrow(/invalid length/i);
  });

  it("throws on address too long (> 44 chars)", () => {
    expect(() =>
      assertFeeRecipientNotProgramId("CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2_extra"),
    ).toThrow(/invalid length/i);
  });

  it("throws on invalid base58 characters", () => {
    expect(() =>
      assertFeeRecipientNotProgramId("CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExd0O0"),
    ).toThrow(/invalid base58/i);
  });

  it("throws when address is in knownProgramIds set", () => {
    const knownIds = new Set(["ADwL3SdoVofz9Geb89asG5UP7gjH5B7B48m3Kj8Xtzpa"]);
    expect(() =>
      assertFeeRecipientNotProgramId("ADwL3SdoVofz9Geb89asG5UP7gjH5B7B48m3Kj8Xtzpa", knownIds),
    ).toThrow(/known program ID/i);
  });

  it("accepts the same address when not in knownProgramIds", () => {
    const knownIds = new Set(["SomeOtherProgramId111111111111111111111111111"]);
    expect(() =>
      assertFeeRecipientNotProgramId("ADwL3SdoVofz9Geb89asG5UP7gjH5B7B48m3Kj8Xtzpa", knownIds),
    ).not.toThrow();
  });
});

// ── dnaPaywall fee integration ────────────────────────────────────────────────
// Verify the fee fields flow through the 402 paymentRequirements response.

import { EventEmitter } from "node:events";
import express from "express";
import { dnaPaywall } from "../src/sdk/paywall.js";
import type { PaymentVerifier } from "../src/paymentVerifier.js";
import type { PaymentProof, Quote } from "../src/types.js";

class FakeVerifier implements PaymentVerifier {
  async verify(_q: Quote, _p: PaymentProof) {
    return { ok: true as const, settledOnchain: false, txSignature: `fake-${Date.now()}` };
  }
}

class MockResponse extends EventEmitter {
  statusCode = 200;
  body: unknown;
  private _headers: Record<string, string> = {};

  status(code: number): this { this.statusCode = code; return this; }
  json(body: unknown): this { this.body = body; this.ended = true; this.emit("finish"); return this; }
  ended = false;
  setHeader(n: string, v: string): void { this._headers[n.toLowerCase()] = v; }
  header(n: string, v: string): void { this._headers[n.toLowerCase()] = v; }
  getHeader(n: string): string | undefined { return this._headers[n.toLowerCase()]; }
}

const BASE = {
  priceAtomic: "10000",
  recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
  paymentVerifier: new FakeVerifier(),
  settlement: ["transfer" as const],
};

function invoke402(mw: ReturnType<typeof dnaPaywall>, app: express.Express) {
  const headers: Record<string, string> = {};
  const req = {
    app, body: {}, method: "GET", params: {}, path: "/api/test",
    originalUrl: "/api/test", protocol: "https", headers,
    header(n: string) { return headers[n.toLowerCase()]; },
    get(n: string) {
      if (n.toLowerCase() === "host") return "example.test";
      return headers[n.toLowerCase()];
    },
  } as unknown as express.Request;
  const res = new MockResponse() as unknown as express.Response;
  mw(req, res, () => {});
  return (res as unknown as MockResponse).body as Record<string, unknown>;
}

describe("dnaPaywall 402 fee breakdown", () => {
  it("no fee fields in quote when both bps = 0", () => {
    const app = express();
    const mw = dnaPaywall({ ...BASE });
    const body = invoke402(mw, app);
    const reqs = body.paymentRequirements as Record<string, unknown>;
    const quote = reqs.quote as Record<string, unknown>;
    expect(quote.feeAtomic).toBe("0");
    expect(quote.totalAtomic).toBe("10000");
    expect(quote.providerNetAtomic).toBe("10000");
    expect(quote.feeBreakdown).toBeUndefined();
  });

  it("operator fee only: 50 bps shows feeBreakdown", () => {
    // 10000 * 50 / 10000 = 50
    const app = express();
    const mw = dnaPaywall({ ...BASE, operatorFeeBps: 50 });
    const body = invoke402(mw, app);
    const quote = (body.paymentRequirements as Record<string, unknown>).quote as Record<string, unknown>;
    expect(quote.feeAtomic).toBe("50");
    expect(quote.totalAtomic).toBe("10000");
    expect(quote.providerNetAtomic).toBe("9950");
    const fb = quote.feeBreakdown as Record<string, unknown>;
    expect(fb.operatorFeeAtomic).toBe("50");
    expect(fb.operatorFeeBps).toBe(50);
    expect(fb.protocolFeeAtomic).toBe("0");
    expect(fb.protocolFeeBps).toBe(0);
  });

  it("protocol fee only: 5 bps shows feeBreakdown with Parad0x treasury", () => {
    const app = express();
    const mw = dnaPaywall({ ...BASE, protocolFeeBps: 5 });
    const body = invoke402(mw, app);
    const quote = (body.paymentRequirements as Record<string, unknown>).quote as Record<string, unknown>;
    expect(quote.feeAtomic).toBe("5");
    expect(quote.totalAtomic).toBe("10000");
    expect(quote.providerNetAtomic).toBe("9995");
    const fb = quote.feeBreakdown as Record<string, unknown>;
    expect(fb.protocolFeeAtomic).toBe("5");
    expect(fb.protocolFeeBps).toBe(5);
    expect(fb.protocolFeeRecipient).toBe("9M949AfyYCHp9hUk7crZZx3N6Y8sigyWBN6RM6tFq1q5");
  });

  it("combined 50+5 bps: both fees in feeBreakdown", () => {
    // operator: 10000*50/10000=50  |  protocol: 10000*5/10000=5  |  total=55
    const app = express();
    const mw = dnaPaywall({
      ...BASE,
      operatorFeeBps: 50,
      protocolFeeBps: 5,
      operatorFeeRecipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
    });
    const body = invoke402(mw, app);
    const quote = (body.paymentRequirements as Record<string, unknown>).quote as Record<string, unknown>;
    expect(quote.feeAtomic).toBe("55");
    expect(quote.providerNetAtomic).toBe("9945");
    const fb = quote.feeBreakdown as Record<string, unknown>;
    expect(fb.operatorFeeAtomic).toBe("50");
    expect(fb.protocolFeeAtomic).toBe("5");
  });

  it("throws at construction if operatorFeeRecipient is invalid base58", () => {
    expect(() =>
      dnaPaywall({
        ...BASE,
        operatorFeeBps: 50,
        operatorFeeRecipient: "not-a-valid-address",
      }),
    ).toThrow();
  });
});
