import { parseAtomic } from "./feePolicy.js";
import { AtomicAmount, PricingModel, Tool } from "./types.js";

export interface UsageLogEntry {
  toolId: string;
  units?: number;
  amountAtomic?: AtomicAmount;
  timestampMs: number;
}

export interface UsageEstimate {
  callsRemainingAtTypicalMix: number;
  minCallsAtCheapestTools: number;
  maxCallsAtPremiumTools: number;
  last7dProjectedSpend?: AtomicAmount;
  basedOnRecentMix: boolean;
}

interface CostInput {
  units?: number;
  loadFactor?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function modeledCostAtomic(model: PricingModel, input: CostInput = {}): bigint {
  switch (model.kind) {
    case "flat":
      return parseAtomic(model.amountAtomic);
    case "metered": {
      const unitCount = Math.max(1, Math.floor(input.units ?? model.minUnits ?? 1));
      return parseAtomic(model.amountPerUnitAtomic) * BigInt(unitCount);
    }
    case "surge": {
      const load = clamp(input.loadFactor ?? 1, model.minMultiplier, model.maxMultiplier);
      const base = parseAtomic(model.baseAmountAtomic);
      const scale = 1_000_000n;
      const scaledMultiplier = BigInt(Math.ceil(load * 1_000_000));
      const scaled = (base * scaledMultiplier + scale - 1n) / scale;
      return scaled > 0n ? scaled : 1n;
    }
    case "stream": {
      const units = Math.max(1, Math.floor(input.units ?? 1));
      const streamCost = parseAtomic(model.rateAtomicPerSecond) * BigInt(units);
      if (!model.minTopupAtomic) {
        return streamCost;
      }
      const minimum = parseAtomic(model.minTopupAtomic);
      return streamCost > minimum ? streamCost : minimum;
    }
    case "netting":
      return parseAtomic(model.unitAmountAtomic) * BigInt(Math.max(1, Math.floor(input.units ?? 1)));
    default:
      return 0n;
  }
}

function safeFloorDiv(left: bigint, right: bigint): number {
  if (right <= 0n) {
    return 0;
  }
  const result = left / right;
  return result > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(result);
}

function weightedAverageCost(costs: bigint[], weights: number[]): bigint {
  if (costs.length === 0) {
    return 0n;
  }
  let weightSum = 0n;
  let weightedSum = 0n;
  for (let i = 0; i < costs.length; i += 1) {
    const weight = BigInt(Math.max(0, Math.floor(weights[i] ?? 0)));
    if (weight === 0n) {
      continue;
    }
    weightSum += weight;
    weightedSum += costs[i] * weight;
  }

  if (weightSum === 0n) {
    return costs[0];
  }
  return (weightedSum + weightSum - 1n) / weightSum;
}

export class ToolCatalog {
  private readonly toolsById = new Map<string, Tool>();

  constructor(tools: Tool[]) {
    for (const tool of tools) {
      this.toolsById.set(tool.toolId, tool);
    }
  }

  allTools(): Tool[] {
    return Array.from(this.toolsById.values());
  }

  get(toolId: string): Tool | undefined {
    return this.toolsById.get(toolId);
  }

  estimateToolCostAtomic(toolId: string, input: CostInput = {}): bigint {
    const tool = this.toolsById.get(toolId);
    if (!tool) {
      throw new Error(`Unknown toolId: ${toolId}`);
    }
    return modeledCostAtomic(tool.pricingModel, input);
  }

  estimateBalanceCoverage(balanceAtomic: AtomicAmount, usageLogs: UsageLogEntry[] = [], nowMs = Date.now()): UsageEstimate {
    const balance = parseAtomic(balanceAtomic);
    const tools = this.allTools();
    if (tools.length === 0 || balance <= 0n) {
      return {
        callsRemainingAtTypicalMix: 0,
        minCallsAtCheapestTools: 0,
        maxCallsAtPremiumTools: 0,
        basedOnRecentMix: false,
      };
    }

    const baselineCosts = tools.map((tool) => modeledCostAtomic(tool.pricingModel));
    const sorted = [...baselineCosts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const cheapest = sorted[0];
    const premium = sorted[sorted.length - 1];

    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const fromMs = nowMs - sevenDaysMs;
    const recent = usageLogs.filter((log) => log.timestampMs >= fromMs);

    const recentMixWeights = tools.map((tool) => {
      const logs = recent.filter((log) => log.toolId === tool.toolId);
      return logs.reduce((sum, log) => sum + Math.max(1, Math.floor(log.units ?? 1)), 0);
    });
    const hasRecentMix = recentMixWeights.some((x) => x > 0);

    const defaultWeights = tools.map((tool) => tool.typicalUnitsPerCall ?? 1);
    const mixWeights = hasRecentMix ? recentMixWeights : defaultWeights;
    const typicalCost = weightedAverageCost(baselineCosts, mixWeights);

    let projectedSpend: string | undefined;
    if (recent.length > 0) {
      const spend = recent.reduce((sum, log) => {
        if (log.amountAtomic) {
          return sum + parseAtomic(log.amountAtomic);
        }
        const tool = this.get(log.toolId);
        if (!tool) {
          return sum;
        }
        return sum + modeledCostAtomic(tool.pricingModel, { units: log.units });
      }, 0n);
      projectedSpend = spend.toString(10);
    }

    return {
      callsRemainingAtTypicalMix: safeFloorDiv(balance, typicalCost || 1n),
      minCallsAtCheapestTools: safeFloorDiv(balance, cheapest || 1n),
      maxCallsAtPremiumTools: safeFloorDiv(balance, premium || 1n),
      last7dProjectedSpend: projectedSpend,
      basedOnRecentMix: hasRecentMix,
    };
  }
}
