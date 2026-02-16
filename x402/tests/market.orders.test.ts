import { describe, expect, it } from "vitest";
import { ReceiptSigner } from "../src/receipts.js";
import { HeartbeatIndex } from "../src/market/heartbeat.js";
import { MarketOrders } from "../src/market/orders.js";
import { QuoteBook } from "../src/market/quotes.js";
import { MarketRegistry } from "../src/market/registry.js";
import { makeSignedShop } from "./market.helpers.js";

describe("market orders", () => {
  it("waits until quotes become cheap enough then executes", () => {
    let nowMs = Date.now();
    const now = () => new Date(nowMs);

    const registry = new MarketRegistry();
    const heartbeat = new HeartbeatIndex();
    const signer = ReceiptSigner.generate();

    registry.register(makeSignedShop({
      shopId: "surge-shop",
      capability: "inference",
      pricingModel: {
        kind: "surge",
        baseAmountAtomic: "1000",
        minMultiplier: 0.8,
        maxMultiplier: 2.8,
      },
      maxLatencyMs: 1000,
    }));

    const quoteBook = new QuoteBook(registry, heartbeat, signer, () => 0.8);
    const orders = new MarketOrders(quoteBook, now);

    heartbeat.upsert({
      shopId: "surge-shop",
      inflight: 80,
      queueDepth: 190,
      p95LatencyMs: 3600,
      errorRate: 0.06,
    }, now());

    const order = orders.create({
      capability: "inference",
      maxPrice: "900",
      maxLatencyMs: 1800,
      expiresAt: new Date(nowMs + 120_000).toISOString(),
      preferSettlement: "transfer",
    });

    expect(orders.poll()).toHaveLength(0);
    expect(orders.get(order.orderId)?.status).toBe("pending");

    nowMs += 5_000;
    heartbeat.upsert({
      shopId: "surge-shop",
      inflight: 0,
      queueDepth: 0,
      p95LatencyMs: 200,
      errorRate: 0,
    }, now());

    const executed = orders.poll();
    expect(executed).toHaveLength(1);
    expect(executed[0].orderId).toBe(order.orderId);
    expect(executed[0].status).toBe("executed");
    expect(executed[0].chosenQuote).toBeDefined();
  });
});
