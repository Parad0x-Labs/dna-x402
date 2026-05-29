import { EventEmitter } from "node:events";
import express from "express";
import { describe, expect, it } from "vitest";
import type { PaymentVerifier } from "../src/paymentVerifier.js";
import type { PaymentProof, Quote } from "../src/types.js";
import { dnaPaywall } from "../src/sdk/paywall.js";
import { evaluateOffer, parseNegotiateRound } from "../src/negotiation/engine.js";
import type { NegotiationPolicy } from "../src/negotiation/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

class FakeVerifier implements PaymentVerifier {
  async verify(_q: Quote, _p: PaymentProof) {
    return { ok: true as const, settledOnchain: false, txSignature: "fake-tx-sig" };
  }
}

class MockResponse extends EventEmitter {
  statusCode = 200;
  body: unknown;
  ended = false;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(body: unknown): this {
    this.body = body;
    this.ended = true;
    this.emit("finish");
    return this;
  }

  send(body: unknown): this {
    this.body = body;
    this.ended = true;
    this.emit("finish");
    return this;
  }

  setHeader(_n: string, _v: string): void {}
  header(_n: string, _v: string): void {}
}

function makeRequest(
  app: express.Express,
  opts: { headers?: Record<string, string>; path?: string; method?: string } = {},
): express.Request {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    headers[k.toLowerCase()] = v;
  }
  return {
    app,
    body: {},
    method: opts.method ?? "GET",
    params: {},
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

const PAYWALL_BASE = {
  priceAtomic: "5000",
  recipient: "RecipientWallet11111111111111111111111111111",
  paymentVerifier: new FakeVerifier(),
  settlement: ["transfer" as const],
};

const NEG_POLICY: NegotiationPolicy = {
  enabled: true,
  floorPriceAtomic: "3000",
  maxRounds: 2,
};

// ── evaluateOffer unit tests ───────────────────────────────────────────────────

describe("evaluateOffer", () => {
  const policy: NegotiationPolicy = { enabled: true, floorPriceAtomic: "3000", maxRounds: 2 };

  it("accepts offer at listed price — no discount", () => {
    const r = evaluateOffer("5000", "5000", policy, 1);
    expect(r.accepted).toBe(true);
    if (r.accepted) expect(r.agreedPriceAtomic).toBe("5000");
  });

  it("accepts offer between floor and listed", () => {
    const r = evaluateOffer("4000", "5000", policy, 1);
    expect(r.accepted).toBe(true);
    if (r.accepted) expect(r.agreedPriceAtomic).toBe("4000");
  });

  it("accepts offer at exact floor", () => {
    const r = evaluateOffer("3000", "5000", policy, 1);
    expect(r.accepted).toBe(true);
    if (r.accepted) expect(r.agreedPriceAtomic).toBe("3000");
  });

  it("caps agreed price at listed — agent cannot overpay", () => {
    const r = evaluateOffer("9999", "5000", policy, 1);
    expect(r.accepted).toBe(true);
    if (r.accepted) expect(r.agreedPriceAtomic).toBe("5000");
  });

  it("counters at floor when offer is below floor on round 1", () => {
    const r = evaluateOffer("1000", "5000", policy, 1);
    expect(r.accepted).toBe(false);
    if (!r.accepted) {
      expect(r.counterPriceAtomic).toBe("3000");
      expect(r.nextRound).toBe(2);
    }
  });

  it("final-round fallback: accepts at floor when maxRounds hit", () => {
    const r = evaluateOffer("1000", "5000", policy, 2);
    expect(r.accepted).toBe(true);
    if (r.accepted) expect(r.agreedPriceAtomic).toBe("3000");
  });

  it("treats invalid offer string as 0 and counters", () => {
    const r = evaluateOffer("not-a-number", "5000", policy, 1);
    expect(r.accepted).toBe(false);
  });

  it("treats negative offer as 0 and counters", () => {
    const r = evaluateOffer("-1", "5000", policy, 1);
    expect(r.accepted).toBe(false);
  });
});

describe("parseNegotiateRound", () => {
  it("returns 1 for undefined", () => expect(parseNegotiateRound(undefined)).toBe(1));
  it("returns 1 for empty string", () => expect(parseNegotiateRound("")).toBe(1));
  it("returns 1 for NaN string", () => expect(parseNegotiateRound("abc")).toBe(1));
  it("returns 1 for zero", () => expect(parseNegotiateRound("0")).toBe(1));
  it("returns 2 for '2'", () => expect(parseNegotiateRound("2")).toBe(2));
  it("returns 3 for '3'", () => expect(parseNegotiateRound("3")).toBe(3));
});

// ── paywall middleware negotiation tests ──────────────────────────────────────

describe("dnaPaywall negotiation", () => {
  function callPaywall(
    reqHeaders: Record<string, string> = {},
  ): { statusCode: number; body: Record<string, unknown> } {
    const app = express();
    const middleware = dnaPaywall({ ...PAYWALL_BASE, negotiation: NEG_POLICY });
    const req = makeRequest(app, { headers: reqHeaders });
    const res = new MockResponse() as unknown as express.Response;

    middleware(req, res, () => {});

    return { statusCode: (res as unknown as MockResponse).statusCode, body: (res as unknown as MockResponse).body as Record<string, unknown> };
  }

  it("advertises negotiation when no offer header present", () => {
    const { statusCode, body } = callPaywall();
    expect(statusCode).toBe(402);
    const neg = body.negotiation as Record<string, unknown> | undefined;
    expect(neg?.enabled).toBe(true);
    expect(neg?.floorPriceAtomic).toBe("3000");
    expect(neg?.listedPriceAtomic).toBe("5000");
    expect(neg?.maxRounds).toBe(2);
    // A full quote is still issued at listed price when no offer is sent.
    const pr = body.paymentRequirements as { quote?: { totalAtomic?: string } } | undefined;
    expect(pr?.quote?.totalAtomic).toBe("5000");
  });

  it("issues quote at offered price when offer >= floor", () => {
    const { statusCode, body } = callPaywall({ "x-dnp-offer": "4000" });
    expect(statusCode).toBe(402);
    // No negotiation block when accepted.
    expect(body.negotiation).toBeUndefined();
    const pr = body.paymentRequirements as { quote?: { totalAtomic?: string } } | undefined;
    expect(pr?.quote?.totalAtomic).toBe("4000");
  });

  it("issues quote at exact floor when offer equals floor", () => {
    const { statusCode, body } = callPaywall({ "x-dnp-offer": "3000" });
    expect(statusCode).toBe(402);
    const pr = body.paymentRequirements as { quote?: { totalAtomic?: string } } | undefined;
    expect(pr?.quote?.totalAtomic).toBe("3000");
  });

  it("caps quote at listed price when offer exceeds listed", () => {
    const { statusCode, body } = callPaywall({ "x-dnp-offer": "9999" });
    expect(statusCode).toBe(402);
    const pr = body.paymentRequirements as { quote?: { totalAtomic?: string } } | undefined;
    expect(pr?.quote?.totalAtomic).toBe("5000");
  });

  it("returns counter-offer (no quote) when offer below floor on round 1", () => {
    const { statusCode, body } = callPaywall({ "x-dnp-offer": "1000" });
    expect(statusCode).toBe(402);
    // Counter: no paymentRequirements.
    expect(body.paymentRequirements).toBeUndefined();
    const neg = body.negotiation as Record<string, unknown> | undefined;
    expect(neg?.counterPriceAtomic).toBe("3000");
    expect(neg?.round).toBe(2);
  });

  it("accepts at floor on final round even when offer is below floor", () => {
    // Round 2 = maxRounds → must accept.
    const { statusCode, body } = callPaywall({
      "x-dnp-offer": "1000",
      "x-dnp-negotiate-round": "2",
    });
    expect(statusCode).toBe(402);
    // No counter — full quote at floor.
    expect(body.negotiation).toBeUndefined();
    const pr = body.paymentRequirements as { quote?: { totalAtomic?: string } } | undefined;
    expect(pr?.quote?.totalAtomic).toBe("3000");
  });

  it("no negotiation block when negotiation is not configured", () => {
    const app = express();
    const middleware = dnaPaywall({ ...PAYWALL_BASE }); // no negotiation key
    const req = makeRequest(app);
    const res = new MockResponse() as unknown as express.Response;
    middleware(req, res, () => {});
    const body = (res as unknown as MockResponse).body as Record<string, unknown>;
    expect(body.negotiation).toBeUndefined();
    const pr = body.paymentRequirements as { quote?: { totalAtomic?: string } } | undefined;
    expect(pr?.quote?.totalAtomic).toBe("5000");
  });

  it("quote memoHash differs between listed and negotiated price", () => {
    const { body: bodyListed } = callPaywall();
    const { body: bodyNeg } = callPaywall({ "x-dnp-offer": "3500" });
    const memoListed = (bodyListed.paymentRequirements as { quote?: { memoHash?: string } })?.quote?.memoHash;
    const memoNeg = (bodyNeg.paymentRequirements as { quote?: { memoHash?: string } })?.quote?.memoHash;
    expect(memoListed).toBeDefined();
    expect(memoNeg).toBeDefined();
    expect(memoListed).not.toBe(memoNeg);
  });
});
