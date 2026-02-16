import { deriveLoadFactor } from "../pricing/surge.js";
import { ShopHeartbeat } from "./types.js";

export interface HeartbeatInput {
  shopId: string;
  inflight: number;
  queueDepth: number;
  p95LatencyMs: number;
  errorRate: number;
}

export class HeartbeatIndex {
  private readonly byShop = new Map<string, ShopHeartbeat>();

  upsert(input: HeartbeatInput, now = new Date()): ShopHeartbeat {
    const load = deriveLoadFactor({
      inflight: input.inflight,
      queueDepth: input.queueDepth,
      p95LatencyMs: input.p95LatencyMs,
      errorRate: input.errorRate,
    });

    const heartbeat: ShopHeartbeat = {
      shopId: input.shopId,
      inflight: input.inflight,
      queueDepth: input.queueDepth,
      p95LatencyMs: input.p95LatencyMs,
      errorRate: input.errorRate,
      updatedAt: now.toISOString(),
      load,
    };

    this.byShop.set(input.shopId, heartbeat);
    return heartbeat;
  }

  get(shopId: string): ShopHeartbeat | undefined {
    return this.byShop.get(shopId);
  }

  list(): ShopHeartbeat[] {
    return Array.from(this.byShop.values()).sort((a, b) => a.shopId.localeCompare(b.shopId));
  }
}
