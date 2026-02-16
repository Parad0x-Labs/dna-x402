import { describe, expect, it } from "vitest";
import { ReputationEngine } from "../src/market/reputation.js";
import { MarketEvent } from "../src/market/types.js";

function ev(partial: Partial<MarketEvent>): MarketEvent {
  return {
    type: partial.type ?? "REQUEST_FULFILLED",
    ts: partial.ts ?? new Date().toISOString(),
    shopId: partial.shopId ?? "shop",
    endpointId: partial.endpointId ?? "endpoint",
    capabilityTags: partial.capabilityTags ?? ["inference"],
    priceAmount: partial.priceAmount ?? "1000",
    mint: partial.mint ?? "USDC",
    settlementMode: partial.settlementMode,
    latencyMs: partial.latencyMs,
    statusCode: partial.statusCode,
    receiptId: partial.receiptId,
    anchor32: partial.anchor32,
    receiptValid: partial.receiptValid,
  };
}

describe("reputation engine", () => {
  it("penalizes high-failure sellers and rewards reliable ones", () => {
    const engine = new ReputationEngine((shopId) => (shopId === "good-shop" ? 0.99 : 0.6));

    const events: MarketEvent[] = [
      ev({ type: "PAYMENT_VERIFIED", shopId: "good-shop", endpointId: "good-endpoint" }),
      ev({ type: "REQUEST_FULFILLED", shopId: "good-shop", endpointId: "good-endpoint", latencyMs: 420 }),
      ev({ type: "REQUEST_FULFILLED", shopId: "good-shop", endpointId: "good-endpoint", latencyMs: 500 }),
      ev({ type: "PAYMENT_VERIFIED", shopId: "bad-shop", endpointId: "bad-endpoint" }),
      ev({ type: "REQUEST_FAILED", shopId: "bad-shop", endpointId: "bad-endpoint" }),
      ev({ type: "REQUEST_FAILED", shopId: "bad-shop", endpointId: "bad-endpoint" }),
      ev({ type: "REQUEST_FULFILLED", shopId: "bad-shop", endpointId: "bad-endpoint", latencyMs: 4200 }),
      ev({ type: "REFUND_ISSUED", shopId: "bad-shop", endpointId: "bad-endpoint" }),
    ];

    const good = engine.scoreForSeller(events, "good-shop");
    const bad = engine.scoreForSeller(events, "bad-shop");

    expect(good.sellerScore).toBeGreaterThan(bad.sellerScore);
    expect(good.reputationTier).toBe("gold");
    expect(["bronze", "silver"]).toContain(bad.reputationTier);
  });
});
