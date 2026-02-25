import bs58 from "bs58";
import nacl from "tweetnacl";
import { createSignedManifest } from "../src/market/manifest.js";
import { ShopManifest, SignedShopManifest } from "../src/market/types.js";

export function makeSignedShop(params: {
  shopId: string;
  capability: string;
  category?: "ai_inference" | "image_generation" | "data_enrichment" | "workflow_tool";
  name?: string;
  description?: string;
  extraTags?: string[];
  endpointId?: string;
  path?: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  priceAtomic?: string;
  pricingModel?: ShopManifest["endpoints"][number]["pricingModel"];
  settlementModes?: ShopManifest["endpoints"][number]["settlementModes"];
  maxLatencyMs?: number;
  availabilityTarget?: number;
}): SignedShopManifest {
  const kp = nacl.sign.keyPair();
  const ownerPubkey = bs58.encode(kp.publicKey);
  const ownerSecret = bs58.encode(kp.secretKey);

  const manifest: ShopManifest = {
    manifestVersion: "market-v1",
    shopId: params.shopId,
    name: params.name ?? `${params.shopId} Shop`,
    ...(params.description ? { description: params.description } : {}),
    category: params.category ?? "ai_inference",
    ownerPubkey,
    endpoints: [
      {
        endpointId: params.endpointId ?? `${params.shopId}-endpoint`,
        method: params.method ?? "POST",
        path: params.path ?? "/tool",
        capabilityTags: [params.capability, ...(params.extraTags ?? [])],
        description: `${params.capability} endpoint`,
        pricingModel: params.pricingModel ?? {
          kind: "flat",
          amountAtomic: params.priceAtomic ?? "1000",
        },
        settlementModes: params.settlementModes ?? ["transfer", "stream", "netting"],
        sla: {
          maxLatencyMs: params.maxLatencyMs ?? 1200,
          availabilityTarget: params.availabilityTarget ?? 0.995,
        },
      },
    ],
  };

  return createSignedManifest(manifest, ownerSecret);
}
