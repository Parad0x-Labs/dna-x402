import fs from "node:fs";
import path from "node:path";
import { runTenAgentSimulation } from "./run-10agents.js";
import { BENCH_THRESHOLDS } from "../../src/bench/thresholds.js";

interface SoakRunSummary {
  run: number;
  seed: number;
  latencyMs: number;
  success: boolean;
  passedScenarios: number;
  failedScenarios: number;
  fastCount24h: number;
  verifiedCount24h: number;
}

interface SoakReport {
  generatedAt: string;
  cluster: string;
  durationMsRequested: number;
  completedDurationMs: number;
  runs: SoakRunSummary[];
  summary: {
    runs: number;
    successes: number;
    failures: number;
    successRate: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    retriesCount: number;
    avgFastCount: number;
    avgVerifiedCount: number;
  };
  budget: {
    minSuccessRate: number;
    maxP95LatencyMs: number;
    pass: boolean;
  };
}

function parseFlagValue(args: string[], flag: string): string | undefined {
  const index = args.findIndex((arg) => arg === flag);
  if (index === -1 || index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const durationMs = parsePositiveInt(parseFlagValue(argv, "--duration-ms"), 5 * 60_000);
  const cluster = parseFlagValue(argv, "--cluster") ?? "devnet";
  const baseSeed = parsePositiveInt(parseFlagValue(argv, "--seed"), 720_260_216);
  const outPath = parseFlagValue(argv, "--out")
    ?? path.resolve(process.cwd(), "reports", `soak-${new Date().toISOString().replace(/[:]/g, "-")}.json`);

  const startedAt = Date.now();
  const runSummaries: SoakRunSummary[] = [];
  let run = 0;

  while (Date.now() - startedAt < durationMs) {
    run += 1;
    const seed = baseSeed + run;
    const runStarted = Date.now();

    try {
      const { report } = await runTenAgentSimulation({
        baseSeed: seed,
        cluster,
      });
      const runLatency = Date.now() - runStarted;
      runSummaries.push({
        run,
        seed,
        latencyMs: runLatency,
        success: report.failedScenarios === 0,
        passedScenarios: report.passedScenarios,
        failedScenarios: report.failedScenarios,
        fastCount24h: report.analyticsConsistency.fastCount24h,
        verifiedCount24h: report.analyticsConsistency.verifiedCount24h,
      });
    } catch {
      const runLatency = Date.now() - runStarted;
      runSummaries.push({
        run,
        seed,
        latencyMs: runLatency,
        success: false,
        passedScenarios: 0,
        failedScenarios: 6,
        fastCount24h: 0,
        verifiedCount24h: 0,
      });
    }
  }

  const latencies = runSummaries.map((entry) => entry.latencyMs);
  const successes = runSummaries.filter((entry) => entry.success).length;
  const failures = runSummaries.length - successes;
  const successRate = runSummaries.length === 0 ? 0 : successes / runSummaries.length;
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const retriesCount = runSummaries.reduce((acc, entry) => acc + entry.failedScenarios, 0);
  const avgFastCount = runSummaries.length === 0
    ? 0
    : runSummaries.reduce((acc, entry) => acc + entry.fastCount24h, 0) / runSummaries.length;
  const avgVerifiedCount = runSummaries.length === 0
    ? 0
    : runSummaries.reduce((acc, entry) => acc + entry.verifiedCount24h, 0) / runSummaries.length;

  const budgetPass = successRate >= BENCH_THRESHOLDS.soak.minSuccessRate
    && p95 <= BENCH_THRESHOLDS.soak.maxP95LatencyMs;

  const report: SoakReport = {
    generatedAt: new Date().toISOString(),
    cluster,
    durationMsRequested: durationMs,
    completedDurationMs: Date.now() - startedAt,
    runs: runSummaries,
    summary: {
      runs: runSummaries.length,
      successes,
      failures,
      successRate,
      p50LatencyMs: p50,
      p95LatencyMs: p95,
      retriesCount,
      avgFastCount,
      avgVerifiedCount,
    },
    budget: {
      minSuccessRate: BENCH_THRESHOLDS.soak.minSuccessRate,
      maxP95LatencyMs: BENCH_THRESHOLDS.soak.maxP95LatencyMs,
      pass: budgetPass,
    },
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: budgetPass,
    outPath,
    runs: report.summary.runs,
    successRate: report.summary.successRate,
    p95LatencyMs: report.summary.p95LatencyMs,
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
