import { parseAtomic } from "../feePolicy.js";
import { verifyManifestSignature } from "./manifest.js";
import { MarketSearchQuery, ShopManifest, ShopEndpoint, SignedShopManifest } from "./types.js";

export interface RegistrySearchResult {
  shopId: string;
  shopName: string;
  category?: string;
  ownerPubkey: string;
  endpoint: ShopEndpoint;
  basePriceAtomic: string;
}

function baseEndpointPriceAtomic(endpoint: ShopEndpoint): bigint {
  switch (endpoint.pricingModel.kind) {
    case "flat":
      return parseAtomic(endpoint.pricingModel.amountAtomic);
    case "metered":
      return parseAtomic(endpoint.pricingModel.amountPerUnitAtomic) * BigInt(endpoint.pricingModel.minUnits ?? 1);
    case "surge":
      return parseAtomic(endpoint.pricingModel.baseAmountAtomic);
    case "stream":
      return parseAtomic(endpoint.pricingModel.minTopupAtomic ?? endpoint.pricingModel.rateAtomicPerSecond);
    case "netting":
      return parseAtomic(endpoint.pricingModel.unitAmountAtomic);
    default:
      return 0n;
  }
}

export class MarketRegistry {
  private readonly manifests = new Map<string, SignedShopManifest>();

  register(signedManifest: SignedShopManifest): ShopManifest {
    if (!verifyManifestSignature(signedManifest)) {
      throw new Error("Invalid manifest signature");
    }
    this.manifests.set(signedManifest.manifest.shopId, signedManifest);
    return signedManifest.manifest;
  }

  list(): ShopManifest[] {
    return Array.from(this.manifests.values()).map((entry) => entry.manifest);
  }

  get(shopId: string): ShopManifest | undefined {
    return this.manifests.get(shopId)?.manifest;
  }

  getSigned(shopId: string): SignedShopManifest | undefined {
    return this.manifests.get(shopId);
  }

  search(query: MarketSearchQuery = {}): RegistrySearchResult[] {
    const maxPrice = query.maxPriceAtomic ? parseAtomic(query.maxPriceAtomic) : null;
    const results: RegistrySearchResult[] = [];

    for (const signed of this.manifests.values()) {
      for (const endpoint of signed.manifest.endpoints) {
        if (query.capability && !endpoint.capabilityTags.includes(query.capability)) {
          continue;
        }
        if (query.maxLatencyMs && endpoint.sla.maxLatencyMs > query.maxLatencyMs) {
          continue;
        }
        const basePrice = baseEndpointPriceAtomic(endpoint);
        if (maxPrice && basePrice > maxPrice) {
          continue;
        }

        results.push({
          shopId: signed.manifest.shopId,
          shopName: signed.manifest.name,
          category: signed.manifest.category,
          ownerPubkey: signed.manifest.ownerPubkey,
          endpoint,
          basePriceAtomic: basePrice.toString(10),
        });
      }
    }

    return results;
  }
}
