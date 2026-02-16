import { Badge, MarketEvent, ShopEndpoint, ShopHeartbeat } from "./types.js";

const BADGE_ORDER: Badge[] = [
  "FAST_P95_<800MS",
  "FULFILLMENT_99",
  "LOW_REFUND",
  "STREAM_READY",
  "PROOF_ANCHORED",
  "TOP_SELLER_24H",
];

function endpointKey(shopId: string, endpointId: string): string {
  return `${shopId}::${endpointId}`;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

export function computeEndpointBadges(params: {
  shopId: string;
  endpoint: ShopEndpoint;
  events: MarketEvent[];
  heartbeat?: ShopHeartbeat;
  topSellerKeys?: Set<string>;
}): Badge[] {
  const key = endpointKey(params.shopId, params.endpoint.endpointId);
  const endpointEvents = params.events.filter((event) => event.shopId === params.shopId && event.endpointId === params.endpoint.endpointId);
  const requestEvents = endpointEvents.filter((event) => event.type === "REQUEST_FULFILLED" || event.type === "REQUEST_FAILED");
  const fulfilled = requestEvents.filter((event) => event.type === "REQUEST_FULFILLED").length;
  const failed = requestEvents.filter((event) => event.type === "REQUEST_FAILED").length;
  const requests = fulfilled + failed;
  const fulfillmentRate = requests === 0 ? 1 : fulfilled / requests;

  const refunds = endpointEvents.filter((event) => event.type === "REFUND_ISSUED").length;
  const refundRate = fulfilled === 0 ? 0 : refunds / fulfilled;

  const latencies = endpointEvents
    .filter((event) => event.type === "REQUEST_FULFILLED" && typeof event.latencyMs === "number")
    .map((event) => event.latencyMs as number);
  const p95 = latencies.length > 0 ? percentile(latencies, 95) : (params.heartbeat?.p95LatencyMs ?? Number.POSITIVE_INFINITY);

  const hasAnchoredProof = endpointEvents.some((event) => event.type === "PAYMENT_VERIFIED" && Boolean(event.anchor32));

  const badges = new Set<Badge>();

  if (p95 < 800) {
    badges.add("FAST_P95_<800MS");
  }
  if (requests >= 10 && fulfillmentRate >= 0.99) {
    badges.add("FULFILLMENT_99");
  }
  if (fulfilled >= 10 && refundRate <= 0.01) {
    badges.add("LOW_REFUND");
  }
  if (params.endpoint.settlementModes.includes("stream")) {
    badges.add("STREAM_READY");
  }
  if (hasAnchoredProof) {
    badges.add("PROOF_ANCHORED");
  }
  if (params.topSellerKeys?.has(key)) {
    badges.add("TOP_SELLER_24H");
  }

  return BADGE_ORDER.filter((badge) => badges.has(badge));
}

export function computeShopBadges(params: {
  shopId: string;
  endpoints: ShopEndpoint[];
  events: MarketEvent[];
  heartbeat?: ShopHeartbeat;
  topSellerKeys?: Set<string>;
}): Record<string, Badge[]> {
  const result: Record<string, Badge[]> = {};
  for (const endpoint of params.endpoints) {
    result[endpoint.endpointId] = computeEndpointBadges({
      shopId: params.shopId,
      endpoint,
      events: params.events,
      heartbeat: params.heartbeat,
      topSellerKeys: params.topSellerKeys,
    });
  }
  return result;
}
