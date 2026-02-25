import { MarketEvent } from "./types.js";

export interface ReputationScore {
  sellerScore: number;
  endpointScore: number;
  reputationTier: "bronze" | "silver" | "gold";
  reportCount: number;
  anchoredReceiptsCount: number;
  disputeCount: number;
  uptimeHeartbeatPct: number;
  warning: boolean;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

function toTier(score: number): "bronze" | "silver" | "gold" {
  if (score >= 85) {
    return "gold";
  }
  if (score >= 65) {
    return "silver";
  }
  return "bronze";
}

function latencyScore(latencies: number[]): number {
  if (latencies.length === 0) {
    return 50;
  }
  const p95 = percentile(latencies, 95);
  if (p95 <= 500) {
    return 100;
  }
  if (p95 >= 5000) {
    return 0;
  }
  return 100 - ((p95 - 500) / (5000 - 500)) * 100;
}

function computeComposite(params: {
  fulfillmentRate: number;
  p95LatencyScore: number;
  disputeRate: number;
  verifiedPaymentRate: number;
  uptime: number;
  anchoredReceiptsCount: number;
  reportCount: number;
}): number {
  const base =
    params.fulfillmentRate * 100 * 0.35 +
    params.p95LatencyScore * 0.25 +
    (1 - params.disputeRate) * 100 * 0.15 +
    params.verifiedPaymentRate * 100 * 0.15 +
    params.uptime * 100 * 0.1;
  const anchorBoost = Math.min(8, Math.sqrt(Math.max(0, params.anchoredReceiptsCount)));
  const reportPenalty = Math.min(40, params.reportCount * 8);
  const score = base + anchorBoost - reportPenalty;
  return Math.max(0, Math.min(100, Math.round(score * 100) / 100));
}

export class ReputationEngine {
  constructor(
    private readonly uptimeByShop: (shopId: string) => number = () => 0.8,
    private readonly reportCountByShop: (shopId: string) => number = () => 0,
  ) {}

  scoreForSeller(events: MarketEvent[], shopId: string, reportCount?: number): ReputationScore {
    const sellerEvents = events.filter((event) => event.shopId === shopId);
    return this.computeFromEvents(sellerEvents, this.uptimeByShop(shopId), reportCount ?? this.reportCountByShop(shopId));
  }

  scoreForEndpoint(events: MarketEvent[], shopId: string, endpointId: string, reportCount?: number): ReputationScore {
    const endpointEvents = events.filter((event) => event.shopId === shopId && event.endpointId === endpointId);
    return this.computeFromEvents(endpointEvents, this.uptimeByShop(shopId), reportCount ?? this.reportCountByShop(shopId));
  }

  private computeFromEvents(events: MarketEvent[], uptime: number, reportCount: number): ReputationScore {
    const fulfilled = events.filter((event) => event.type === "REQUEST_FULFILLED").length;
    const failed = events.filter((event) => event.type === "REQUEST_FAILED").length;
    const paymentVerified = events.filter((event) => event.type === "PAYMENT_VERIFIED").length;
    const refunds = events.filter((event) => event.type === "REFUND_ISSUED").length;
    const anchoredReceipts = events.filter((event) => event.type === "PAYMENT_VERIFIED" && event.anchored === true && Boolean(event.anchor32)).length;
    const latencies = events
      .filter((event) => event.type === "REQUEST_FULFILLED" && typeof event.latencyMs === "number")
      .map((event) => event.latencyMs as number);

    const requests = fulfilled + failed;
    const fulfillmentRate = requests === 0 ? 1 : fulfilled / requests;
    const disputeRate = fulfilled === 0 ? 0 : refunds / fulfilled;
    const verifiedPaymentRate = requests === 0 ? 1 : Math.min(1, paymentVerified / requests);
    const latency = latencyScore(latencies);

    const score = computeComposite({
      fulfillmentRate,
      p95LatencyScore: latency,
      disputeRate,
      verifiedPaymentRate,
      uptime: Math.max(0, Math.min(1, uptime)),
      anchoredReceiptsCount: anchoredReceipts,
      reportCount: Math.max(0, reportCount),
    });

    const boundedUptime = Math.max(0, Math.min(1, uptime));
    const normalizedReportCount = Math.max(0, reportCount);
    const warning = normalizedReportCount > 0 || score < 60;

    return {
      sellerScore: score,
      endpointScore: score,
      reputationTier: toTier(score),
      reportCount: normalizedReportCount,
      anchoredReceiptsCount: anchoredReceipts,
      disputeCount: refunds,
      uptimeHeartbeatPct: Math.round(boundedUptime * 10_000) / 100,
      warning,
    };
  }
}
