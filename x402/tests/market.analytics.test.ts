import { describe, expect, it } from "vitest";
import { ReceiptSigner } from "../src/receipts.js";
import { MarketAnalytics } from "../src/market/analytics.js";
import { HeartbeatIndex } from "../src/market/heartbeat.js";
import { QuoteBook } from "../src/market/quotes.js";
import { MarketRegistry } from "../src/market/registry.js";
import { MarketStorage } from "../src/market/storage.js";
import { makeSignedShop } from "./market.helpers.js";

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

describe("market analytics", () => {
  it("computes top-selling, revenue, trending, on-sale and snapshot", () => {
    const nowMs = Date.parse("2026-02-16T12:00:00.000Z");
    const now = () => new Date(nowMs);

    const storage = new MarketStorage();
    const registry = new MarketRegistry();
    registry.register(makeSignedShop({ shopId: "shop-a", capability: "inference", priceAtomic: "1200" }));
    registry.register(makeSignedShop({ shopId: "shop-b", capability: "pdf_summarize", priceAtomic: "900" }));

    const quoteBook = new QuoteBook(registry, new HeartbeatIndex(), ReceiptSigner.generate(), () => 0.9);
    const analytics = new MarketAnalytics(storage, registry, quoteBook, now);

    storage.append({
      type: "QUOTE_ISSUED",
      ts: iso(nowMs - 90 * 60 * 1000),
      shopId: "shop-a",
      endpointId: "shop-a-endpoint",
      capabilityTags: ["inference"],
      priceAmount: "2000",
      mint: "USDC",
    });
    storage.append({
      type: "QUOTE_ISSUED",
      ts: iso(nowMs - 30 * 60 * 1000),
      shopId: "shop-a",
      endpointId: "shop-a-endpoint",
      capabilityTags: ["inference"],
      priceAmount: "1200",
      mint: "USDC",
    });

    storage.append({
      type: "PAYMENT_VERIFIED",
      ts: iso(nowMs - 20 * 60 * 1000),
      shopId: "shop-a",
      endpointId: "shop-a-endpoint",
      capabilityTags: ["inference"],
      priceAmount: "1200",
      mint: "USDC",
      settlementMode: "transfer",
      receiptId: "receipt-a1",
      receiptValid: true,
    });
    storage.append({
      type: "REQUEST_FULFILLED",
      ts: iso(nowMs - 19 * 60 * 1000),
      shopId: "shop-a",
      endpointId: "shop-a-endpoint",
      capabilityTags: ["inference"],
      priceAmount: "1200",
      mint: "USDC",
      settlementMode: "transfer",
      latencyMs: 880,
      statusCode: 200,
      receiptId: "receipt-a1",
      receiptValid: true,
    });

    storage.append({
      type: "REQUEST_FULFILLED",
      ts: iso(nowMs - 100 * 60 * 1000),
      shopId: "shop-b",
      endpointId: "shop-b-endpoint",
      capabilityTags: ["pdf_summarize"],
      priceAmount: "900",
      mint: "USDC",
      latencyMs: 1200,
      statusCode: 200,
      receiptId: "receipt-old",
      receiptValid: true,
    });

    storage.append({
      type: "PAYMENT_VERIFIED",
      ts: iso(nowMs - 15 * 60 * 1000),
      shopId: "shop-b",
      endpointId: "shop-b-endpoint",
      capabilityTags: ["pdf_summarize"],
      priceAmount: "900",
      mint: "USDC",
      settlementMode: "transfer",
      receiptId: "receipt-b1",
      receiptValid: true,
    });
    storage.append({
      type: "REQUEST_FULFILLED",
      ts: iso(nowMs - 14 * 60 * 1000),
      shopId: "shop-b",
      endpointId: "shop-b-endpoint",
      capabilityTags: ["pdf_summarize"],
      priceAmount: "900",
      mint: "USDC",
      settlementMode: "transfer",
      latencyMs: 700,
      statusCode: 200,
      receiptId: "receipt-b1",
      receiptValid: true,
    });

    const topSelling = analytics.topSelling("24h");
    expect(topSelling.length).toBeGreaterThanOrEqual(2);
    expect(topSelling[0].value).toBeGreaterThanOrEqual(1);

    const topRevenue = analytics.topRevenue("24h");
    expect(topRevenue.length).toBeGreaterThanOrEqual(2);

    const trending = analytics.trending("1h");
    expect(trending.find((row) => row.key.includes("shop-a"))?.value).toBeGreaterThanOrEqual(0);

    const onSale = analytics.onSale("1h");
    expect(onSale.some((row) => row.key === "shop-a::shop-a-endpoint")).toBe(true);

    const history = analytics.priceHistory("shop-a-endpoint", "7d");
    expect(history.length).toBeGreaterThanOrEqual(2);

    const snapshot = analytics.snapshot();
    expect(snapshot.topCapabilitiesByDemandVelocity.length).toBeGreaterThan(0);
    expect(snapshot.medianPriceByCapability.inference).toBeDefined();
    expect(snapshot.sellerDensityByCapability.inference).toBeGreaterThanOrEqual(1);
  });
});
