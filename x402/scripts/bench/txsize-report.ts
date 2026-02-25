import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, SystemProgram } from "@solana/web3.js";
import { BENCH_THRESHOLDS, SOLANA_TX_HARD_LIMIT_BYTES } from "../../src/bench/thresholds.js";
import { measureLegacyTransaction, measureV0Transaction } from "../../src/bench/txMetrics.js";
import {
  DEFAULT_ANCHOR_PROGRAM_ID,
  buildLegacyAnchorBatchTransaction,
  buildLegacyAnchorTransaction,
  buildV0AnchorTransaction,
  createSyntheticLookupTable,
  deriveBucketPda,
} from "../../src/tx/buildV0.js";

interface FlowMetrics {
  flowId: string;
  serialized_tx_bytes: number;
  signatures_count: number;
  accounts_count: number;
  ix_data_bytes: number;
  uses_alt: boolean;
}

interface TxSizeReport {
  generatedAt: string;
  rpcUrl: string;
  anchorProgramId: string;
  tx_limit_bytes: number;
  thresholds: typeof BENCH_THRESHOLDS;
  flows: FlowMetrics[];
  smallest_settlement_tx_bytes: number;
  batch_anchor_max_within_1232: number;
  batch_anchor_recommended_cap: number;
  batch_anchor_metrics_32?: FlowMetrics;
  budget_pass: {
    settlementAnchor: boolean;
    batchAnchor: boolean;
  };
}

