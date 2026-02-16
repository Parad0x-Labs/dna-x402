import { describe, expect, it } from "vitest";
import { computeEndpointBadges } from "../src/market/badges.js";
import { MarketEvent, ShopEndpoint } from "../src/market/types.js";

function event(ts: string, partial: Partial<MarketEvent>): MarketEvent {
  return {
    type: "REQUEST_FULFILLED",
    ts,
    shopId: "shop-fast",
    endpointId: "endpoint-fast",
    capabilityTags: ["inference"],
    priceAmount: "1000",
    mint: "USDC",
    ...partial,
  };
}

describe("market badges", () => {
  it("assigns endpoint badges from telemetry + heartbeat", () => {
    const endpoint: ShopEndpoint = {
      endpointId: "endpoint-fast",
      method: "POST",
      path: "/inference",
      capabilityTags: ["inference"],
      description: "fast inference endpoint",
      pricingModel: { kind: "flat", amountAtomic: "1000" },
      settlementModes: ["transfer", "stream", "netting"],
      sla: {
        maxLatencyMs: 600,
        availabilityTarget: 0.999,
      },
    };

    const events: MarketEvent[] = [];
    for (let i = 0; i < 10; i += 1) {
      events.push(event(new Date(Date.UTC(2026, 1, 16, 12, i, 0)).toISOString(), {
        type: "REQUEST_FULFILLED",
        latencyMs: 520 + i * 5,
        statusCode: 200,
        receiptId: `rcpt-${i}`,
        receiptValid: true,
      }));
    }
    events.push(event(new Date(Date.UTC(2026, 1, 16, 12, 55, 0)).toISOString(), {
      type: "PAYMENT_VERIFIED",
      receiptId: "rcpt-anchor",
      anchor32: "ab".repeat(32),
      receiptValid: true,
    }));

    const badges = computeEndpointBadges({
      shopId: "shop-fast",
      endpoint,
      events,
      heartbeat: {
        shopId: "shop-fast",
        inflight: 4,
        queueDepth: 2,
        p95LatencyMs: 540,
        errorRate: 0,
        updatedAt: new Date(Date.UTC(2026, 1, 16, 12, 56, 0)).toISOString(),
        load: 0.1,
      },
      topSellerKeys: new Set(["shop-fast::endpoint-fast"]),
    });

    expect(badges).toContain("FAST_P95_<800MS");
    expect(badges).toContain("FULFILLMENT_99");
    expect(badges).toContain("LOW_REFUND");
    expect(badges).toContain("STREAM_READY");
    expect(badges).toContain("PROOF_ANCHORED");
    expect(badges).toContain("TOP_SELLER_24H");
  });
});

