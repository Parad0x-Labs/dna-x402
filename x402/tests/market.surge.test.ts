import { describe, expect, it } from "vitest";
import { applySurgePricing } from "../src/pricing/surge.js";

describe("market surge pricing", () => {
  it("stays within configured multipliers as load changes", () => {
    const busy = applySurgePricing({
      basePriceAtomic: "1000",
      load: {
        inflight: 95,
        queueDepth: 210,
        p95LatencyMs: 5000,
        errorRate: 0.3,
      },
      minMultiplier: 0.8,
      maxMultiplier: 2.2,
    });

    const calm = applySurgePricing({
      basePriceAtomic: "1000",
      load: {
        inflight: 0,
        queueDepth: 0,
        p95LatencyMs: 150,
        errorRate: 0,
      },
      minMultiplier: 0.8,
      maxMultiplier: 2.2,
    });

    expect(BigInt(busy.priceAtomic)).toBeLessThanOrEqual(2200n);
    expect(BigInt(busy.priceAtomic)).toBeGreaterThan(1000n);
    expect(BigInt(calm.priceAtomic)).toBeGreaterThanOrEqual(800n);
    expect(BigInt(calm.priceAtomic)).toBeLessThanOrEqual(1000n);
  });
});