function parseFlagValue(args: string[], flag: string): string | undefined {
  const index = args.findIndex((arg) => arg === flag);
  if (index === -1 || index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
}

function resolveDefaultPayerKeypairPath(): string | undefined {
  const fromEnv = process.env.DEPLOYER_KEYPAIR;
  if (fromEnv && fs.existsSync(fromEnv)) {
    return fromEnv;
  }
  const solanaConfigDefault = path.join(process.env.HOME ?? "", ".config", "solana", "devnet-deployer.json");
  if (fs.existsSync(solanaConfigDefault)) {
    return solanaConfigDefault;
  }
  return undefined;
}

function loadKeypairFromFile(filePath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function deterministicAnchor(index: number): string {
  const byte = (index % 256).toString(16).padStart(2, "0");
  return `0x${byte.repeat(32)}`;
}

function toFlowMetrics(flowId: string, metrics: ReturnType<typeof measureLegacyTransaction> | ReturnType<typeof measureV0Transaction>): FlowMetrics {
  return {
    flowId,
    serialized_tx_bytes: metrics.serializedTxBytes,
    signatures_count: metrics.signaturesCount,
    accounts_count: metrics.accountsCount,
    ix_data_bytes: metrics.instructionDataBytes,
    uses_alt: metrics.usesAlt,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const rpcUrl = parseFlagValue(argv, "--rpc-url") ?? process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const outPath = parseFlagValue(argv, "--out")
    ?? path.resolve(process.cwd(), "reports", "bench_txsize.json");
  const payerPath = parseFlagValue(argv, "--payer-keypair") ?? resolveDefaultPayerKeypairPath();
  const anchorProgramId = new PublicKey(
    parseFlagValue(argv, "--program-id")
      ?? process.env.RECEIPT_ANCHOR_PROGRAM_ID
      ?? DEFAULT_ANCHOR_PROGRAM_ID.toBase58(),
  );
  const nowMs = Date.now();

  const payer = payerPath ? loadKeypairFromFile(payerPath) : Keypair.generate();
  const connection = new Connection(rpcUrl, "confirmed");
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const { bucketPda, bucketId } = deriveBucketPda({ nowMs, programId: anchorProgramId });

  const legacySettlement = buildLegacyAnchorTransaction({
    payer,
    recentBlockhash: blockhash,
    programId: anchorProgramId,
    bucketPda,
    bucketId,
    anchor32: deterministicAnchor(1),
    includeBucketId: false,
    includeClockSysvar: false,
    includeSystemProgram: true,
  });

  const v0NoAltSettlement = buildV0AnchorTransaction({
    payer,
    recentBlockhash: blockhash,
    programId: anchorProgramId,
    bucketPda,
    bucketId,
    anchor32: deterministicAnchor(1),
    includeBucketId: false,
    includeClockSysvar: false,
    includeSystemProgram: true,
  });

  const syntheticAlt = createSyntheticLookupTable({
    authority: payer.publicKey,
    addresses: [
      anchorProgramId,
      bucketPda,
      SystemProgram.programId,
      SYSVAR_CLOCK_PUBKEY,
    ],
  });

  const v0AltSettlement = buildV0AnchorTransaction({
    payer,
    recentBlockhash: blockhash,
    programId: anchorProgramId,
    bucketPda,
    bucketId,
    anchor32: deterministicAnchor(1),
    includeBucketId: false,
    includeClockSysvar: false,
    includeSystemProgram: true,
    lookupTables: [syntheticAlt],
  });

  const legacySettlementMetrics = toFlowMetrics("anchor_legacy", measureLegacyTransaction(legacySettlement));
  const v0NoAltMetrics = toFlowMetrics("anchor_v0_no_alt", measureV0Transaction(v0NoAltSettlement));
  const v0AltMetrics = toFlowMetrics("anchor_v0_with_alt", measureV0Transaction(v0AltSettlement));

  let maxAnchorsWithinLimit = 0;
  let batchMetrics32: FlowMetrics | undefined;

  for (let anchors = 1; anchors <= 64; anchors += 1) {
    const anchorList = Array.from({ length: anchors }, (_, index) => deterministicAnchor(index + 1));
    let metrics: FlowMetrics;
    try {
      const tx = buildLegacyAnchorBatchTransaction({
        payer,
        recentBlockhash: blockhash,
        programId: anchorProgramId,
        bucketPda,
        anchors: anchorList,
        includeClockSysvar: false,
        includeSystemProgram: false,
      });
      metrics = toFlowMetrics(`anchor_batch_${anchors}`, measureLegacyTransaction(tx));
    } catch {
      break;
    }

    if (anchors === 32) {
      batchMetrics32 = metrics;
    }

    if (metrics.serialized_tx_bytes <= SOLANA_TX_HARD_LIMIT_BYTES) {
      maxAnchorsWithinLimit = anchors;
    } else {
      break;
    }
  }

  const flows = [legacySettlementMetrics, v0NoAltMetrics, v0AltMetrics];
  const smallest = Math.min(...flows.map((flow) => flow.serialized_tx_bytes));

  const settlementBudgetPass = flows.every((flow) =>
    flow.serialized_tx_bytes <= BENCH_THRESHOLDS.settlementAnchor.maxSerializedTxBytes
    && flow.ix_data_bytes <= BENCH_THRESHOLDS.settlementAnchor.maxInstructionDataBytes
    && flow.accounts_count <= BENCH_THRESHOLDS.settlementAnchor.maxAccounts
    && flow.signatures_count <= BENCH_THRESHOLDS.settlementAnchor.maxSignatures,
  );

  const batchBudgetPass = maxAnchorsWithinLimit >= BENCH_THRESHOLDS.batchAnchor.maxAnchorsPerTxCap
    && maxAnchorsWithinLimit >= BENCH_THRESHOLDS.batchAnchor.minAnchorsPerTxExpected;

  const report: TxSizeReport = {
    generatedAt: new Date().toISOString(),
    rpcUrl,
    anchorProgramId: anchorProgramId.toBase58(),
    tx_limit_bytes: SOLANA_TX_HARD_LIMIT_BYTES,
    thresholds: BENCH_THRESHOLDS,
    flows,
    smallest_settlement_tx_bytes: smallest,
    batch_anchor_max_within_1232: maxAnchorsWithinLimit,
    batch_anchor_recommended_cap: Math.min(
      maxAnchorsWithinLimit,
      BENCH_THRESHOLDS.batchAnchor.maxAnchorsPerTxCap,
    ),
    batch_anchor_metrics_32: batchMetrics32,
    budget_pass: {
      settlementAnchor: settlementBudgetPass,
      batchAnchor: batchBudgetPass,
    },
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: settlementBudgetPass && batchBudgetPass,
    outPath,
    smallestSettlementTxBytes: smallest,
    maxAnchorsWithin1232: maxAnchorsWithinLimit,
  }, null, 2));

  if (!settlementBudgetPass || !batchBudgetPass) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
