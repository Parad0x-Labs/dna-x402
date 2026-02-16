import fs from "node:fs";
import path from "node:path";
import {
  discoverProgramSoFiles,
  ensureSuccess,
  getAddress,
  getBalanceLamports,
  hasFlag,
  nowStamp,
  parseFlagValue,
  parseRepeatedFlagValues,
  readJson,
  runSolana,
  stageSignerPath,
  toSol,
  writeJson,
} from "./_solanaCli.js";

interface ProgramEstimate {
  programName: string;
  soPath: string;
  sizeBytes: number;
  rentBufferLamports: string;
  rentProgramDataLamports: string;
  estimatedLowLamports: string;
  estimatedLowSol: string;
  estimatedHighLamports: string;
  estimatedHighSol: string;
}

interface EstimateReport {
  generatedAt: string;
  cluster: string;
  keypair?: string;
  keypairUsedForCommands?: string;
  walletPubkey?: string;
  currentBalanceLamports?: string;
  currentBalanceSol?: string;
  totalEstimatedLowLamports: string;
  totalEstimatedLowSol: string;
  totalEstimatedHighLamports: string;
  totalEstimatedHighSol: string;
  headroomPercent: number;
  caution: string;
  programs: ProgramEstimate[];
}

function usage(): string {
  return [
    "Usage: tsx scripts/estimate-deploy-cost.ts [options]",
    "",
    "Options:",
    "  --cluster <devnet|testnet|mainnet-beta|url>   Cluster or RPC moniker (default: devnet)",
    "  --keypair <path>                                Keypair used to check current balance",
    "  --program <path/to/program.so>                  Program artifact path (repeatable).",
    "                                                  If omitted, autodiscovers target/deploy/*.so",
    "  --headroom-percent <n>                          Extra buffer added above low estimate (default: 20)",
    "  --out <path>                                    Output JSON report path",
    "  --help                                          Show this help",
  ].join("\n");
}

function rentExemptLamports(bytes: number, cluster: string, keypair?: string): bigint {
  const args = ["rent", String(bytes), "--lamports", "-u", cluster, "--output", "json-compact"];
  if (keypair) {
    args.push("-k", keypair);
  }
  const result = runSolana(args);
  ensureSuccess(result);
  const parsed = readJson<{ rentExemptMinimumLamports?: number | string }>(result.stdout);
  const raw = parsed.rentExemptMinimumLamports;
  if (raw === undefined || raw === null) {
    throw new Error(`Unable to parse rent output for ${bytes} bytes`);
  }
  return BigInt(raw.toString());
}

function main(): void {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help")) {
    // eslint-disable-next-line no-console
    console.log(usage());
    return;
  }

  const scriptDir = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname));
  const repoRoot = path.resolve(scriptDir, "..");

  const cluster = parseFlagValue(argv, "--cluster") ?? "devnet";
  const keypair = parseFlagValue(argv, "--keypair");
  const stagedKeypair = stageSignerPath(keypair);
  const headroomPercentRaw = parseFlagValue(argv, "--headroom-percent");
  const headroomPercent = headroomPercentRaw ? Math.max(0, Number.parseInt(headroomPercentRaw, 10) || 20) : 20;
  const outPath = parseFlagValue(argv, "--out")
    ?? path.join(repoRoot, "reports", `estimate-deploy-cost-${nowStamp()}.json`);

  const requestedPrograms = parseRepeatedFlagValues(argv, "--program")
    .map((entry) => path.resolve(process.cwd(), entry));
  const discoveredPrograms = discoverProgramSoFiles(repoRoot);
  const programs = requestedPrograms.length > 0 ? requestedPrograms : discoveredPrograms;

  if (programs.length === 0) {
    throw new Error("No program artifacts found. Pass --program or build Rust artifacts into target/deploy/*.so.");
  }

  const rows: ProgramEstimate[] = [];
  let totalLow = 0n;
  let totalHigh = 0n;

  for (const soPath of programs) {
    const stat = fs.statSync(soPath);
    const sizeBytes = stat.size;

    const rentBuffer = rentExemptLamports(sizeBytes, cluster, stagedKeypair);
    const rentProgramData = rentExemptLamports(sizeBytes + 64, cluster, stagedKeypair);
    const estimatedLow = rentBuffer + rentProgramData;
    const estimatedHigh = (estimatedLow * BigInt(100 + headroomPercent) + 99n) / 100n;

    totalLow += estimatedLow;
    totalHigh += estimatedHigh;

    rows.push({
      programName: path.basename(soPath, ".so"),
      soPath,
      sizeBytes,
      rentBufferLamports: rentBuffer.toString(10),
      rentProgramDataLamports: rentProgramData.toString(10),
      estimatedLowLamports: estimatedLow.toString(10),
      estimatedLowSol: toSol(estimatedLow),
      estimatedHighLamports: estimatedHigh.toString(10),
      estimatedHighSol: toSol(estimatedHigh),
    });
  }

  let walletPubkey: string | undefined;
  let currentBalance: bigint | undefined;
  try {
    walletPubkey = getAddress({ cluster, keypair: stagedKeypair });
    currentBalance = getBalanceLamports(walletPubkey, { cluster, keypair: stagedKeypair });
  } catch {
    // No balance context available is acceptable for estimation mode.
  }

  const report: EstimateReport = {
    generatedAt: new Date().toISOString(),
    cluster,
    keypair,
    keypairUsedForCommands: stagedKeypair,
    walletPubkey,
    currentBalanceLamports: currentBalance?.toString(10),
    currentBalanceSol: currentBalance !== undefined ? toSol(currentBalance) : undefined,
    totalEstimatedLowLamports: totalLow.toString(10),
    totalEstimatedLowSol: toSol(totalLow),
    totalEstimatedHighLamports: totalHigh.toString(10),
    totalEstimatedHighSol: toSol(totalHigh),
    headroomPercent,
    caution: "Estimate only. Real deploy spend is determined by measured balance deltas and buffer lifecycle. Always run deploy-ledger and close-buffers reports.",
    programs: rows,
  };

  writeJson(outPath, report);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: true,
    reportPath: outPath,
    cluster,
    programs: rows.length,
    totalEstimatedLowLamports: report.totalEstimatedLowLamports,
    totalEstimatedLowSol: report.totalEstimatedLowSol,
    totalEstimatedHighLamports: report.totalEstimatedHighLamports,
    totalEstimatedHighSol: report.totalEstimatedHighSol,
    caution: report.caution,
  }, null, 2));
}

main();
