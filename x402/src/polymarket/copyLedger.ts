import { calculateAlphaSuccessFeeAtomic } from "./fees.js";
import type { CopyLotStatus } from "./types.js";

export const PRICE_MICRO_PUSD_SCALE = 1_000_000n;

export interface CopyLot {
  lotId: string;
  alphaId: string;
  followerId: string;
  marketId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  sizeAtomic: bigint;
  openSizeAtomic: bigint;
  closedSizeAtomic: bigint;
  entryCostAtomic: bigint;
  entryFeesAtomic: bigint;
  realizedEntryCostAtomic: bigint;
  realizedEntryFeesAtomic: bigint;
  exitProceedsAtomic: bigint;
  exitFeesAtomic: bigint;
  averageEntryPriceMicroPusd: bigint;
  averageExitPriceMicroPusd: bigint;
  sourceSignal: string;
  orderId: string;
  fillId: string;
  receiptIds: string[];
  copied: boolean;
  holdToResolution: boolean;
  redeemed: boolean;
  status: CopyLotStatus;
  openedAt?: string;
  closedAt?: string;
  netRealizedPnlAtomic?: bigint;
  alphaFeeAtomic?: bigint;
  win?: boolean;
}

export type CopyLotFillInput = Omit<
  CopyLot,
  | "openSizeAtomic"
  | "closedSizeAtomic"
  | "realizedEntryCostAtomic"
  | "realizedEntryFeesAtomic"
  | "exitProceedsAtomic"
  | "exitFeesAtomic"
  | "averageEntryPriceMicroPusd"
  | "averageExitPriceMicroPusd"
  | "redeemed"
  | "status"
  | "netRealizedPnlAtomic"
  | "alphaFeeAtomic"
  | "win"
  | "closedAt"
>;

export interface AlphaPerformanceSummary {
  alphaId: string;
  closedLots: number;
  wins: number;
  losses: number;
  winRateBps: number;
  realizedPnlAtomic: bigint;
  realizedPnl24hAtomic: bigint;
  realizedPnl7dAtomic: bigint;
  realizedPnl30dAtomic: bigint;
  averageEntryPriceMicroPusd: bigint;
  averageExitPriceMicroPusd: bigint;
  alphaFeeAssessedAtomic: bigint;
}

export function calculateAveragePriceMicroPusd(totalPusdAtomic: bigint, sizeAtomic: bigint): bigint {
  if (sizeAtomic <= 0n) {
    return 0n;
  }
  return (totalPusdAtomic * PRICE_MICRO_PUSD_SCALE) / sizeAtomic;
}

function prorateAtomic(total: bigint, part: bigint, whole: bigint): bigint {
  if (whole <= 0n) {
    return 0n;
  }
  return (total * part) / whole;
}

function withDerivedPrices(lot: CopyLot): CopyLot {
  return {
    ...lot,
    averageEntryPriceMicroPusd: calculateAveragePriceMicroPusd(lot.entryCostAtomic, lot.sizeAtomic),
    averageExitPriceMicroPusd: calculateAveragePriceMicroPusd(lot.exitProceedsAtomic, lot.closedSizeAtomic),
  };
}

export function createCopyLotFromFill(input: CopyLotFillInput): CopyLot {
  return {
    ...input,
    openSizeAtomic: input.sizeAtomic,
    closedSizeAtomic: 0n,
    realizedEntryCostAtomic: 0n,
    realizedEntryFeesAtomic: 0n,
    exitProceedsAtomic: 0n,
    exitFeesAtomic: 0n,
    averageEntryPriceMicroPusd: calculateAveragePriceMicroPusd(input.entryCostAtomic, input.sizeAtomic),
    averageExitPriceMicroPusd: 0n,
    redeemed: false,
    status: "OPENED",
  };
}

