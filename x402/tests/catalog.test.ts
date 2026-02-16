import { describe, expect, it } from "vitest";
import { ToolCatalog } from "../src/catalog.js";

describe("tool catalog estimator", () => {
  it("returns realistic budget ranges and recent-mix estimate", () => {
    const catalog = new ToolCatalog([
      {
        toolId: "cheap-summarize",
        endpointId: "e1",
        name: "Cheap Summarize",
        capabilityTags: ["pdf_summarize"],
        description: "budget endpoint",
        pricingModel: { kind: "flat", amountAtomic: "100" },
      },
      {
        toolId: "premium-vision",
        endpointId: "e2",
        name: "Premium Vision",
        capabilityTags: ["vision"],
        description: "premium endpoint",
        pricingModel: { kind: "flat", amountAtomic: "1000" },
      },
      {
        toolId: "metered-rag",
        endpointId: "e3",
        name: "RAG",
        capabilityTags: ["rag"],
        description: "metered endpoint",
        pricingModel: { kind: "metered", unitName: "chunk", amountPerUnitAtomic: "250", minUnits: 1 },
      },
    ]);

    const now = Date.UTC(2026, 1, 16, 12, 0, 0);
    const estimate = catalog.estimateBalanceCoverage("10000", [
      { toolId: "premium-vision", units: 1, timestampMs: now - 5_000 },
      { toolId: "premium-vision", units: 1, timestampMs: now - 4_000 },
      { toolId: "cheap-summarize", units: 2, timestampMs: now - 3_000 },
      { toolId: "metered-rag", units: 3, timestampMs: now - 2_000 },
    ], now);

    expect(estimate.basedOnRecentMix).toBe(true);
    expect(estimate.callsRemainingAtTypicalMix).toBeGreaterThan(estimate.maxCallsAtPremiumTools);
    expect(estimate.minCallsAtCheapestTools).toBeGreaterThan(estimate.maxCallsAtPremiumTools);
    expect(estimate.last7dProjectedSpend).toBeTruthy();
  });
});
