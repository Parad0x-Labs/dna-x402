import { z } from "zod";

const flatPricingSchema = z.object({
  kind: z.literal("flat"),
  amountAtomic: z.string().regex(/^\d+$/, "amountAtomic must be integer atomic units"),
});

const meteredPricingSchema = z.object({
  kind: z.literal("metered"),
  unitName: z.string().min(1),
  amountPerUnitAtomic: z.string().regex(/^\d+$/, "amountPerUnitAtomic must be integer atomic units"),
  minUnits: z.number().int().positive().optional(),
});

const surgePricingSchema = z.object({
  kind: z.literal("surge"),
  baseAmountAtomic: z.string().regex(/^\d+$/, "baseAmountAtomic must be integer atomic units"),
  minMultiplier: z.number().positive(),
  maxMultiplier: z.number().positive(),
});

const streamPricingSchema = z.object({
  kind: z.literal("stream"),
  rateAtomicPerSecond: z.string().regex(/^\d+$/, "rateAtomicPerSecond must be integer atomic units"),
  minTopupAtomic: z.string().regex(/^\d+$/, "minTopupAtomic must be integer atomic units").optional(),
});

const nettingPricingSchema = z.object({
  kind: z.literal("netting"),
  unitAmountAtomic: z.string().regex(/^\d+$/, "unitAmountAtomic must be integer atomic units"),
  settlementThresholdAtomic: z.string().regex(/^\d+$/, "settlementThresholdAtomic must be integer atomic units"),
});

export const pricingModelSchema = z.discriminatedUnion("kind", [
  flatPricingSchema,
  meteredPricingSchema,
  surgePricingSchema,
  streamPricingSchema,
  nettingPricingSchema,
]).superRefine((value, ctx) => {
  if (value.kind === "surge" && value.maxMultiplier < value.minMultiplier) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["maxMultiplier"],
      message: "maxMultiplier must be >= minMultiplier",
    });
  }
});

export const endpointSchema = z.object({
  endpointId: z.string().min(1),
  path: z.string().startsWith("/"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  capabilityTags: z.array(z.string().min(1)).min(1),
  description: z.string().min(1),
  pricingModel: pricingModelSchema,
  settlementModes: z.array(z.enum(["transfer", "stream", "netting"])).min(1),
  expectedLatencyMs: z.number().int().positive().default(1000),
  reputationScore: z.number().min(0).max(1).default(0.5),
});

export const shopManifestSchema = z.object({
  shopId: z.string().min(1),
  name: z.string().min(1),
  ownerAddress: z.string().min(32),
  endpoints: z.array(endpointSchema).min(1),
});

export type ShopManifest = z.infer<typeof shopManifestSchema>;
export type ShopEndpointManifest = z.infer<typeof endpointSchema>;
