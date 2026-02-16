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

describe("verified leaderboard", () => {
  it("counts only anchored events for VERIFIED tier", () => {
    const nowMs = Date.parse("2026-02-16T12:00:00.000Z");
    const now = () => new Date(nowMs);

    const storage = new MarketStorage();
    const registry = new MarketRegistry();
    registry.register(makeSignedShop({
      shopId: "shop-v",
      capability: "inference",
      endpointId: "inference",
      priceAtomic: "800",
    }));

    const quoteBook = new QuoteBook(registry, new HeartbeatIndex(), ReceiptSigner.generate(), () => 0.95);
    const analytics = new MarketAnalytics(storage, registry, quoteBook, now);

    storage.append({
      type: "PAYMENT_VERIFIED",
      ts: iso(nowMs - 5_000),
      shopId: "shop-v",
      endpointId: "inference",
      capabilityTags: ["inference"],
      priceAmount: "800",
      mint: "USDC",
      settlementMode: "transfer",
      receiptId: "r-anchored",
      anchor32: "11".repeat(32),
      anchored: true,
      verificationTier: "VERIFIED",
      receiptValid: true,
    });
    storage.append({
      type: "REQUEST_FULFILLED",
      ts: iso(nowMs - 4_500),
      shopId: "shop-v",
      endpointId: "inference",
      capabilityTags: ["inference"],
      priceAmount: "800",
      mint: "USDC",
      statusCode: 200,
      settlementMode: "transfer",
      receiptId: "r-anchored",
      anchor32: "11".repeat(32),
      anchored: true,
      verificationTier: "VERIFIED",
      receiptValid: true,
    });

    storage.append({
      type: "PAYMENT_VERIFIED",
      ts: iso(nowMs - 3_000),
      shopId: "shop-v",
      endpointId: "inference",
      capabilityTags: ["inference"],
      priceAmount: "800",
      mint: "USDC",
      settlementMode: "transfer",
      receiptId: "r-fast-only",
      receiptValid: true,
    });
    storage.append({
      type: "REQUEST_FULFILLED",
      ts: iso(nowMs - 2_500),
      shopId: "shop-v",
      endpointId: "inference",
      capabilityTags: ["inference"],
      priceAmount: "800",
      mint: "USDC",
      statusCode: 200,
      settlementMode: "transfer",
      receiptId: "r-fast-only",
      receiptValid: true,
    });

    const fastTopSelling = analytics.topSelling("24h", "FAST");
    const verifiedTopSelling = analytics.topSelling("24h", "VERIFIED");

    expect(fastTopSelling[0]?.key).toBe("shop-v::inference");
    expect(fastTopSelling[0]?.value).toBe(2);
    expect(verifiedTopSelling[0]?.key).toBe("shop-v::inference");
    expect(verifiedTopSelling[0]?.value).toBe(1);
    expect(verifiedTopSelling[0]?.verificationTier).toBe("VERIFIED");

    const fastRevenue = analytics.topRevenue("24h", "FAST");
    const verifiedRevenue = analytics.topRevenue("24h", "VERIFIED");
    expect(fastRevenue[0]?.value).toBe(1600);
    expect(verifiedRevenue[0]?.value).toBe(800);
  });
});
