import { z } from "zod";
import { MarketEvent } from "./types.js";

export const marketEventSchema = z.object({
  type: z.enum(["QUOTE_ISSUED", "PAYMENT_VERIFIED", "REQUEST_FULFILLED", "REQUEST_FAILED", "REFUND_ISSUED", "BUNDLE_RUN", "BUNDLE_STEP_EXECUTED"]),
  ts: z.string().datetime(),
  shopId: z.string().min(1),
  endpointId: z.string().min(1),
  capabilityTags: z.array(z.string()).default([]),
  priceAmount: z.string().regex(/^\d+$/),
  mint: z.string().min(1),
  settlementMode: z.enum(["transfer", "stream", "netting"]).optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  statusCode: z.number().int().optional(),
  receiptId: z.string().optional(),
  anchor32: z.string().optional(),
  anchored: z.boolean().optional(),
  receiptValid: z.boolean().optional(),
  verificationTier: z.enum(["FAST", "VERIFIED"]).optional(),
  ownerPubkey: z.string().optional(),
  bundleId: z.string().optional(),
  upstreamCostAmount: z.string().regex(/^\d+$/).optional(),
  netRevenueAmount: z.string().regex(/^\d+$/).optional(),
});

export function validateMarketEvent(event: unknown): MarketEvent {
  return marketEventSchema.parse(event) as MarketEvent;
}

export function createMarketEvent(event: Omit<MarketEvent, "ts">, now = new Date()): MarketEvent {
  return {
    ...event,
    ts: now.toISOString(),
  };
}
