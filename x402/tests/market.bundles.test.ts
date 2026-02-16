import bs58 from "bs58";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { ReceiptSigner } from "../src/receipts.js";
import { BundleRegistry, createSignedBundleManifest } from "../src/market/bundles.js";
import { HeartbeatIndex } from "../src/market/heartbeat.js";
import { QuoteBook } from "../src/market/quotes.js";
import { MarketRegistry } from "../src/market/registry.js";
import { makeSignedShop } from "./market.helpers.js";

describe("market bundles", () => {
  it("registers signed bundle and computes deterministic cost breakdown", () => {
    const kp = nacl.sign.keyPair();
    const ownerPubkey = bs58.encode(kp.publicKey);
    const ownerSecret = bs58.encode(kp.secretKey);

    const marketRegistry = new MarketRegistry();
    marketRegistry.register(makeSignedShop({
      shopId: "shop-research",
      capability: "web_search_with_citations",
      endpointId: "search",
      priceAtomic: "500",
    }));
    marketRegistry.register(makeSignedShop({
      shopId: "shop-summarize",
      capability: "summarize_with_quotes",
      endpointId: "summarize",
      priceAtomic: "700",
    }));

    const quoteBook = new QuoteBook(
      marketRegistry,
      new HeartbeatIndex(),
      ReceiptSigner.generate(),
      () => 0.9,
    );
    const bundles = new BundleRegistry();

    const bundle = {
      bundleId: "deep-research",
      ownerPubkey,
      name: "Deep Research",
      steps: [
        { capability: "web_search_with_citations" },
        { capability: "summarize_with_quotes" },
      ],
      bundlePriceModel: {
        kind: "flat" as const,
        amountAtomic: "1500",
      },
      marginPolicy: {
        kind: "fixed_atomic" as const,
        value: "100",
      },
      examples: ["curl -X POST /bundle/deep-research/run"],
    };
    const signed = createSignedBundleManifest(bundle, ownerSecret);
    bundles.register(signed);

    const breakdown = bundles.costBreakdown(quoteBook, bundle.bundleId);
    expect(breakdown).toBeDefined();
    expect(breakdown?.estimatedUpstreamCostAtomic).toBe("1200");
    expect(breakdown?.expectedBundlePriceAtomic).toBe("1500");
    expect(breakdown?.expectedMarginAtomic).toBe("300");
  });
});

