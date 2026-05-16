import type { CopyLotStatus } from "./types.js";

export const POLYMARKET_V1_BUILDER_FEE_BPS = 0;
export const DNA_V1_POLYMARKET_NOTIONAL_FEE_ENABLED = false;
export const ALPHA_SUCCESS_FEE_BPS = 200;

export interface AlphaFeeAssessment {
  copied: boolean;
  netRealizedPnlAtomic: bigint;
  alreadyAssessed?: boolean;
}

export interface AlphaFeeResult {
  feeAtomic: bigint;
  status: CopyLotStatus | "NO_FEE";
}

export function assertV1FeeModel(input: {
  builderFeeBps: number;
  dnaNotionalFeeEnabled: boolean;
}): void {
  if (input.builderFeeBps !== POLYMARKET_V1_BUILDER_FEE_BPS) {
    throw new Error("Polymarket Agent V1 builder fee must be 0 bps.");
  }
  if (input.dnaNotionalFeeEnabled !== DNA_V1_POLYMARKET_NOTIONAL_FEE_ENABLED) {
    throw new Error("Polymarket Agent V1 DNA per-order notional fee must be off.");
  }
}

export function calculateAlphaSuccessFeeAtomic(input: AlphaFeeAssessment): AlphaFeeResult {
  if (input.alreadyAssessed) {
    throw new Error("Alpha fee was already assessed for this copied lot.");
  }
  if (!input.copied) {
    return { feeAtomic: 0n, status: "NO_FEE" };
  }
  if (input.netRealizedPnlAtomic <= 0n) {
    return { feeAtomic: 0n, status: "LOSS_NO_FEE" };
  }
  return {
    feeAtomic: (input.netRealizedPnlAtomic * BigInt(ALPHA_SUCCESS_FEE_BPS)) / 10_000n,
    status: "ALPHA_FEE_ASSESSED",
  };
}
