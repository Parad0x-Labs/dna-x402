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
  private readonly disabledShops = new Set<string>();

  register(signedManifest: SignedShopManifest): ShopManifest {
    if (!verifyManifestSignature(signedManifest)) {
      throw new Error("Invalid manifest signature");
    }
    this.manifests.set(signedManifest.manifest.shopId, signedManifest);
    return signedManifest.manifest;
  }

  setDisabledShops(shopIds: Iterable<string>): void {
    this.disabledShops.clear();
    for (const shopId of shopIds) {
      if (shopId.trim().length > 0) {
        this.disabledShops.add(shopId.trim());
      }
    }
  }

  disable(shopId: string): void {
    if (shopId.trim().length === 0) {
      return;
    }
    this.disabledShops.add(shopId.trim());
  }

  enable(shopId: string): void {
    this.disabledShops.delete(shopId.trim());
  }

  isDisabled(shopId: string): boolean {
    return this.disabledShops.has(shopId.trim());
  }

  list(includeDisabled = false): ShopManifest[] {
    return Array.from(this.manifests.values())
      .filter((entry) => includeDisabled || !this.isDisabled(entry.manifest.shopId))
      .map((entry) => entry.manifest);
  }

  get(shopId: string, includeDisabled = false): ShopManifest | undefined {
    const manifest = this.manifests.get(shopId)?.manifest;
    if (!manifest) {
      return undefined;
    }
    if (!includeDisabled && this.isDisabled(shopId)) {
      return undefined;
    }
    return manifest;
  }

  getSigned(shopId: string, includeDisabled = false): SignedShopManifest | undefined {
    const signed = this.manifests.get(shopId);
    if (!signed) {
      return undefined;
    }
    if (!includeDisabled && this.isDisabled(shopId)) {
      return undefined;
    }
    return signed;
  }

  search(query: MarketSearchQuery = {}): RegistrySearchResult[] {
    const maxPrice = query.maxPriceAtomic ? parseAtomic(query.maxPriceAtomic) : null;
    const results: RegistrySearchResult[] = [];

    for (const signed of this.manifests.values()) {
      if (this.isDisabled(signed.manifest.shopId)) {
        continue;
      }
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