export function closeCopyLotProRata(input: {
  lot: CopyLot;
  exitSizeAtomic: bigint;
  exitProceedsAtomic: bigint;
  exitFeesAtomic: bigint;
  closedAt?: string;
}): CopyLot {
  if (input.exitSizeAtomic <= 0n || input.exitSizeAtomic > input.lot.openSizeAtomic) {
    throw new Error("Invalid copied lot exit size.");
  }
  const openSizeAtomic = input.lot.openSizeAtomic - input.exitSizeAtomic;
  const isFinalClose = openSizeAtomic === 0n;
  const realizedEntryCostAtomic = isFinalClose
    ? input.lot.entryCostAtomic - input.lot.realizedEntryCostAtomic
    : prorateAtomic(input.lot.entryCostAtomic, input.exitSizeAtomic, input.lot.sizeAtomic);
  const realizedEntryFeesAtomic = isFinalClose
    ? input.lot.entryFeesAtomic - input.lot.realizedEntryFeesAtomic
    : prorateAtomic(input.lot.entryFeesAtomic, input.exitSizeAtomic, input.lot.sizeAtomic);

  return withDerivedPrices({
    ...input.lot,
    openSizeAtomic,
    closedSizeAtomic: input.lot.closedSizeAtomic + input.exitSizeAtomic,
    realizedEntryCostAtomic: input.lot.realizedEntryCostAtomic + realizedEntryCostAtomic,
    realizedEntryFeesAtomic: input.lot.realizedEntryFeesAtomic + realizedEntryFeesAtomic,
    exitProceedsAtomic: input.lot.exitProceedsAtomic + input.exitProceedsAtomic,
    exitFeesAtomic: input.lot.exitFeesAtomic + input.exitFeesAtomic,
    status: openSizeAtomic === 0n ? "CLOSED" : "PARTIALLY_CLOSED",
    closedAt: isFinalClose ? input.closedAt : input.lot.closedAt,
  });
}

export function finalizeCopyLotPnl(lot: CopyLot): CopyLot {
  if (lot.holdToResolution && !lot.redeemed) {
    return { ...lot, status: "REDEEMED" };
  }
  const realizedEntryCostAtomic = lot.realizedEntryCostAtomic || (lot.openSizeAtomic === 0n ? lot.entryCostAtomic : 0n);
  const realizedEntryFeesAtomic = lot.realizedEntryFeesAtomic || (lot.openSizeAtomic === 0n ? lot.entryFeesAtomic : 0n);
  const netRealizedPnlAtomic = lot.exitProceedsAtomic - lot.exitFeesAtomic - realizedEntryCostAtomic - realizedEntryFeesAtomic;
  return {
    ...withDerivedPrices({
      ...lot,
      realizedEntryCostAtomic,
      realizedEntryFeesAtomic,
    }),
    netRealizedPnlAtomic,
    win: netRealizedPnlAtomic > 0n,
    status: "PNL_FINALIZED",
  };
}

export function assessAlphaFeeForLot(lot: CopyLot): CopyLot {
  if (lot.status === "ALPHA_FEE_ASSESSED" || lot.status === "ALPHA_FEE_PAID" || lot.status === "ALPHA_FEE_UNPAID") {
    throw new Error("Alpha fee was already assessed for this copied lot.");
  }
  const netRealizedPnlAtomic = lot.netRealizedPnlAtomic ?? 0n;
  const fee = calculateAlphaSuccessFeeAtomic({
    copied: lot.copied,
    netRealizedPnlAtomic,
  });
  if (fee.status === "NO_FEE") {
    return { ...lot, alphaFeeAtomic: 0n };
  }
  return {
    ...lot,
    alphaFeeAtomic: fee.feeAtomic,
    status: fee.status,
  };
}

