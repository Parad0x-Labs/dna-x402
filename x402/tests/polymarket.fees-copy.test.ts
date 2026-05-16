import { describe, expect, it } from "vitest";
import {
  DNA_V1_POLYMARKET_NOTIONAL_FEE_ENABLED,
  POLYMARKET_V1_BUILDER_FEE_BPS,
  assertV1FeeModel,
  calculateAlphaSuccessFeeAtomic,
} from "../src/polymarket/fees.js";
import {
  assessAlphaFeeForLot,
  calculateAveragePriceMicroPusd,
  closeCopiedLotsFifo,
  closeCopyLotProRata,
  createCopyLotFromFill,
  finalizeCopyLotPnl,
  summarizeAlphaPerformance,
} from "../src/polymarket/copyLedger.js";

function lot() {
  return createCopyLotFromFill({
    lotId: "lot-1",
    alphaId: "alpha-1",
    followerId: "follower-1",
    marketId: "market-1",
    tokenId: "token-yes",
    side: "BUY",
    sizeAtomic: 100n,
    entryCostAtomic: 5_000_000n,
    entryFeesAtomic: 0n,
    sourceSignal: "signal-1",
    orderId: "order-1",
    fillId: "fill-1",
    receiptIds: ["receipt-1"],
    copied: true,
    holdToResolution: false,
  });
}

