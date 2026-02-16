import crypto from "node:crypto";
import { parseAtomic } from "../feePolicy.js";
import { applySurgePricing } from "../pricing/surge.js";
import { ReceiptSigner, verifyDetachedSignature } from "../receipts.js";
import { rankQuotes, RankingWeights } from "./ranking.js";
import { HeartbeatIndex } from "./heartbeat.js";
import { MarketRegistry } from "./registry.js";
import { Badge, MarketQuote, QuoteConstraints, ShopEndpoint } from "./types.js";

function basePriceForEndpoint(endpoint: ShopEndpoint): bigint {
  switch (endpoint.pricingModel.kind) {
    case "flat":
      return parseAtomic(endpoint.pricingModel.amountAtomic);
    case "metered":
      return parseAtomic(endpoint.pricingModel.amountPerUnitAtomic) * BigInt(endpoint.pricingModel.minUnits ?? 1);
    case "surge":
      return parseAtomic(endpoint.pricingModel.baseAmountAtomic);
    case "stream":
      return parseAtomic(endpoint.pricingModel.minTopupAtomic ?? endpoint.pricingModel.rateAtomicPerSecond) * 60n;
    case "netting":
      return parseAtomic(endpoint.pricingModel.unitAmountAtomic);
    default:
      return 0n;
  }
}

function applyEndpointPricing(endpoint: ShopEndpoint, baseAtomic: bigint, load: number, heartbeat?: { queueDepth: number; inflight: number; p95LatencyMs: number; errorRate: number }): string {
  if (endpoint.pricingModel.kind !== "surge") {
    return baseAtomic.toString(10);
  }

  const pricing = applySurgePricing({
    basePriceAtomic: endpoint.pricingModel.baseAmountAtomic,
    load: heartbeat ?? {
      queueDepth: Math.floor(load * 200),
      inflight: Math.floor(load * 100),
      p95LatencyMs: Math.floor(load * 4000),
      errorRate: load,
    },
    minMultiplier: endpoint.pricingModel.minMultiplier,
    maxMultiplier: endpoint.pricingModel.maxMultiplier,
  });
  return pricing.priceAtomic;
}

function signableQuotePayload(quote: Omit<MarketQuote, "signature">): Omit<MarketQuote, "signature"> {
  return quote;
}

function initialBadgesForQuote(endpoint: ShopEndpoint, expectedLatencyMs: number, hasAnchorSignals: boolean): Badge[] {
  const badges = new Set<Badge>();
  if (expectedLatencyMs < 800) {
    badges.add("FAST_P95_<800MS");
  }
  if (endpoint.settlementModes.includes("stream")) {
    badges.add("STREAM_READY");
  }
  if (hasAnchorSignals) {
    badges.add("PROOF_ANCHORED");
  }
  return Array.from(badges.values());
}

export class QuoteBook {
  constructor(
    private readonly registry: MarketRegistry,
    private readonly heartbeat: HeartbeatIndex,
    private readonly signer: ReceiptSigner,
    private readonly shopReputation: (shopId: string) => number = () => 0.5,
  ) {}

  list(constraints: QuoteConstraints = {}, rankingWeights: Partial<RankingWeights> = {}): MarketQuote[] {
    const limit = Math.max(1, Math.min(50, constraints.limit ?? 10));
    const now = Date.now();
    const ttlMs = 30_000;

    const found = this.registry.search({
      capability: constraints.capability,
      maxLatencyMs: constraints.maxLatencyMs,
    });

    const unsigned = found.map((item) => {
      const hb = this.heartbeat.get(item.shopId);
      const load = hb?.load ?? 0;
      const basePrice = basePriceForEndpoint(item.endpoint);
      const priced = applyEndpointPricing(item.endpoint, basePrice, load, hb ? {
        queueDepth: hb.queueDepth,
        inflight: hb.inflight,
        p95LatencyMs: hb.p95LatencyMs,
        errorRate: hb.errorRate,
      } : undefined);
      const expectedLatency = hb ? Math.max(item.endpoint.sla.maxLatencyMs, hb.p95LatencyMs) : item.endpoint.sla.maxLatencyMs;

      return {
        quoteId: crypto.randomUUID(),
        shopId: item.shopId,
        endpointId: item.endpoint.endpointId,
        method: item.endpoint.method,
        path: item.endpoint.path,
        capabilityTags: item.endpoint.capabilityTags,
        price: priced,
        mint: constraints.mint ?? "USDC",
        expiresAt: new Date(now + ttlMs).toISOString(),
        expectedLatencyMs: expectedLatency,
        load,
        reputation: this.shopReputation(item.shopId),
        badges: initialBadgesForQuote(item.endpoint, expectedLatency, Boolean(item.endpoint.proofPolicy?.anchor32)),
        settlementModes: item.endpoint.settlementModes,
        rankScore: 0,
      } satisfies Omit<MarketQuote, "signature">;
    });

    const filteredByPrice = constraints.maxPriceAtomic
      ? unsigned.filter((quote) => parseAtomic(quote.price) <= parseAtomic(constraints.maxPriceAtomic!))
      : unsigned;

    const ranked = rankQuotes(filteredByPrice, rankingWeights).slice(0, limit);
    return ranked.map((quote) => {
      const signature = this.signer.signDetached(signableQuotePayload(quote)).signature;
      return {
        ...quote,
        signature,
      };
    });
  }
}

export function verifyQuoteSignature(quote: MarketQuote, signerPubkey: string): boolean {
  const { signature, ...payload } = quote;
  return verifyDetachedSignature(signableQuotePayload(payload), signature, signerPubkey);
}
