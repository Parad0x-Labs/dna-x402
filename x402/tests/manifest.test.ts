import { describe, expect, it } from "vitest";
import { ManifestValidationError, validateShopManifest } from "../src/manifest/validate.js";

describe("shop manifest validation", () => {
  it("accepts valid manifest", () => {
    const manifest = validateShopManifest({
      shopId: "shop-a",
      name: "Shop A",
      ownerAddress: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      endpoints: [
        {
          endpointId: "pdf-v1",
          path: "/pdf",
          method: "POST",
          capabilityTags: ["pdf_summarize"],
          description: "PDF summary endpoint",
          pricingModel: {
            kind: "flat",
            amountAtomic: "25000",
          },
          settlementModes: ["transfer", "netting"],
          expectedLatencyMs: 900,
          reputationScore: 0.92,
        },
      ],
    });

    expect(manifest.shopId).toBe("shop-a");
    expect(manifest.endpoints[0].pricingModel.kind).toBe("flat");
  });

  it("returns actionable errors for invalid manifest", () => {
    try {
      validateShopManifest({
        shopId: "shop-b",
        name: "Shop B",
        ownerAddress: "short",
        endpoints: [
          {
            endpointId: "dup",
            path: "pdf",
            method: "GET",
            capabilityTags: [],
            description: "",
            pricingModel: {
              kind: "surge",
              baseAmountAtomic: "abc",
              minMultiplier: 2,
              maxMultiplier: 1,
            },
            settlementModes: [],
          },
        ],
      });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestValidationError);
      const e = error as ManifestValidationError;
      expect(e.issues.length).toBeGreaterThan(0);
      expect(e.issues.join("\n")).toContain("ownerAddress");
    }
  });
});
