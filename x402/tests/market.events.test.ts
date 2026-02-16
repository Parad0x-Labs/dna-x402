import { describe, expect, it } from "vitest";
import { createMarketEvent, validateMarketEvent } from "../src/market/events.js";

describe("market events", () => {
  it("creates and validates canonical telemetry events", () => {
    const event = createMarketEvent({
      type: "PAYMENT_VERIFIED",
      shopId: "shop-a",
      endpointId: "endpoint-a",
      capabilityTags: ["inference"],
      priceAmount: "1200",
      mint: "USDC",
      settlementMode: "transfer",
      receiptId: "receipt-1",
      anchor32: "ab".repeat(32),
      receiptValid: true,
    }, new Date("2026-02-16T00:00:00.000Z"));

    const validated = validateMarketEvent(event);
    expect(validated.type).toBe("PAYMENT_VERIFIED");
    expect(validated.ts).toBe("2026-02-16T00:00:00.000Z");
  });

  it("rejects invalid events", () => {
    expect(() => validateMarketEvent({ type: "UNKNOWN" })).toThrow();
  });
});
