import fs from "node:fs";
import path from "node:path";
import { BENCH_THRESHOLDS } from "../../src/bench/thresholds.js";
import { ReceiptAnchorClient } from "../../src/onchain/receiptAnchorClient.js";

interface ComputeBenchReport {
  generatedAt: string;
  rpcUrl: string;
  anchorProgramId: string;
  payer: string;
  altAddress?: string;
  flows: Array<{
    flowId: string;
    unitsConsumed: number;
    ok: boolean;
    anchorsCount: number;
    bucketPda: string;
    bucketId: string;
    error?: string;
  }>;
  initSignature: string;
  maxUnits: number;
  thresholdMaxUnits: number;
  allFlowsSucceeded: boolean;
  budgetPass: boolean;
}

function parseFlagValue(args: string[], flag: string): string | undefined {
  const index = args.findIndex((arg) => arg === flag);
  if (index === -1 || index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
}

function deterministicAnchor(index: number): string {
  const byte = (index % 256).toString(16).padStart(2, "0");
  return `0x${byte.repeat(32)}`;
}

function resolveDefaultPayerKeypairPath(): string | undefined {
  const fromEnv = process.env.ANCHORING_KEYPAIR_PATH ?? process.env.DEPLOYER_KEYPAIR;
  if (fromEnv && fs.existsSync(fromEnv)) {
    return fromEnv;
  }
  const solanaConfigDefault = path.join(process.env.HOME ?? "", ".config", "solana", "devnet-deployer.json");
  if (fs.existsSync(solanaConfigDefault)) {
    return solanaConfigDefault;
  }
  return undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const rpcUrl = parseFlagValue(argv, "--rpc-url") ?? process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const outPath = parseFlagValue(argv, "--out")
    ?? path.resolve(process.cwd(), "reports", "bench_compute.json");
  const payerPath = parseFlagValue(argv, "--payer-keypair") ?? resolveDefaultPayerKeypairPath();
  const programId = parseFlagValue(argv, "--program-id")
    ?? process.env.RECEIPT_ANCHOR_PROGRAM_ID;
  const altAddress = parseFlagValue(argv, "--alt-address")
    ?? process.env.ANCHORING_ALT_ADDRESS;

  if (!payerPath) {
    throw new Error("Missing payer keypair for compute benchmark. Use --payer-keypair or ANCHORING_KEYPAIR_PATH/DEPLOYER_KEYPAIR.");
  }
  if (!programId) {
    throw new Error("Missing anchor program id. Use --program-id or RECEIPT_ANCHOR_PROGRAM_ID.");
  }

  const client = ReceiptAnchorClient.fromEnv({
    rpcUrl,
    payerKeypairPath: payerPath,
    programId,
    altAddress,
    commitment: "confirmed",
    useAltByDefault: true,
  });

  const bucketId = BigInt(Math.floor(Date.now() / 3_600_000));
  const initTx = await client.sendSingle({
    anchor32: deterministicAnchor(0),
    bucketId,
    useAlt: false,
    includeClockSysvar: false,
    includeSystemProgram: true,
    includeBucketId: false,
  });
  if (!initTx.confirmed) {
    throw new Error("failed to initialize anchor bucket before compute benchmark");
  }

  const single = await client.simulateSingle({
    anchor32: deterministicAnchor(1),
    bucketId,
    useAlt: false,
    includeClockSysvar: false,
    includeSystemProgram: false,
    includeBucketId: false,
  });
  if (!single.ok) {
    throw new Error(`single_anchor_simulation_failed: ${single.error ?? "unknown"}`);
  }

  const batchAnchors = Array.from({ length: 32 }, (_, index) => deterministicAnchor(index + 1));
  const batch = await client.simulateBatch({
    anchors: batchAnchors,
    bucketId,
    useAlt: false,
    includeClockSysvar: false,
    includeSystemProgram: false,
  });
  if (!batch.ok) {
    throw new Error(`batch_anchor_simulation_failed: ${batch.error ?? "unknown"}`);
  }

  const flows = [
    {
      flowId: "anchor_single_v0",
      unitsConsumed: single.unitsConsumed,
      ok: single.ok,
      anchorsCount: single.anchorsCount,
      bucketPda: single.bucketPda,
      bucketId: single.bucketId,
      error: single.error,
    },
    {
      flowId: "anchor_batch32_v0",
      unitsConsumed: batch.unitsConsumed,
      ok: batch.ok,
      anchorsCount: batch.anchorsCount,
      bucketPda: batch.bucketPda,
      bucketId: batch.bucketId,
      error: batch.error,
    },
  ];

  const maxUnits = Math.max(...flows.map((entry) => entry.unitsConsumed));
  const allFlowsSucceeded = flows.every((entry) => entry.ok);
  const budgetPass = allFlowsSucceeded && maxUnits <= BENCH_THRESHOLDS.settlementAnchor.maxComputeUnits;

  const report: ComputeBenchReport = {
    generatedAt: new Date().toISOString(),
    rpcUrl,
    anchorProgramId: programId,
    payer: client.payerPubkey.toBase58(),
    altAddress,
    flows,
    initSignature: initTx.signature,
    maxUnits,
    thresholdMaxUnits: BENCH_THRESHOLDS.settlementAnchor.maxComputeUnits,
    allFlowsSucceeded,
    budgetPass,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: budgetPass,
    outPath,
    maxUnits,
    threshold: BENCH_THRESHOLDS.settlementAnchor.maxComputeUnits,
    allFlowsSucceeded,
  }, null, 2));

  if (!budgetPass) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
