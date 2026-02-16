import bs58 from "bs58";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { ReceiptSigner } from "../src/receipts.js";
import { BundleExecutor } from "../src/market/bundleExecutor.js";
import { BundleRegistry, createSignedBundleManifest } from "../src/market/bundles.js";
import { HeartbeatIndex } from "../src/market/heartbeat.js";
import { QuoteBook } from "../src/market/quotes.js";
import { MarketRegistry } from "../src/market/registry.js";
import { MarketEvent } from "../src/market/types.js";
import { makeSignedShop } from "./market.helpers.js";

describe("bundle executor", () => {
  it("runs bundle steps and emits bundle events", async () => {
    const kp = nacl.sign.keyPair();
    const ownerPubkey = bs58.encode(kp.publicKey);
    const ownerSecret = bs58.encode(kp.secretKey);

    const registry = new MarketRegistry();
    registry.register(makeSignedShop({
      shopId: "shop-a",
      capability: "pdf_fetch_extract",
      endpointId: "pdf-fetch-extract",
      priceAtomic: "600",
    }));
    registry.register(makeSignedShop({
      shopId: "shop-b",
      capability: "summarize_with_quotes",
      endpointId: "summarize-with-quotes",
      priceAtomic: "900",
    }));

    const quoteBook = new QuoteBook(
      registry,
      new HeartbeatIndex(),
      ReceiptSigner.generate(),
      () => 0.92,
    );

    const bundles = new BundleRegistry();
    bundles.register(createSignedBundleManifest({
      bundleId: "bundle-report",
      ownerPubkey,
      name: "Report Bundle",
      steps: [
        { capability: "pdf_fetch_extract" },
        { capability: "summarize_with_quotes" },
      ],
      bundlePriceModel: {
        kind: "flat",
        amountAtomic: "2000",
      },
      marginPolicy: {
        kind: "percent",
        value: 15,
      },
    }, ownerSecret));

    const events: Array<Omit<MarketEvent, "ts">> = [];
    const executor = new BundleExecutor(bundles, quoteBook, {
      recordEvent: (event) => {
        events.push(event);
      },
      executeStep: async (context) => ({
        output: { capability: context.capability, ok: true },
        receiptId: `upstream-${context.stepIndex}`,
      }),
    });

    const result = await executor.run("bundle-report", { input: "demo" });

    expect(result.bundleId).toBe("bundle-report");
    expect(result.upstreamReceipts).toHaveLength(2);
    expect(result.bundleReceiptId).toBeTruthy();
    expect(result.output.steps).toHaveLength(2);
    expect(BigInt(result.grossAmountAtomic)).toBeGreaterThanOrEqual(BigInt(result.upstreamCostAtomic));
    expect(events.filter((event) => event.type === "BUNDLE_STEP_EXECUTED")).toHaveLength(2);
    expect(events.some((event) => event.type === "BUNDLE_RUN")).toBe(true);
  });
});

