import { describe, expect, it } from "vitest";
import { Keypair, SYSVAR_CLOCK_PUBKEY, SystemProgram } from "@solana/web3.js";
import { BENCH_THRESHOLDS } from "../src/bench/thresholds.js";
import { measureLegacyTransaction, measureV0Transaction } from "../src/bench/txMetrics.js";
import {
  buildLegacyAnchorTransaction,
  buildV0AnchorTransaction,
  createSyntheticLookupTable,
  deriveBucketPda,
} from "../src/tx/buildV0.js";

describe("tx size budget gates", () => {
  it("keeps settlement transactions under hard byte/account/signature/data budgets", () => {
    const payer = Keypair.generate();
    const { bucketPda, bucketId } = deriveBucketPda({
      nowMs: Date.UTC(2026, 1, 16, 12, 0, 0),
    });

    const recentBlockhash = "11111111111111111111111111111111";

    const legacyTx = buildLegacyAnchorTransaction({
      payer,
      recentBlockhash,
      bucketPda,
      bucketId,
      anchor32: `0x${"11".repeat(32)}`,
      includeBucketId: false,
      includeClockSysvar: false,
      includeSystemProgram: true,
    });

    const syntheticAlt = createSyntheticLookupTable({
      authority: payer.publicKey,
      addresses: [bucketPda, SystemProgram.programId, SYSVAR_CLOCK_PUBKEY],
    });

    const v0Tx = buildV0AnchorTransaction({
      payer,
      recentBlockhash,
      bucketPda,
      bucketId,
      anchor32: `0x${"22".repeat(32)}`,
      includeBucketId: false,
      includeClockSysvar: false,
      includeSystemProgram: true,
      lookupTables: [syntheticAlt],
    });

    const metrics = [measureLegacyTransaction(legacyTx), measureV0Transaction(v0Tx)];

    for (const entry of metrics) {
      expect(entry.serializedTxBytes).toBeLessThanOrEqual(BENCH_THRESHOLDS.settlementAnchor.maxSerializedTxBytes);
      expect(entry.instructionDataBytes).toBeLessThanOrEqual(BENCH_THRESHOLDS.settlementAnchor.maxInstructionDataBytes);
      expect(entry.accountsCount).toBeLessThanOrEqual(BENCH_THRESHOLDS.settlementAnchor.maxAccounts);
      expect(entry.signaturesCount).toBeLessThanOrEqual(BENCH_THRESHOLDS.settlementAnchor.maxSignatures);
    }
  });
});
