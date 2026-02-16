import { AtomicAmount } from "../types.js";

export interface SurgeLoadFactor {
  queueDepth: number;
  inflight: number;
  p95LatencyMs: number;
  errorRate?: number;
}

export interface SurgePricingInput {
  basePriceAtomic: AtomicAmount;
  load: SurgeLoadFactor;
  minMultiplier?: number;
  maxMultiplier?: number;
}

export interface SurgePricingResult {
  priceAtomic: AtomicAmount;
  multiplier: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function deriveLoadFactor(load: SurgeLoadFactor): number {
  const queueScore = Math.min(1, load.queueDepth / 200);
  const inflightScore = Math.min(1, load.inflight / 100);
  const latencyScore = Math.min(1, load.p95LatencyMs / 4000);
  const errorScore = Math.min(1, Math.max(0, load.errorRate ?? 0));
  return clamp(queueScore * 0.35 + inflightScore * 0.25 + latencyScore * 0.25 + errorScore * 0.15, 0, 1);
}

export function applySurgePricing(input: SurgePricingInput): SurgePricingResult {
  const base = BigInt(input.basePriceAtomic);
  const minMultiplier = input.minMultiplier ?? 0.8;
  const maxMultiplier = input.maxMultiplier ?? 2.5;

  const loadFactor = deriveLoadFactor(input.load);
  const rawMultiplier = minMultiplier + (maxMultiplier - minMultiplier) * loadFactor;
  const multiplier = clamp(rawMultiplier, minMultiplier, maxMultiplier);

  const scale = 1_000_000n;
  const multiplierScaled = BigInt(Math.ceil(multiplier * 1_000_000));
  const scaled = (base * multiplierScaled + scale - 1n) / scale;
  return {
    priceAtomic: (scaled > 0n ? scaled : 1n).toString(10),
    multiplier,
  };
}
