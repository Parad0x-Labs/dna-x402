import { deriveLoadFactor } from "../pricing/surge.js";
import { MarketplaceStore, ShopHeartbeat } from "./store.js";

export interface ShopLoadReport {
  shopId: string;
  queueDepth: number;
  inflight: number;
  p95LatencyMs: number;
}

export interface ShopLoadSnapshot extends ShopHeartbeat {
  loadFactor: number;
}

export class MarketplaceHeartbeatService {
  constructor(private readonly store: MarketplaceStore) {}

  report(load: ShopLoadReport, nowMs = Date.now()): ShopLoadSnapshot {
    const heartbeat = this.store.setHeartbeat(load, nowMs);
    return {
      ...heartbeat,
      loadFactor: deriveLoadFactor(heartbeat),
    };
  }

  get(shopId: string): ShopLoadSnapshot | undefined {
    const heartbeat = this.store.getHeartbeat(shopId);
    if (!heartbeat) {
      return undefined;
    }
    return {
      ...heartbeat,
      loadFactor: deriveLoadFactor(heartbeat),
    };
  }
}