describe("polymarket V1 fees and copy ledger", () => {
  it("locks builder fee to 0 bps and DNA notional fee off", () => {
    expect(POLYMARKET_V1_BUILDER_FEE_BPS).toBe(0);
    expect(DNA_V1_POLYMARKET_NOTIONAL_FEE_ENABLED).toBe(false);
    expect(() => assertV1FeeModel({ builderFeeBps: 0, dnaNotionalFeeEnabled: false })).not.toThrow();
    expect(() => assertV1FeeModel({ builderFeeBps: 1, dnaNotionalFeeEnabled: false })).toThrow(/builder fee/i);
    expect(() => assertV1FeeModel({ builderFeeBps: 0, dnaNotionalFeeEnabled: true })).toThrow(/notional fee/i);
  });

  it("charges alpha fee only for positive finalized copied-lot PnL", () => {
    expect(calculateAlphaSuccessFeeAtomic({ copied: true, netRealizedPnlAtomic: -1n }).feeAtomic).toBe(0n);
    expect(calculateAlphaSuccessFeeAtomic({ copied: false, netRealizedPnlAtomic: 1_000_000n }).feeAtomic).toBe(0n);
    expect(calculateAlphaSuccessFeeAtomic({ copied: true, netRealizedPnlAtomic: 1_000_000n }).feeAtomic).toBe(20_000n);
  });

  it("creates copied fill lots and closes partial exits proportionally", () => {
    const opened = lot();
    expect(opened.status).toBe("OPENED");
    expect(opened.openSizeAtomic).toBe(100n);

    const partial = closeCopyLotProRata({
      lot: opened,
      exitSizeAtomic: 40n,
      exitProceedsAtomic: 2_400_000n,
      exitFeesAtomic: 10_000n,
    });
    expect(partial.status).toBe("PARTIALLY_CLOSED");
    expect(partial.openSizeAtomic).toBe(60n);

    const closed = closeCopyLotProRata({
      lot: partial,
      exitSizeAtomic: 60n,
      exitProceedsAtomic: 3_600_000n,
      exitFeesAtomic: 15_000n,
    });
    expect(closed.status).toBe("CLOSED");
    expect(closed.openSizeAtomic).toBe(0n);
  });

  it("finalizes manual follower exits and prevents duplicate alpha fee assessment", () => {
    const closed = closeCopyLotProRata({
      lot: lot(),
      exitSizeAtomic: 100n,
      exitProceedsAtomic: 6_000_000n,
      exitFeesAtomic: 0n,
    });
    const finalized = finalizeCopyLotPnl(closed);
    expect(finalized.status).toBe("PNL_FINALIZED");
    expect(finalized.netRealizedPnlAtomic).toBe(1_000_000n);

    const assessed = assessAlphaFeeForLot(finalized);
    expect(assessed.status).toBe("ALPHA_FEE_ASSESSED");
    expect(assessed.alphaFeeAtomic).toBe(20_000n);
    expect(() => assessAlphaFeeForLot(assessed)).toThrow(/already assessed/i);
  });

  it("hold-to-resolution waits for redemption and losing lots become LOSS_NO_FEE", () => {
    const hold = { ...lot(), holdToResolution: true };
    expect(finalizeCopyLotPnl(hold).status).toBe("REDEEMED");

    const losingClosed = closeCopyLotProRata({
      lot: lot(),
      exitSizeAtomic: 100n,
      exitProceedsAtomic: 4_000_000n,
      exitFeesAtomic: 0n,
    });
    const losing = assessAlphaFeeForLot(finalizeCopyLotPnl(losingClosed));
    expect(losing.status).toBe("LOSS_NO_FEE");
    expect(losing.alphaFeeAtomic).toBe(0n);
  });

  it("tracks weighted average entry and exit prices for copied lots", () => {
    const opened = createCopyLotFromFill({
      lotId: "lot-price",
      alphaId: "alpha-1",
      followerId: "follower-1",
      marketId: "market-1",
      tokenId: "token-yes",
      side: "BUY",
      sizeAtomic: 100_000_000n,
      entryCostAtomic: 52_000_000n,
      entryFeesAtomic: 500_000n,
      sourceSignal: "signal-1",
      orderId: "order-1",
      fillId: "fill-1",
      receiptIds: ["receipt-1"],
      copied: true,
      holdToResolution: false,
      openedAt: "2026-05-15T00:00:00.000Z",
    });

    expect(opened.averageEntryPriceMicroPusd).toBe(520_000n);
    expect(calculateAveragePriceMicroPusd(52_000_000n, 100_000_000n)).toBe(520_000n);

    const closed = closeCopyLotProRata({
      lot: opened,
      exitSizeAtomic: 100_000_000n,
      exitProceedsAtomic: 70_000_000n,
      exitFeesAtomic: 250_000n,
      closedAt: "2026-05-15T01:00:00.000Z",
    });
    const finalized = finalizeCopyLotPnl(closed);

    expect(finalized.averageExitPriceMicroPusd).toBe(700_000n);
    expect(finalized.netRealizedPnlAtomic).toBe(17_250_000n);
    expect(finalized.win).toBe(true);
  });

  it("closes copied lots FIFO and preserves per-lot realized PnL", () => {
    const first = createCopyLotFromFill({
      ...lot(),
      lotId: "lot-a",
      sizeAtomic: 100_000_000n,
      entryCostAtomic: 40_000_000n,
      openedAt: "2026-05-15T00:00:00.000Z",
    });
    const second = createCopyLotFromFill({
      ...lot(),
      lotId: "lot-b",
      sizeAtomic: 50_000_000n,
      entryCostAtomic: 35_000_000n,
      openedAt: "2026-05-15T00:05:00.000Z",
    });

    const result = closeCopiedLotsFifo({
      lots: [second, first],
      exitSizeAtomic: 120_000_000n,
      exitProceedsAtomic: 72_000_000n,
      exitFeesAtomic: 600_000n,
      closedAt: "2026-05-15T01:00:00.000Z",
    });

    expect(result.closedLots.map((closed) => closed.lotId)).toEqual(["lot-a", "lot-b"]);
    expect(result.remainingExitSizeAtomic).toBe(0n);
    expect(result.updatedLots.find((closed) => closed.lotId === "lot-a")?.status).toBe("CLOSED");
    expect(result.updatedLots.find((closed) => closed.lotId === "lot-b")?.status).toBe("PARTIALLY_CLOSED");

    const finalizedA = finalizeCopyLotPnl(result.updatedLots.find((closed) => closed.lotId === "lot-a")!);
    const finalizedB = finalizeCopyLotPnl(closeCopyLotProRata({
      lot: result.updatedLots.find((closed) => closed.lotId === "lot-b")!,
      exitSizeAtomic: 30_000_000n,
      exitProceedsAtomic: 18_000_000n,
      exitFeesAtomic: 150_000n,
      closedAt: "2026-05-15T02:00:00.000Z",
    }));

    expect(finalizedA.netRealizedPnlAtomic).toBe(19_500_000n);
    expect(finalizedB.netRealizedPnlAtomic).toBe(-5_250_000n);
  });

  it("summarizes alpha win rate, PnL windows, and average entry price", () => {
    const now = new Date("2026-05-15T12:00:00.000Z");
    const winning = assessAlphaFeeForLot(finalizeCopyLotPnl(closeCopyLotProRata({
      lot: createCopyLotFromFill({
        ...lot(),
        lotId: "winner",
        sizeAtomic: 100_000_000n,
        entryCostAtomic: 45_000_000n,
        openedAt: "2026-05-15T10:00:00.000Z",
      }),
      exitSizeAtomic: 100_000_000n,
      exitProceedsAtomic: 80_000_000n,
      exitFeesAtomic: 0n,
      closedAt: "2026-05-15T11:00:00.000Z",
    })));
    const losing = assessAlphaFeeForLot(finalizeCopyLotPnl(closeCopyLotProRata({
      lot: createCopyLotFromFill({
        ...lot(),
        lotId: "loser",
        sizeAtomic: 50_000_000n,
        entryCostAtomic: 35_000_000n,
        openedAt: "2026-05-10T10:00:00.000Z",
      }),
      exitSizeAtomic: 50_000_000n,
      exitProceedsAtomic: 20_000_000n,
      exitFeesAtomic: 0n,
      closedAt: "2026-05-10T11:00:00.000Z",
    })));

    const summary = summarizeAlphaPerformance({
      alphaId: "alpha-1",
      lots: [winning, losing],
      now,
    });

    expect(summary.closedLots).toBe(2);
    expect(summary.wins).toBe(1);
    expect(summary.losses).toBe(1);
    expect(summary.winRateBps).toBe(5_000);
    expect(summary.realizedPnlAtomic).toBe(20_000_000n);
    expect(summary.realizedPnl24hAtomic).toBe(35_000_000n);
    expect(summary.realizedPnl7dAtomic).toBe(20_000_000n);
    expect(summary.averageEntryPriceMicroPusd).toBe(533_333n);
    expect(summary.alphaFeeAssessedAtomic).toBe(700_000n);
  });
});
