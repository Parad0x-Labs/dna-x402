import { describe, expect, it } from "vitest";
import { MarketRegistry } from "../src/market/registry.js";
import { makeSignedShop } from "./market.helpers.js";

describe("market registry", () => {
  it("registers shops and searches endpoints by capability and constraints", () => {
    const registry = new MarketRegistry();

    registry.register(makeSignedShop({ shopId: "a", capability: "pdf_summarize", priceAtomic: "1500", maxLatencyMs: 1400 }));
    registry.register(makeSignedShop({ shopId: "b", capability: "pdf_summarize", priceAtomic: "900", maxLatencyMs: 900 }));
    registry.register(makeSignedShop({ shopId: "c", capability: "speech_to_text", priceAtomic: "1000", maxLatencyMs: 700 }));

    const allShops = registry.list();
    expect(allShops).toHaveLength(3);

    const results = registry.search({
      capability: "pdf_summarize",
      maxPriceAtomic: "1200",
      maxLatencyMs: 1000,
    });

    expect(results).toHaveLength(1);
    expect(results[0].shopId).toBe("b");
  });

  it("rejects invalid signatures", () => {
    const registry = new MarketRegistry();
    const signed = makeSignedShop({ shopId: "bad", capability: "inference" });
    signed.signature = signed.signature.slice(0, -1) + (signed.signature.endsWith("1") ? "2" : "1");

    expect(() => registry.register(signed)).toThrowError("Invalid manifest signature");
  });
});
