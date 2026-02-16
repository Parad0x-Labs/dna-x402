import { describe, expect, it } from "vitest";
import { applySurgePricing } from "../src/pricing/surge.js";

describe("surge pricing", () => {
  it("increases price under load and relaxes near base when load drops", () => {
    const busy = applySurgePricing({
      basePriceAtomic: "1000",
      load: {
        queueDepth: 180,
        inflight: 70,
        p95LatencyMs: 3500,
      },
      minMultiplier: 0.8,
      maxMultiplier: 2.8,
    });

    const calm = applySurgePricing({
      basePriceAtomic: "1000",
      load: {
        queueDepth: 0,
        inflight: 0,
        p95LatencyMs: 200,
      },
      minMultiplier: 0.8,
      maxMultiplier: 2.8,
    });

    expect(BigInt(busy.priceAtomic)).toBeGreaterThan(1000n);
    expect(BigInt(calm.priceAtomic)).toBeLessThanOrEqual(1000n);
    expect(BigInt(calm.priceAtomic)).toBeGreaterThanOrEqual(800n);
  });
});
