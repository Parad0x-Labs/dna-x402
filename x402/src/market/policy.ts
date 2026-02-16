import { z } from "zod";
import { parseAtomic } from "../feePolicy.js";
import { MarketQuote } from "./types.js";

export const marketPolicySchema = z.object({
  capability: z.string().min(1),
  maxPrice: z.number().positive().optional(),
  maxLatencyMs: z.number().int().positive().optional(),
  prefer: z.array(z.enum(["on_sale", "trending", "high_reputation", "lowest_price"])) .optional(),
  fallback: z.object({
    waitUntilPrice: z.number().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    routeNext: z.boolean().optional(),
  }).optional(),
  settlement: z.object({
    preferStream: z.boolean().optional(),
    allowNetting: z.boolean().optional(),
  }).optional(),
  budget: z.object({
    maxPerCall: z.number().positive().optional(),
    maxPerDay: z.number().positive().optional(),
  }).optional(),
});

export type MarketPolicy = z.infer<typeof marketPolicySchema>;

function toAtomic(value?: number): bigint | undefined {
  if (typeof value !== "number") {
    return undefined;
  }
  return BigInt(Math.round(value));
}

function policyScore(quote: MarketQuote, prefer: MarketPolicy["prefer"]): number {
  if (!prefer || prefer.length === 0) {
    return quote.rankScore;
  }

  let score = quote.rankScore;
  for (const pref of prefer) {
    switch (pref) {
      case "lowest_price":
        score += 1 / Math.max(1, Number(parseAtomic(quote.price)));
        break;
      case "high_reputation":
        score += quote.reputation;
        break;
      case "on_sale":
        score += quote.badges?.includes("TOP_SELLER_24H") ? 0.1 : 0;
        break;
      case "trending":
        score += quote.badges?.includes("TOP_SELLER_24H") ? 0.2 : 0;
        break;
      default:
        break;
    }
  }

  return score;
}

export function selectQuoteByPolicy(quotes: MarketQuote[], policyInput: MarketPolicy): MarketQuote | undefined {
  const policy = marketPolicySchema.parse(policyInput);

  const maxPerCall = toAtomic(policy.budget?.maxPerCall);
  const maxPrice = toAtomic(policy.maxPrice);

  const filtered = quotes.filter((quote) => {
    const price = parseAtomic(quote.price);
    if (maxPrice !== undefined && price > maxPrice) {
      return false;
    }
    if (maxPerCall !== undefined && price > maxPerCall) {
      return false;
    }
    if (policy.maxLatencyMs && quote.expectedLatencyMs > policy.maxLatencyMs) {
      return false;
    }
    if (policy.settlement?.preferStream && !quote.settlementModes.includes("stream")) {
      return false;
    }
    if (policy.settlement?.allowNetting === false && quote.settlementModes.includes("netting")) {
      return false;
    }
    return true;
  });

  return filtered.sort((a, b) => policyScore(b, policy.prefer) - policyScore(a, policy.prefer))[0];
}

export function quoteQueryFromPolicy(policyInput: MarketPolicy): URLSearchParams {
  const policy = marketPolicySchema.parse(policyInput);
  const params = new URLSearchParams();
  params.set("capability", policy.capability);
  if (policy.maxPrice) {
    params.set("maxPrice", Math.round(policy.maxPrice).toString(10));
  }
  if (policy.maxLatencyMs) {
    params.set("maxLatencyMs", policy.maxLatencyMs.toString(10));
  }
  params.set("limit", "20");
  return params;
}
