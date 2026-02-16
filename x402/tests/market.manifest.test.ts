import { describe, expect, it } from "vitest";
import { hashManifest, validateManifest, validateSignedManifest, verifyManifestSignature } from "../src/market/manifest.js";
import { makeSignedShop } from "./market.helpers.js";

describe("market manifest", () => {
  it("validates signed manifest and verifies ownership signature", () => {
    const signed = makeSignedShop({
      shopId: "alpha",
      capability: "pdf_summarize",
      priceAtomic: "1200",
    });

    const validated = validateSignedManifest(signed);
    const manifest = validateManifest(validated.manifest);

    expect(manifest.shopId).toBe("alpha");
    expect(hashManifest(manifest)).toBe(validated.manifestHash);
    expect(verifyManifestSignature(validated)).toBe(true);
  });

  it("rejects malformed manifests with actionable issues", () => {
    expect(() => validateManifest({ shopId: "x" })).toThrowError("Invalid manifest");
  });

  it("fails verification when hash or signature is tampered", () => {
    const signed = makeSignedShop({
      shopId: "tamper",
      capability: "inference",
    });

    const tamperedHash = {
      ...signed,
      manifestHash: "f".repeat(64),
    };
    expect(verifyManifestSignature(tamperedHash)).toBe(false);

    const tamperedSignature = {
      ...signed,
      signature: signed.signature.slice(0, -1) + (signed.signature.endsWith("1") ? "2" : "1"),
    };
    expect(verifyManifestSignature(tamperedSignature)).toBe(false);
  });
});
