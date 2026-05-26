import { describe, expect, it } from "vitest";
import { ReceiptSigner } from "../src/receipts.js";
import { HeartbeatIndex } from "../src/market/heartbeat.js";
import { MarketOrders } from "../src/market/orders.js";
import { QuoteBook } from "../src/market/quotes.js";
import { MarketRegistry } from "../src/market/registry.js";
import { applySurgePricing, deriveLoadFactor } from "../src/pricing/surge.js";
import { makeSignedShop } from "./market.helpers.js";

// ---------------------------------------------------------------------------
// Tests for UNTESTED scenarios in market depth and surge pricing.
// market.surge.test.ts covers: busy vs calm multiplier bounds.
// market.orders.test.ts covers: price-triggered order execution.
// pricing.surge.test.ts covers: raw surge formula under load changes.
// This file covers: depth semantics, normal-volume baseline, cap, clear.
// ---------------------------------------------------------------------------

describe("market depth and surge (extended)", () => {
  // Test 1: Market depth is zero when no active orders
  it("market depth is zero when no active orders", () => {
    const registry = new MarketRegistry();
    const heartbeat = new HeartbeatIndex();
    const signer = ReceiptSigner.generate();
    const quoteBook = new QuoteBook(registry, heartbeat, signer);
    const orders = new MarketOrders(quoteBook);

    expect(orders.list()).toHaveLength(0);
  });

  // Test 2: Order book depth increases with each order placement
  it("order book depth increases with each order placement", () => {
    const registry = new MarketRegistry();
    const heartbeat = new HeartbeatIndex();
    const signer = ReceiptSigner.generate();
    registry.register(makeSignedShop({
      shopId: "depth-shop",
      capability: "inference",
      priceAtomic: "1000",
    }));

    const quoteBook = new QuoteBook(registry, heartbeat, signer);
    const orders = new MarketOrders(quoteBook);
    const future = new Date(Date.now() + 120_000).toISOString();

    expect(orders.list()).toHaveLength(0);

    orders.create({ capability: "inference", maxPrice: "2000", maxLatencyMs: 5000, expiresAt: future });
    expect(orders.list()).toHaveLength(1);

    orders.create({ capability: "inference", maxPrice: "2000", maxLatencyMs: 5000, expiresAt: future });
    expect(orders.list()).toHaveLength(2);

    orders.create({ capability: "inference", maxPrice: "2000", maxLatencyMs: 5000, expiresAt: future });
    expect(orders.list()).toHaveLength(3);
  });

  // Test 3: Surge multiplier is 1.0x (or close to minMultiplier) at normal volume
  it("surge multiplier is at or near 1.0x at normal volume", () => {
    // Zero load → loadFactor = 0 → multiplier = minMultiplier (0.8 by default, ≤ 1.0)
    const result = applySurgePricing({
      basePriceAtomic: "1000",
      load: {
        queueDepth: 0,
        inflight: 0,
        p95LatencyMs: 0,
        errorRate: 0,
      },
      minMultiplier: 1.0,
      maxMultiplier: 3.0,
    });

    // At zero load the multiplier should be the min (1.0)
    expect(result.multiplier).toBe(1.0);
    expect(BigInt(result.priceAtomic)).toBe(1000n);
  });

  // Test 4: Surge multiplier increases above 1.0x above threshold
  it("surge multiplier increases above 1.0x above threshold", () => {
    const calm = applySurgePricing({
      basePriceAtomic: "1000",
      load: { queueDepth: 0, inflight: 0, p95LatencyMs: 0, errorRate: 0 },
      minMultiplier: 1.0,
      maxMultiplier: 3.0,
    });

    const busy = applySurgePricing({
      basePriceAtomic: "1000",
      load: { queueDepth: 150, inflight: 70, p95LatencyMs: 3000, errorRate: 0.1 },
      minMultiplier: 1.0,
      maxMultiplier: 3.0,
    });

    expect(busy.multiplier).toBeGreaterThan(calm.multiplier);
    expect(busy.multiplier).toBeGreaterThan(1.0);
    expect(BigInt(busy.priceAtomic)).toBeGreaterThan(1000n);
  });

  // Test 5: Surge price = base_price * surge_multiplier (rounded to lamports)
  it("surge price = base_price * surge_multiplier (rounded up to lamport)", () => {
    const base = 1000n;
    const result = applySurgePricing({
      basePriceAtomic: base.toString(),
      load: { queueDepth: 100, inflight: 50, p95LatencyMs: 2000, errorRate: 0.0 },
      minMultiplier: 1.0,
      maxMultiplier: 2.0,
    });

    const { multiplier, priceAtomic } = result;
    const naivePrice = Number(base) * multiplier;
    const ceiledPrice = Math.ceil(naivePrice);

    // The library rounds up (ceiling) to a whole lamport
    expect(Number(priceAtomic)).toBe(ceiledPrice);
    expect(BigInt(priceAtomic)).toBeGreaterThanOrEqual(base);
  });

  // Test 6: Surge pricing caps at configured max_surge (3x)
  it("surge pricing caps at configured max_surge (3x)", () => {
    // Even with 100% load factor, price must not exceed maxMultiplier * base
    const result = applySurgePricing({
      basePriceAtomic: "1000",
      load: {
        queueDepth: 99999,
        inflight: 99999,
        p95LatencyMs: 99999,
        errorRate: 1.0,
      },
      minMultiplier: 0.8,
      maxMultiplier: 3.0,
    });

    expect(result.multiplier).toBeLessThanOrEqual(3.0);
    expect(BigInt(result.priceAtomic)).toBeLessThanOrEqual(3000n);
  });

  // Test 7: Order book clears correctly — cancelled orders do not execute on poll
  it("order book clears correctly after cancellation", () => {
    let nowMs = Date.now();
    const now = () => new Date(nowMs);

    const registry = new MarketRegistry();
    const heartbeat = new HeartbeatIndex();
    const signer = ReceiptSigner.generate();
    registry.register(makeSignedShop({
      shopId: "clear-shop",
      capability: "inference",
      priceAtomic: "500",
    }));

    const quoteBook = new QuoteBook(registry, heartbeat, signer);
    const orders = new MarketOrders(quoteBook, now);
    const future = new Date(nowMs + 120_000).toISOString();

    const order = orders.create({
      capability: "inference",
      maxPrice: "5000",
      maxLatencyMs: 5000,
      expiresAt: future,
    });

    expect(orders.list()).toHaveLength(1);

    // Cancel the order before poll
    const cancelled = orders.cancel(order.orderId);
    expect(cancelled?.status).toBe("cancelled");

    // Poll should not execute any cancelled orders
    const executed = orders.poll();
    expect(executed).toHaveLength(0);
    expect(orders.get(order.orderId)?.status).toBe("cancelled");
  });
});
