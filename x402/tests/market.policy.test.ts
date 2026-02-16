import { describe, expect, it } from "vitest";
import { quoteQueryFromPolicy, selectQuoteByPolicy } from "../src/market/policy.js";
import { MarketQuote } from "../src/market/types.js";

const now = "2026-02-16T12:00:00.000Z";

function quote(input: Partial<MarketQuote> & Pick<MarketQuote, "quoteId" | "shopId" | "endpointId" | "price">): MarketQuote {
  return {
    quoteId: input.quoteId,
    shopId: input.shopId,
    endpointId: input.endpointId,
    method: "POST",
    path: "/resource",
    capabilityTags: ["inference"],
    price: input.price,
    mint: "USDC",
    expiresAt: now,
    expectedLatencyMs: input.expectedLatencyMs ?? 1000,
    load: input.load ?? 0.2,
    reputation: input.reputation ?? 0.8,
    badges: input.badges,
    settlementModes: input.settlementModes ?? ["transfer", "stream", "netting"],
    signature: input.signature ?? "sig",
    rankScore: input.rankScore ?? 0.5,
  };
}

describe("market policy", () => {
  it("selects quote under budget/latency/settlement policy", () => {
    const quotes: MarketQuote[] = [
      quote({
        quoteId: "q1",
        shopId: "shop-a",
        endpointId: "e1",
        price: "1400",
        expectedLatencyMs: 750,
        reputation: 0.95,
        settlementModes: ["transfer"],
      }),
      quote({
        quoteId: "q2",
        shopId: "shop-b",
        endpointId: "e2",
        price: "1100",
        expectedLatencyMs: 680,
        reputation: 0.85,
        settlementModes: ["stream", "transfer"],
        rankScore: 0.7,
      }),
      quote({
        quoteId: "q3",
        shopId: "shop-c",
        endpointId: "e3",
        price: "900",
        expectedLatencyMs: 2000,
        reputation: 0.99,
        settlementModes: ["stream", "transfer"],
      }),
    ];

    const selected = selectQuoteByPolicy(quotes, {
      capability: "inference",
      maxPrice: 1200,
      maxLatencyMs: 900,
      settlement: {
        preferStream: true,
      },
      budget: {
        maxPerCall: 1200,
      },
      prefer: ["lowest_price", "high_reputation"],
    });

    expect(selected?.quoteId).toBe("q2");
  });

  it("filters out netting-only quotes when allowNetting=false", () => {
    const selected = selectQuoteByPolicy([
      quote({
        quoteId: "q-net",
        shopId: "shop-net",
        endpointId: "e-net",
        price: "500",
        settlementModes: ["netting"],
      }),
      quote({
        quoteId: "q-transfer",
        shopId: "shop-transfer",
        endpointId: "e-transfer",
        price: "700",
        settlementModes: ["transfer"],
      }),
    ], {
      capability: "inference",
      settlement: {
        allowNetting: false,
      },
    });

    expect(selected?.quoteId).toBe("q-transfer");
  });

  it("builds query params from policy", () => {
    const params = quoteQueryFromPolicy({
      capability: "pdf_summarize",
      maxPrice: 2000,
      maxLatencyMs: 1800,
    });

    expect(params.get("capability")).toBe("pdf_summarize");
    expect(params.get("maxPrice")).toBe("2000");
    expect(params.get("maxLatencyMs")).toBe("1800");
    expect(params.get("limit")).toBe("20");
  });
});

