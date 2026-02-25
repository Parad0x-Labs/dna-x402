import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { SOLANA_TX_HARD_LIMIT_BYTES } from "../src/bench/thresholds.js";
import { measureLegacyTransaction } from "../src/bench/txMetrics.js";
import { foldAnchorAccumulator } from "../src/packing/anchorV1.js";
import { buildLegacyAnchorBatchTransaction, deriveBucketPda } from "../src/tx/buildV0.js";

function deterministicAnchor(index: number): string {
  const byte = (index % 256).toString(16).padStart(2, "0");
  return `0x${byte.repeat(32)}`;
}

describe("anchor batch", () => {
  it("fits 32 anchors under the 1232-byte tx limit", () => {
    const payer = Keypair.generate();
    const { bucketPda } = deriveBucketPda({
      nowMs: Date.UTC(2026, 1, 16, 12, 0, 0),
    });

    const anchors = Array.from({ length: 32 }, (_, index) => deterministicAnchor(index + 1));
    const tx = buildLegacyAnchorBatchTransaction({
      payer,
      recentBlockhash: "11111111111111111111111111111111",
      bucketPda,
      anchors,
      includeClockSysvar: false,
    });

    const metrics = measureLegacyTransaction(tx);
    expect(metrics.serializedTxBytes).toBeLessThanOrEqual(SOLANA_TX_HARD_LIMIT_BYTES);
  });

  it("produces deterministic hash-chain root for the same batch order", () => {
    const anchors = [
      deterministicAnchor(1),
      deterministicAnchor(2),
      deterministicAnchor(3),
      deterministicAnchor(4),
    ];

    const rootA = foldAnchorAccumulator(anchors);
    const rootB = foldAnchorAccumulator(anchors);
    const reordered = foldAnchorAccumulator([...anchors].reverse());

    expect(rootA).toBe(rootB);
    expect(reordered).not.toBe(rootA);
  });
});
