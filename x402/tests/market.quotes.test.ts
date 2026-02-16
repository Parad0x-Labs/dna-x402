import { describe, expect, it } from "vitest";
import { ReceiptSigner } from "../src/receipts.js";
import { HeartbeatIndex } from "../src/market/heartbeat.js";
import { QuoteBook, verifyQuoteSignature } from "../src/market/quotes.js";
import { MarketRegistry } from "../src/market/registry.js";
import { makeSignedShop } from "./market.helpers.js";

describe("market quotes", () => {
  it("returns signed competing quotes with ranking and expiry", () => {
    const registry = new MarketRegistry();
    const heartbeat = new HeartbeatIndex();
    const signer = ReceiptSigner.generate();

    registry.register(makeSignedShop({ shopId: "cheap", capability: "pdf_summarize", priceAtomic: "900", maxLatencyMs: 1200 }));
    registry.register(makeSignedShop({ shopId: "premium", capability: "pdf_summarize", priceAtomic: "1400", maxLatencyMs: 800 }));

    heartbeat.upsert({
      shopId: "cheap",
      inflight: 2,
      queueDepth: 4,
      p95LatencyMs: 900,
      errorRate: 0.01,
    });
    heartbeat.upsert({
      shopId: "premium",
      inflight: 1,
      queueDepth: 2,
      p95LatencyMs: 600,
      errorRate: 0,
    });

    const quoteBook = new QuoteBook(registry, heartbeat, signer, (shopId) => (shopId === "cheap" ? 0.78 : 0.95));

    const quotes = quoteBook.list({
      capability: "pdf_summarize",
      maxPriceAtomic: "2000",
      maxLatencyMs: 2000,
      limit: 10,
      mint: "USDC",
    });

    expect(quotes.length).toBeGreaterThanOrEqual(2);
    expect(new Set(quotes.map((quote) => quote.shopId)).size).toBeGreaterThanOrEqual(2);
    for (const quote of quotes) {
      expect(verifyQuoteSignature(quote, signer.signerPublicKey)).toBe(true);
      expect(new Date(quote.expiresAt).getTime()).toBeGreaterThan(Date.now());
    }
    expect(quotes[0].rankScore).toBeGreaterThanOrEqual(quotes[quotes.length - 1].rankScore);
  });
});
