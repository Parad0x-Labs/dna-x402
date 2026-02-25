export const SOLANA_TX_HARD_LIMIT_BYTES = 1232;

export interface SettlementBudgetThreshold {
  maxSerializedTxBytes: number;
  maxInstructionDataBytes: number;
  maxAccounts: number;
  maxSignatures: number;
  maxComputeUnits: number;
}

export interface SoakBudgetThreshold {
  minSuccessRate: number;
  maxP95LatencyMs: number;
}

export const BENCH_THRESHOLDS = {
  settlementAnchor: {
    maxSerializedTxBytes: 450,
    maxInstructionDataBytes: 40,
    maxAccounts: 4,
    maxSignatures: 1,
    maxComputeUnits: 30_000,
  } satisfies SettlementBudgetThreshold,
  batchAnchor: {
    hardTxLimitBytes: SOLANA_TX_HARD_LIMIT_BYTES,
    maxAnchorsPerTxCap: 32,
    minAnchorsPerTxExpected: 16,
  },
  soak: {
    minSuccessRate: 0.99,
    maxP95LatencyMs: 2500,
  } satisfies SoakBudgetThreshold,
} as const;
