import crypto from "node:crypto";
import { parseAtomic } from "../feePolicy.js";
import { ReceiptSigner, verifyDetachedSignature } from "../receipts.js";
import { applySurgePricing, deriveLoadFactor } from "../pricing/surge.js";
import { CompetitiveQuote } from "../types.js";
import { MarketplaceStore, SearchOptions, SearchResult } from "./store.js";

export interface QuoteWeights {
  price: number;
  latency: number;
  reputation: number;
}

export interface QuoteQuery extends SearchOptions {
  limit?: number;
  mint?: string;
  ttlSeconds?: number;
  weights?: Partial<QuoteWeights>;
}

export interface RankedQuote extends CompetitiveQuote {
  rankScore: number;
}

const defaultWeights: QuoteWeights = {
  price: 0.55,
  latency: 0.25,
  reputation: 0.2,
};

function normalizeWeights(weights?: Partial<QuoteWeights>): QuoteWeights {
  const merged: QuoteWeights = {
    ...defaultWeights,
    ...weights,
  };
  const total = merged.price + merged.latency + merged.reputation;
  if (total <= 0) {
    return defaultWeights;
  }
  return {
    price: merged.price / total,
    latency: merged.latency / total,
    reputation: merged.reputation / total,
  };
}

function scoreQuote(quote: SearchResult, priceAtomic: bigint, allPrices: bigint[], allLatency: number[], weights: QuoteWeights): number {
  const minPrice = allPrices.length > 0 ? Number(allPrices.reduce((a, b) => (a < b ? a : b))) : Number(priceAtomic);
  const maxPrice = allPrices.length > 0 ? Number(allPrices.reduce((a, b) => (a > b ? a : b))) : Number(priceAtomic);
  const priceDenominator = Math.max(1, maxPrice - minPrice);
  const priceScore = 1 - (Number(priceAtomic) - minPrice) / priceDenominator;

  const minLatency = allLatency.length > 0 ? Math.min(...allLatency) : quote.expectedLatencyMs;
  const maxLatency = allLatency.length > 0 ? Math.max(...allLatency) : quote.expectedLatencyMs;
  const latencyDenominator = Math.max(1, maxLatency - minLatency);
  const latencyScore = 1 - (quote.expectedLatencyMs - minLatency) / latencyDenominator;

  const reputationScore = Math.max(0, Math.min(1, quote.reputationScore));
  return (
    priceScore * weights.price +
    latencyScore * weights.latency +
    reputationScore * weights.reputation
  );
}

function buildQuotedPriceAtomic(candidate: SearchResult): { priceAtomic: string; loadFactor: number } {
  if (!candidate.heartbeat) {
    return { priceAtomic: candidate.basePriceAtomic, loadFactor: 0 };
  }

  const loadFactor = deriveLoadFactor(candidate.heartbeat);
  const surged = applySurgePricing({
    basePriceAtomic: candidate.basePriceAtomic,
    load: candidate.heartbeat,
    minMultiplier: 0.8,
    maxMultiplier: 2.8,
  });

  return {
    priceAtomic: surged.priceAtomic,
    loadFactor,
  };
}

function signedPayload(quote: Omit<RankedQuote, "quoteSig">): Omit<RankedQuote, "quoteSig"> {
  return quote;
}

export class QuoteEngine {
  constructor(
    private readonly store: MarketplaceStore,
    private readonly signer: ReceiptSigner,
    private readonly quoteRecipientByShop: (shopId: string) => string,
  ) {}

  getQuotes(query: QuoteQuery): RankedQuote[] {
    const limit = Math.max(1, Math.min(25, query.limit ?? 5));
    const ttlSeconds = Math.max(5, Math.min(300, query.ttlSeconds ?? 30));
    const weights = normalizeWeights(query.weights);
    const mint = query.mint ?? "USDC";

    const candidates = this.store.search({
      capability: query.capability,
      maxLatencyMs: query.maxLatencyMs,
    });
    const candidatePrices = candidates.map((candidate) => parseAtomic(buildQuotedPriceAtomic(candidate).priceAtomic));
    const candidateLatencies = candidates.map((candidate) => candidate.expectedLatencyMs);

    const ranked = candidates.map((candidate) => {
      const { priceAtomic, loadFactor } = buildQuotedPriceAtomic(candidate);
      const parsedPrice = parseAtomic(priceAtomic);

      const quoteBase: Omit<RankedQuote, "quoteSig"> = {
        quoteId: crypto.randomUUID(),
        shopId: candidate.shopId,
        endpointId: candidate.endpointId,
        capabilityTags: candidate.capabilityTags,
        priceAtomic,
        mint,
        recipient: this.quoteRecipientByShop(candidate.shopId),
        settlementModes: candidate.settlementModes,
        expectedLatencyMs: candidate.expectedLatencyMs,
        reputationScore: candidate.reputationScore,
        loadFactor,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
        rankScore: scoreQuote(candidate, parsedPrice, candidatePrices, candidateLatencies, weights),
      };

      const quoteSig = this.signer.signDetached(signedPayload(quoteBase)).signature;
      return {
        ...quoteBase,
        quoteSig,
      };
    });

    const filteredByPrice = query.maxPriceAtomic
      ? ranked.filter((quote) => parseAtomic(quote.priceAtomic) <= parseAtomic(query.maxPriceAtomic!))
      : ranked;

    return filteredByPrice
      .sort((a, b) => b.rankScore - a.rankScore)
      .slice(0, limit);
  }
}

export function verifyCompetitiveQuote(quote: RankedQuote, signerPublicKey: string): boolean {
  const { quoteSig, ...payload } = quote;
  return verifyDetachedSignature(signedPayload(payload), quoteSig, signerPublicKey);
}
