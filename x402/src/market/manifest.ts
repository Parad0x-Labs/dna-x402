import crypto from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { z } from "zod";
import { pricingModelSchema } from "../manifest/schema.js";
import { ShopManifest, SignedShopManifest } from "./types.js";

const endpointSchema = z.object({
  endpointId: z.string().min(1),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().startsWith("/"),
  capabilityTags: z.array(z.string().min(1)).min(1),
  description: z.string().min(1),
  pricingModel: pricingModelSchema,
  settlementModes: z.array(z.enum(["transfer", "stream", "netting"])).min(1),
  icon: z.string().min(1).optional(),
  examples: z.array(z.string().min(1)).optional(),
  requestSchema: z.unknown().optional(),
  responseSchema: z.unknown().optional(),
  sla: z.object({
    maxLatencyMs: z.number().int().positive(),
    availabilityTarget: z.number().min(0).max(1),
  }),
  pricingParams: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  limits: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  proofPolicy: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export const manifestSchema = z.object({
  manifestVersion: z.literal("market-v1").default("market-v1"),
  shopId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  ownerPubkey: z.string().min(32),
  endpoints: z.array(endpointSchema).min(1),
});

export const signedManifestSchema = z.object({
  manifest: manifestSchema,
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/i, "manifestHash must be 32-byte hex"),
  signature: z.string().min(32),
  publishedAt: z.string().datetime(),
});

export class ManifestValidationError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
    this.name = "ManifestValidationError";
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "manifest";
    return `${path}: ${issue.message}`;
  });
}

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

function hashHex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function hashManifest(manifest: ShopManifest): string {
  return hashHex(stableStringify(manifest));
}

export function validateManifest(manifest: unknown): ShopManifest {
  const parsed = manifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw new ManifestValidationError("Invalid manifest", formatIssues(parsed.error));
  }

  const endpointIds = new Set<string>();
  for (const endpoint of parsed.data.endpoints) {
    if (endpointIds.has(endpoint.endpointId)) {
      throw new ManifestValidationError("Invalid manifest", [
        `endpoints.${endpoint.endpointId}: duplicate endpointId`,
      ]);
    }
    endpointIds.add(endpoint.endpointId);
  }

  return parsed.data as ShopManifest;
}

export function validateSignedManifest(signed: unknown): SignedShopManifest {
  const parsed = signedManifestSchema.safeParse(signed);
  if (!parsed.success) {
    throw new ManifestValidationError("Invalid signed manifest", formatIssues(parsed.error));
  }

  return parsed.data as SignedShopManifest;
}

export function verifyManifestSignature(signed: SignedShopManifest): boolean {
  const expectedHash = hashManifest(signed.manifest);
  if (expectedHash !== signed.manifestHash.toLowerCase()) {
    return false;
  }

  const pubkey = bs58.decode(signed.manifest.ownerPubkey);
  const signature = bs58.decode(signed.signature);
  return nacl.sign.detached.verify(Buffer.from(expectedHash, "hex"), signature, pubkey);
}

export function createSignedManifest(manifest: ShopManifest, ownerSecretKeyBase58: string, publishedAt = new Date()): SignedShopManifest {
  const ownerSecret = bs58.decode(ownerSecretKeyBase58);
  if (ownerSecret.length !== 64) {
    throw new Error("owner secret key must be 64-byte base58 ed25519 secret key");
  }

  const manifestHash = hashManifest(manifest);
  const signature = nacl.sign.detached(Buffer.from(manifestHash, "hex"), ownerSecret);
  return {
    manifest,
    manifestHash,
    signature: bs58.encode(signature),
    publishedAt: publishedAt.toISOString(),
  };
}
