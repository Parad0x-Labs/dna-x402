import crypto from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { z } from "zod";
import { parseAtomic } from "../feePolicy.js";
import { QuoteBook } from "./quotes.js";
import { BundleManifest, SignedBundleManifest } from "./types.js";

const bundleStepSchema = z.object({
  capability: z.string().min(1),
  constraints: z.object({
    maxPriceAtomic: z.string().regex(/^\d+$/).optional(),
    maxLatencyMs: z.number().int().positive().optional(),
  }).optional(),
  policyOverrides: z.object({
    prefer: z.array(z.enum(["on_sale", "trending", "high_reputation", "lowest_price"])) .optional(),
    preferSettlement: z.enum(["transfer", "stream", "netting"]).optional(),
  }).optional(),
});

const bundlePriceModelSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("flat"),
    amountAtomic: z.string().regex(/^\d+$/),
  }),
  z.object({
    kind: z.literal("metered"),
    amountPerRunAtomic: z.string().regex(/^\d+$/),
  }),
]);

const marginPolicySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("percent"),
    value: z.number().min(0).max(100),
  }),
  z.object({
    kind: z.literal("fixed_atomic"),
    value: z.string().regex(/^\d+$/),
  }),
]);

export const bundleManifestSchema = z.object({
  bundleId: z.string().min(1),
  ownerPubkey: z.string().min(32),
  name: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(bundleStepSchema).min(1),
  bundlePriceModel: bundlePriceModelSchema,
  marginPolicy: marginPolicySchema,
  examples: z.array(z.string().min(1)).optional(),
});

export const signedBundleManifestSchema = z.object({
  manifest: bundleManifestSchema,
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/i),
  signature: z.string().min(32),
  publishedAt: z.string().datetime(),
});

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

export function hashBundleManifest(manifest: BundleManifest): string {
  return crypto.createHash("sha256").update(stableStringify(manifest)).digest("hex");
}

export function validateBundleManifest(manifest: unknown): BundleManifest {
  return bundleManifestSchema.parse(manifest) as BundleManifest;
}

export function validateSignedBundleManifest(signed: unknown): SignedBundleManifest {
  return signedBundleManifestSchema.parse(signed) as SignedBundleManifest;
}

export function verifyBundleSignature(signed: SignedBundleManifest): boolean {
  const expectedHash = hashBundleManifest(signed.manifest);
  if (expectedHash !== signed.manifestHash.toLowerCase()) {
    return false;
  }
  const signature = bs58.decode(signed.signature);
  const pubkey = bs58.decode(signed.manifest.ownerPubkey);
  return nacl.sign.detached.verify(Buffer.from(expectedHash, "hex"), signature, pubkey);
}

export function createSignedBundleManifest(manifest: BundleManifest, ownerSecretKeyBase58: string, publishedAt = new Date()): SignedBundleManifest {
  const ownerSecret = bs58.decode(ownerSecretKeyBase58);
  if (ownerSecret.length !== 64) {
    throw new Error("owner secret key must be 64-byte base58 ed25519 secret key");
  }
  const manifestHash = hashBundleManifest(manifest);
  const signature = nacl.sign.detached(Buffer.from(manifestHash, "hex"), ownerSecret);
  return {
    manifest,
    manifestHash,
    signature: bs58.encode(signature),
    publishedAt: publishedAt.toISOString(),
  };
}

export class BundleRegistry {
  private readonly bundles = new Map<string, SignedBundleManifest>();

  register(signedBundle: SignedBundleManifest): BundleManifest {
    if (!verifyBundleSignature(signedBundle)) {
      throw new Error("Invalid bundle signature");
    }
    this.bundles.set(signedBundle.manifest.bundleId, signedBundle);
    return signedBundle.manifest;
  }

  list(): BundleManifest[] {
    return Array.from(this.bundles.values()).map((item) => item.manifest);
  }

  get(bundleId: string): BundleManifest | undefined {
    return this.bundles.get(bundleId)?.manifest;
  }

  getSigned(bundleId: string): SignedBundleManifest | undefined {
    return this.bundles.get(bundleId);
  }

  costBreakdown(quoteBook: QuoteBook, bundleId: string): {
    estimatedUpstreamCostAtomic: string;
    expectedBundlePriceAtomic: string;
    expectedMarginAtomic: string;
  } | undefined {
    const bundle = this.get(bundleId);
    if (!bundle) {
      return undefined;
    }

    let upstream = 0n;
    for (const step of bundle.steps) {
      const quote = quoteBook.list({
        capability: step.capability,
        maxPriceAtomic: step.constraints?.maxPriceAtomic,
        maxLatencyMs: step.constraints?.maxLatencyMs,
        limit: 1,
      })[0];
      if (quote) {
        upstream += parseAtomic(quote.price);
      }
    }

    const bundlePrice = bundle.bundlePriceModel.kind === "flat"
      ? parseAtomic(bundle.bundlePriceModel.amountAtomic)
      : parseAtomic(bundle.bundlePriceModel.amountPerRunAtomic);

    const margin = bundle.marginPolicy.kind === "fixed_atomic"
      ? parseAtomic(bundle.marginPolicy.value)
      : (upstream * BigInt(Math.round(bundle.marginPolicy.value * 100)) / 10_000n);

    const expectedBundlePrice = bundlePrice > upstream ? bundlePrice : upstream + margin;
    const expectedMargin = expectedBundlePrice > upstream ? expectedBundlePrice - upstream : 0n;

    return {
      estimatedUpstreamCostAtomic: upstream.toString(10),
      expectedBundlePriceAtomic: expectedBundlePrice.toString(10),
      expectedMarginAtomic: expectedMargin.toString(10),
    };
  }
}
