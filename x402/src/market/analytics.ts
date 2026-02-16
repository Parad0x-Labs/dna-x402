import { parseAtomic } from "../feePolicy.js";
import { QuoteBook } from "./quotes.js";
import { MarketRegistry } from "./registry.js";
import { MarketStorage } from "./storage.js";
import { MarketEvent, RankedMetric, VerificationTier } from "./types.js";

function parseWindow(window: string): number {
  switch (window) {
    case "1h":
      return 60 * 60 * 1000;
    case "24h":
      return 24 * 60 * 60 * 1000;
    case "7d":
      return 7 * 24 * 60 * 60 * 1000;
    default:
      return 24 * 60 * 60 * 1000;
  }
}

function keyFor(event: MarketEvent): string {
  return `${event.shopId}::${event.endpointId}`;
}

function aggregateBy<T extends { key: string; value: number; meta?: Record<string, unknown> }>(
  rows: T[],
  verificationTier?: VerificationTier,
): RankedMetric[] {
  return rows
    .sort((a, b) => b.value - a.value)
    .map((row) => ({
      key: row.key,
      value: Number(row.value.toFixed(6)),
      verificationTier,
      meta: row.meta,
    }));
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function stddev(values: number[]): number {
  if (values.length <= 1) {
    return 0;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export class MarketAnalytics {
  constructor(
    private readonly storage: MarketStorage,
    private readonly registry: MarketRegistry,
    private readonly quoteBook: QuoteBook,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private verifiedFulfilledEvents(windowMs: number, verificationTier: VerificationTier): MarketEvent[] {
    const events = this.storage.inWindow(windowMs, this.now());
    const paymentsByReceipt = new Map<string, MarketEvent>();
    for (const event of events) {
      if (event.type === "PAYMENT_VERIFIED" && event.receiptId && event.receiptValid !== false) {
        if (verificationTier === "VERIFIED") {
          const anchored = event.anchored === true;
          const strictTier = event.verificationTier === "VERIFIED";
          if (!anchored || !strictTier || !event.anchor32) {
            continue;
          }
        }
        paymentsByReceipt.set(event.receiptId, event);
      }
    }

    const valid: MarketEvent[] = [];
    for (const event of events) {
      if (event.type !== "REQUEST_FULFILLED") {
        continue;
      }
      if (event.statusCode && event.statusCode >= 400) {
        continue;
      }
      if (!event.receiptId) {
        continue;
      }
      if (verificationTier === "VERIFIED") {
        const anchored = event.anchored === true;
        const strictTier = event.verificationTier === "VERIFIED";
        if (!anchored || !strictTier || !event.anchor32) {
          continue;
        }
      }
      const payment = paymentsByReceipt.get(event.receiptId);
      if (payment) {
        valid.push(payment);
      }
    }
    return valid;
  }

  topSelling(window: string, verificationTier: VerificationTier = "FAST"): RankedMetric[] {
    const rows = this.verifiedFulfilledEvents(parseWindow(window), verificationTier);
    const byKey = new Map<string, number>();
    for (const row of rows) {
      const key = keyFor(row);
      byKey.set(key, (byKey.get(key) ?? 0) + 1);
    }
    return aggregateBy(Array.from(byKey.entries()).map(([key, value]) => ({ key, value })), verificationTier);
  }

  topRevenue(window: string, verificationTier: VerificationTier = "FAST", ownerPubkey?: string): RankedMetric[] {
    const rows = this.verifiedFulfilledEvents(parseWindow(window), verificationTier);
    const byKey = new Map<string, bigint>();
    for (const row of rows) {
      if (ownerPubkey && row.ownerPubkey && row.ownerPubkey !== ownerPubkey) {
        continue;
      }
      const key = keyFor(row);
      byKey.set(key, (byKey.get(key) ?? 0n) + parseAtomic(row.priceAmount));
    }

    const bundleRows = this.storage.inWindow(parseWindow(window), this.now()).filter((event) => {
      if (event.type !== "BUNDLE_RUN") {
        return false;
      }
      if (verificationTier === "VERIFIED") {
        const anchored = event.anchored === true;
        const strictTier = event.verificationTier === "VERIFIED";
        if (!anchored || !strictTier || !event.anchor32) {
          return false;
        }
      }
      if (ownerPubkey && event.ownerPubkey !== ownerPubkey) {
        return false;
      }
      return true;
    });
    for (const row of bundleRows) {
      const key = `bundle-owner::${row.ownerPubkey ?? "unknown"}`;
      byKey.set(key, (byKey.get(key) ?? 0n) + parseAtomic(row.priceAmount));
    }

    return aggregateBy(Array.from(byKey.entries()).map(([key, value]) => ({ key, value: Number(value) })), verificationTier);
  }

  trending(window: string, verificationTier: VerificationTier = "FAST"): RankedMetric[] {
    const windowMs = parseWindow(window);
    const nowMs = this.now().getTime();
    const current = this.storage.between(nowMs - windowMs, nowMs).filter((event) => {
      if (event.type !== "REQUEST_FULFILLED") {
        return false;
      }
      if (verificationTier === "VERIFIED") {
        const anchored = event.anchored === true;
        const strictTier = event.verificationTier === "VERIFIED";
        if (!anchored || !strictTier || !event.anchor32) {
          return false;
        }
      }
      return true;
    });
    const previous = this.storage.between(nowMs - windowMs * 2, nowMs - windowMs).filter((event) => {
      if (event.type !== "REQUEST_FULFILLED") {
        return false;
      }
      if (verificationTier === "VERIFIED") {
        const anchored = event.anchored === true;
        const strictTier = event.verificationTier === "VERIFIED";
        if (!anchored || !strictTier || !event.anchor32) {
          return false;
        }
      }
      return true;
    });

    const currByKey = new Map<string, number>();
    const prevByKey = new Map<string, number>();
    for (const event of current) {
      currByKey.set(keyFor(event), (currByKey.get(keyFor(event)) ?? 0) + 1);
    }
    for (const event of previous) {
      prevByKey.set(keyFor(event), (prevByKey.get(keyFor(event)) ?? 0) + 1);
    }

    const keys = new Set([...currByKey.keys(), ...prevByKey.keys()]);
    return aggregateBy(Array.from(keys.values()).map((key) => {
      const curr = currByKey.get(key) ?? 0;
      const prev = prevByKey.get(key) ?? 0;
      const delta = curr - prev;
      const velocity = prev === 0 ? curr : delta / prev;
      return {
        key,
        value: velocity,
        meta: {
          current: curr,
          previous: prev,
          delta,
        },
      };
    }), verificationTier);
  }

  onSale(window: string): RankedMetric[] {
    const windowMs = parseWindow(window);
    const nowMs = this.now().getTime();
    const currentQuotes = this.storage.between(nowMs - windowMs, nowMs).filter((event) => event.type === "QUOTE_ISSUED");
    const previousQuotes = this.storage.between(nowMs - windowMs * 2, nowMs - windowMs).filter((event) => event.type === "QUOTE_ISSUED");

    const currentByKey = new Map<string, number[]>();
    const previousByKey = new Map<string, number[]>();

    for (const event of currentQuotes) {
      const key = keyFor(event);
      currentByKey.set(key, [...(currentByKey.get(key) ?? []), Number(parseAtomic(event.priceAmount))]);
    }
    for (const event of previousQuotes) {
      const key = keyFor(event);
      previousByKey.set(key, [...(previousByKey.get(key) ?? []), Number(parseAtomic(event.priceAmount))]);
    }

    const rows: RankedMetric[] = [];
    for (const [key, currentPrices] of currentByKey.entries()) {
      const previousPrices = previousByKey.get(key);
      if (!previousPrices || previousPrices.length === 0) {
        continue;
      }
      const currentAvg = currentPrices.reduce((sum, value) => sum + value, 0) / currentPrices.length;
      const previousAvg = previousPrices.reduce((sum, value) => sum + value, 0) / previousPrices.length;
      if (previousAvg <= 0 || currentAvg >= previousAvg) {
        continue;
      }
      const dropRatio = (previousAvg - currentAvg) / previousAvg;
      rows.push({
        key,
        value: dropRatio,
        meta: {
          previousAvg,
          currentAvg,
        },
      });
    }

    return aggregateBy(rows);
  }

  priceHistory(endpointId: string, window: string): Array<{ ts: string; priceAmount: string; type: string; shopId: string }> {
    const windowMs = parseWindow(window);
    return this.storage.inWindow(windowMs, this.now())
      .filter((event) => event.endpointId === endpointId && (event.type === "QUOTE_ISSUED" || event.type === "PAYMENT_VERIFIED"))
      .map((event) => ({
        ts: event.ts,
        priceAmount: event.priceAmount,
        type: event.type,
        shopId: event.shopId,
      }));
  }

  snapshot(): {
    topCapabilitiesByDemandVelocity: RankedMetric[];
    medianPriceByCapability: Record<string, string>;
    sellerDensityByCapability: Record<string, number>;
    volatilityScoreByCapability: Record<string, number>;
    recommendedProviders: Array<{ capability: string; quotes: ReturnType<QuoteBook["list"]> }>;
  } {
    const nowMs = this.now().getTime();
    const currentWindowMs = parseWindow("1h");
    const current = this.storage.between(nowMs - currentWindowMs, nowMs).filter((event) => event.type === "REQUEST_FULFILLED");
    const previous = this.storage.between(nowMs - currentWindowMs * 2, nowMs - currentWindowMs).filter((event) => event.type === "REQUEST_FULFILLED");

    const currentCapability = new Map<string, number>();
    const previousCapability = new Map<string, number>();

    for (const event of current) {
      for (const tag of event.capabilityTags) {
        currentCapability.set(tag, (currentCapability.get(tag) ?? 0) + 1);
      }
    }
    for (const event of previous) {
      for (const tag of event.capabilityTags) {
        previousCapability.set(tag, (previousCapability.get(tag) ?? 0) + 1);
      }
    }

    const capabilityKeys = new Set([...currentCapability.keys(), ...previousCapability.keys()]);
    const demandVelocity = aggregateBy(Array.from(capabilityKeys.values()).map((capability) => {
      const currentCount = currentCapability.get(capability) ?? 0;
      const previousCount = previousCapability.get(capability) ?? 0;
      const delta = previousCount === 0 ? currentCount : (currentCount - previousCount) / previousCount;
      return {
        key: capability,
        value: delta,
        meta: {
          current: currentCount,
          previous: previousCount,
        },
      };
    }));

    const priceEvents = this.storage.inWindow(parseWindow("24h"), this.now())
      .filter((event) => event.type === "PAYMENT_VERIFIED");

    const pricesByCapability = new Map<string, number[]>();
    for (const event of priceEvents) {
      for (const tag of event.capabilityTags) {
        pricesByCapability.set(tag, [...(pricesByCapability.get(tag) ?? []), Number(parseAtomic(event.priceAmount))]);
      }
    }

    const medianPriceByCapability: Record<string, string> = {};
    const volatilityScoreByCapability: Record<string, number> = {};
    for (const [capability, prices] of pricesByCapability.entries()) {
      medianPriceByCapability[capability] = Math.round(median(prices)).toString(10);
      const mean = prices.reduce((sum, value) => sum + value, 0) / prices.length;
      volatilityScoreByCapability[capability] = mean === 0 ? 0 : Number((stddev(prices) / mean).toFixed(6));
    }

    const sellerDensityByCapability: Record<string, number> = {};
    for (const shop of this.registry.list()) {
      const uniqueTags = new Set(shop.endpoints.flatMap((endpoint) => endpoint.capabilityTags));
      for (const tag of uniqueTags) {
        sellerDensityByCapability[tag] = (sellerDensityByCapability[tag] ?? 0) + 1;
      }
    }

    const recommendedProviders = demandVelocity.slice(0, 3).map((ranked) => ({
      capability: ranked.key,
      quotes: this.quoteBook.list({
        capability: ranked.key,
        limit: 3,
      }),
    }));

    return {
      topCapabilitiesByDemandVelocity: demandVelocity,
      medianPriceByCapability,
      sellerDensityByCapability,
      volatilityScoreByCapability,
      recommendedProviders,
    };
  }
}

export { parseWindow };
