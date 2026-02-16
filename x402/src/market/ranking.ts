import { parseAtomic } from "../feePolicy.js";

export interface RankingWeights {
  price: number;
  latency: number;
  reputation: number;
}

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  price: 0.5,
  latency: 0.3,
  reputation: 0.2,
};

export interface RankableQuote {
  price: string;
  expectedLatencyMs: number;
  reputation: number;
}

function normalizeWeights(weights: Partial<RankingWeights> = {}): RankingWeights {
  const merged = {
    ...DEFAULT_RANKING_WEIGHTS,
    ...weights,
  };

  const total = merged.price + merged.latency + merged.reputation;
  if (total <= 0) {
    return DEFAULT_RANKING_WEIGHTS;
  }

  return {
    price: merged.price / total,
    latency: merged.latency / total,
    reputation: merged.reputation / total,
  };
}

function normalizeScore(value: number, min: number, max: number, invert = false): number {
  if (max <= min) {
    return 1;
  }
  const normalized = (value - min) / (max - min);
  return invert ? 1 - normalized : normalized;
}

export function rankQuotes<T extends RankableQuote>(
  quotes: T[],
  weights: Partial<RankingWeights> = {},
): Array<T & { rankScore: number }> {
  const normalizedWeights = normalizeWeights(weights);
  const prices = quotes.map((quote) => Number(parseAtomic(quote.price)));
  const latency = quotes.map((quote) => quote.expectedLatencyMs);

  const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
  const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;
  const minLatency = latency.length > 0 ? Math.min(...latency) : 0;
  const maxLatency = latency.length > 0 ? Math.max(...latency) : 0;

  return quotes
    .map((quote) => {
      const priceScore = normalizeScore(Number(parseAtomic(quote.price)), minPrice, maxPrice, true);
      const latencyScore = normalizeScore(quote.expectedLatencyMs, minLatency, maxLatency, true);
      const reputationScore = Math.max(0, Math.min(1, quote.reputation));
      const rankScore =
        priceScore * normalizedWeights.price +
        latencyScore * normalizedWeights.latency +
        reputationScore * normalizedWeights.reputation;
      return {
        ...quote,
        rankScore,
      };
    })
    .sort((a, b) => b.rankScore - a.rankScore);
}
