export interface LatencySummary {
  count: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  averageMs: number;
}

export interface FlowTimingBuckets {
  apiLatencyMs: number[];
  chainConfirmMs: number[];
  anchorConfirmMs: number[];
}

export interface FlowTimingSummary {
  api: LatencySummary;
  chain: LatencySummary;
  anchor: LatencySummary;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[index];
}

export function summarizeLatencies(values: number[]): LatencySummary {
  if (values.length === 0) {
    return {
      count: 0,
      minMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
      averageMs: 0,
    };
  }
  const minMs = Math.min(...values);
  const maxMs = Math.max(...values);
  const sum = values.reduce((acc, value) => acc + value, 0);
  return {
    count: values.length,
    minMs,
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    p99Ms: percentile(values, 99),
    maxMs,
    averageMs: Number((sum / values.length).toFixed(3)),
  };
}

export function summarizeFlowTimings(buckets: FlowTimingBuckets): FlowTimingSummary {
  return {
    api: summarizeLatencies(buckets.apiLatencyMs),
    chain: summarizeLatencies(buckets.chainConfirmMs),
    anchor: summarizeLatencies(buckets.anchorConfirmMs),
  };
}

export function successRate(successes: number, attempts: number): number {
  if (attempts <= 0) {
    return 0;
  }
  return Number((successes / attempts).toFixed(6));
}