export function closeCopiedLotsFifo(input: {
  lots: CopyLot[];
  exitSizeAtomic: bigint;
  exitProceedsAtomic: bigint;
  exitFeesAtomic: bigint;
  closedAt?: string;
}): {
  updatedLots: CopyLot[];
  closedLots: CopyLot[];
  remainingExitSizeAtomic: bigint;
} {
  if (input.exitSizeAtomic <= 0n) {
    throw new Error("Invalid copied lot exit size.");
  }
  const sorted = [...input.lots].sort((a, b) => String(a.openedAt ?? "").localeCompare(String(b.openedAt ?? "")));
  let remainingExitSizeAtomic = input.exitSizeAtomic;
  let allocatedProceedsAtomic = 0n;
  let allocatedFeesAtomic = 0n;
  const updatedLots: CopyLot[] = [];
  const closedLots: CopyLot[] = [];

  for (const lot of sorted) {
    if (remainingExitSizeAtomic <= 0n || lot.openSizeAtomic <= 0n) {
      updatedLots.push(lot);
      continue;
    }
    const exitSizeAtomic = remainingExitSizeAtomic > lot.openSizeAtomic ? lot.openSizeAtomic : remainingExitSizeAtomic;
    const isLastAllocation = exitSizeAtomic === remainingExitSizeAtomic;
    const exitProceedsAtomic = isLastAllocation
      ? input.exitProceedsAtomic - allocatedProceedsAtomic
      : prorateAtomic(input.exitProceedsAtomic, exitSizeAtomic, input.exitSizeAtomic);
    const exitFeesAtomic = isLastAllocation
      ? input.exitFeesAtomic - allocatedFeesAtomic
      : prorateAtomic(input.exitFeesAtomic, exitSizeAtomic, input.exitSizeAtomic);
    const closed = closeCopyLotProRata({
      lot,
      exitSizeAtomic,
      exitProceedsAtomic,
      exitFeesAtomic,
      closedAt: input.closedAt,
    });

    remainingExitSizeAtomic -= exitSizeAtomic;
    allocatedProceedsAtomic += exitProceedsAtomic;
    allocatedFeesAtomic += exitFeesAtomic;
    updatedLots.push(closed);
    closedLots.push(closed);
  }

  return {
    updatedLots,
    closedLots,
    remainingExitSizeAtomic,
  };
}

function sumPnlInWindow(lots: CopyLot[], nowMs: number, windowMs: number): bigint {
  const start = nowMs - windowMs;
  return lots.reduce((total, lot) => {
    if (lot.netRealizedPnlAtomic == null || !lot.closedAt) {
      return total;
    }
    const closedAtMs = Date.parse(lot.closedAt);
    if (!Number.isFinite(closedAtMs) || closedAtMs < start || closedAtMs > nowMs) {
      return total;
    }
    return total + lot.netRealizedPnlAtomic;
  }, 0n);
}

export function summarizeAlphaPerformance(input: {
  alphaId: string;
  lots: CopyLot[];
  now?: Date | string;
}): AlphaPerformanceSummary {
  const now = input.now ? new Date(input.now) : new Date();
  const nowMs = now.getTime();
  const finalizedLots = input.lots.filter((lot) => lot.alphaId === input.alphaId && lot.netRealizedPnlAtomic != null);
  const wins = finalizedLots.filter((lot) => (lot.netRealizedPnlAtomic ?? 0n) > 0n).length;
  const losses = finalizedLots.filter((lot) => (lot.netRealizedPnlAtomic ?? 0n) <= 0n).length;
  const sizeAtomic = finalizedLots.reduce((total, lot) => total + lot.sizeAtomic, 0n);
  const entryCostAtomic = finalizedLots.reduce((total, lot) => total + lot.entryCostAtomic, 0n);
  const closedSizeAtomic = finalizedLots.reduce((total, lot) => total + lot.closedSizeAtomic, 0n);
  const exitProceedsAtomic = finalizedLots.reduce((total, lot) => total + lot.exitProceedsAtomic, 0n);
  const closedLots = finalizedLots.length;

  return {
    alphaId: input.alphaId,
    closedLots,
    wins,
    losses,
    winRateBps: closedLots === 0 ? 0 : Math.floor((wins * 10_000) / closedLots),
    realizedPnlAtomic: finalizedLots.reduce((total, lot) => total + (lot.netRealizedPnlAtomic ?? 0n), 0n),
    realizedPnl24hAtomic: sumPnlInWindow(finalizedLots, nowMs, 24 * 60 * 60 * 1000),
    realizedPnl7dAtomic: sumPnlInWindow(finalizedLots, nowMs, 7 * 24 * 60 * 60 * 1000),
    realizedPnl30dAtomic: sumPnlInWindow(finalizedLots, nowMs, 30 * 24 * 60 * 60 * 1000),
    averageEntryPriceMicroPusd: calculateAveragePriceMicroPusd(entryCostAtomic, sizeAtomic),
    averageExitPriceMicroPusd: calculateAveragePriceMicroPusd(exitProceedsAtomic, closedSizeAtomic),
    alphaFeeAssessedAtomic: finalizedLots.reduce((total, lot) => total + (lot.alphaFeeAtomic ?? 0n), 0n),
  };
}
