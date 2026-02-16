import { parseAtomic } from "../feePolicy.js";
import { ShopEndpointManifest, ShopManifest } from "../manifest/schema.js";
import { SettlementMode } from "../types.js";

export interface ShopHeartbeat {
  shopId: string;
  queueDepth: number;
  inflight: number;
  p95LatencyMs: number;
  updatedAtMs: number;
}

export interface SearchOptions {
  capability?: string;
  maxPriceAtomic?: string;
  maxLatencyMs?: number;
}

export interface SearchResult {
  shopId: string;
  shopName: string;
  ownerAddress: string;
  endpointId: string;
  path: string;
  method: string;
  capabilityTags: string[];
  description: string;
  settlementModes: SettlementMode[];
  expectedLatencyMs: number;
  reputationScore: number;
  basePriceAtomic: string;
  heartbeat?: ShopHeartbeat;
}

export function estimateBaseEndpointPriceAtomic(endpoint: ShopEndpointManifest): bigint {
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

function matchCapability(endpoint: ShopEndpointManifest, capability?: string): boolean {
  if (!capability) {
    return true;
  }
  return endpoint.capabilityTags.includes(capability);
}

export class MarketplaceStore {
  private readonly shops = new Map<string, ShopManifest>();
  private readonly heartbeats = new Map<string, ShopHeartbeat>();

  registerShop(manifest: ShopManifest): void {
    this.shops.set(manifest.shopId, manifest);
  }

  listShops(): ShopManifest[] {
    return Array.from(this.shops.values());
  }

  getShop(shopId: string): ShopManifest | undefined {
    return this.shops.get(shopId);
  }

  setHeartbeat(heartbeat: Omit<ShopHeartbeat, "updatedAtMs">, updatedAtMs = Date.now()): ShopHeartbeat {
    const value: ShopHeartbeat = {
      ...heartbeat,
      updatedAtMs,
    };
    this.heartbeats.set(heartbeat.shopId, value);
    return value;
  }

  getHeartbeat(shopId: string): ShopHeartbeat | undefined {
    return this.heartbeats.get(shopId);
  }

  search(options: SearchOptions = {}): SearchResult[] {
    const maxPrice = options.maxPriceAtomic ? parseAtomic(options.maxPriceAtomic) : null;

    const result: SearchResult[] = [];
    for (const shop of this.shops.values()) {
      const heartbeat = this.heartbeats.get(shop.shopId);
      for (const endpoint of shop.endpoints) {
        if (!matchCapability(endpoint, options.capability)) {
          continue;
        }
        if (options.maxLatencyMs && endpoint.expectedLatencyMs > options.maxLatencyMs) {
          continue;
        }

        const basePrice = estimateBaseEndpointPriceAtomic(endpoint);
        if (maxPrice !== null && basePrice > maxPrice) {
          continue;
        }

        result.push({
          shopId: shop.shopId,
          shopName: shop.name,
          ownerAddress: shop.ownerAddress,
          endpointId: endpoint.endpointId,
          path: endpoint.path,
          method: endpoint.method,
          capabilityTags: [...endpoint.capabilityTags],
          description: endpoint.description,
          settlementModes: [...endpoint.settlementModes],
          expectedLatencyMs: endpoint.expectedLatencyMs,
          reputationScore: endpoint.reputationScore,
          basePriceAtomic: basePrice.toString(10),
          heartbeat,
        });
      }
    }

    return result;
  }
}
