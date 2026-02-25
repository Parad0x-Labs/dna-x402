import fs from "node:fs";
import path from "node:path";

interface TxSizeFlow {
  flowId: string;
  serialized_tx_bytes: number;
  signatures_count: number;
  accounts_count: number;
  ix_data_bytes: number;
  uses_alt: boolean;
}

interface TxSizeReport {
  flows: TxSizeFlow[];
  smallest_settlement_tx_bytes: number;
  batch_anchor_max_within_1232: number;
  tx_limit_bytes: number;
}

interface ComputeReport {
  maxUnits: number;
  thresholdMaxUnits: number;
  flows: Array<{ flowId: string; unitsConsumed: number; ok?: boolean; error?: string }>;
}

interface SoakReport {
  summary?: {
    runs: number;
    successRate: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
  };
  generatedAt?: string;
}

function parseFlagValue(args: string[], flag: string): string | undefined {
  const index = args.findIndex((arg) => arg === flag);
  if (index === -1 || index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function findLatestSoakReport(reportsDir: string): string | undefined {
  if (!fs.existsSync(reportsDir)) {
    return undefined;
  }
  const matches = fs.readdirSync(reportsDir)
    .filter((entry) => entry.startsWith("soak-") && entry.endsWith(".json"))
    .map((entry) => path.join(reportsDir, entry));

  if (matches.length === 0) {
    return undefined;
  }

  return matches
    .map((entry) => ({ entry, mtimeMs: fs.statSync(entry).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0].entry;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const reportsDir = parseFlagValue(argv, "--reports-dir") ?? path.resolve(process.cwd(), "reports");
  const txSizePath = parseFlagValue(argv, "--txsize") ?? path.join(reportsDir, "bench_txsize.json");
  const computePath = parseFlagValue(argv, "--compute") ?? path.join(reportsDir, "bench_compute.json");
  const soakPath = parseFlagValue(argv, "--soak") ?? findLatestSoakReport(reportsDir);
  const outPath = parseFlagValue(argv, "--out")
    ?? path.resolve(process.cwd(), "..", "docs", "FOOTPRINT.md");

  if (!fs.existsSync(txSizePath)) {
    throw new Error(`txsize report not found: ${txSizePath}`);
  }
  if (!fs.existsSync(computePath)) {
    throw new Error(`compute report not found: ${computePath}`);
  }

  const txSize = readJson<TxSizeReport>(txSizePath);
  const compute = readJson<ComputeReport>(computePath);
  const soak = soakPath && fs.existsSync(soakPath) ? readJson<SoakReport>(soakPath) : undefined;

  const flowLines = txSize.flows
    .map((flow) => `| ${flow.flowId} | ${flow.serialized_tx_bytes} | ${flow.signatures_count} | ${flow.accounts_count} | ${flow.ix_data_bytes} | ${flow.uses_alt ? "yes" : "no"} |`)
    .join("\n");

  const computeLines = compute.flows
    .map((flow) => `- ${flow.flowId}: ${flow.unitsConsumed.toLocaleString()} CU${flow.ok === false ? ` (simulation error: ${flow.error ?? "unknown"})` : ""}`)
    .join("\n");

  const markdown = [
    "# FOOTPRINT",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Settlement Tx Size",
    "",
    "| Flow | tx bytes | signatures | accounts | ix data bytes | ALT |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
    flowLines,
    "",
    `- Smallest settlement tx: **${txSize.smallest_settlement_tx_bytes} bytes**`,
    `- Batch max anchors within ${txSize.tx_limit_bytes} bytes: **${txSize.batch_anchor_max_within_1232}**`,
    "",
    "## Compute",
    "",
    computeLines,
    `- Max observed: **${compute.maxUnits.toLocaleString()} CU** (threshold ${compute.thresholdMaxUnits.toLocaleString()} CU)`,
    "",
    "## Soak (10-agent)",
    "",
    soak?.summary
      ? `- runs: ${soak.summary.runs}, successRate: ${(soak.summary.successRate * 100).toFixed(2)}%, p50: ${soak.summary.p50LatencyMs.toFixed(1)} ms, p95: ${soak.summary.p95LatencyMs.toFixed(1)} ms`
      : "- no soak report found yet (run `npm run sim:soak`).",
    "",
    "## Benchmark Inputs",
    "",
    `- txsize report: ${txSizePath}`,
    `- compute report: ${computePath}`,
    `- soak report: ${soakPath ?? "none"}`,
    "",
    "## Verified Tier Definition",
    "",
    "- VERIFIED = fulfilled receipt whose anchor32 is confirmed on-chain (anchored=true, verificationTier=VERIFIED).",
    "- FAST = fulfilled + payment verified + valid signed receipt, regardless of anchor status.",
  ].join("\n");

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, markdown);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ok: true, outPath, txSizePath, computePath, soakPath }, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
