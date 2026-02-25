import fs from "node:fs";
import path from "node:path";
import { FlowTimingSummary } from "./metrics.js";

export interface GauntletDecisionInput {
  outDir: string;
  successRate: number;
  timings: FlowTimingSummary;
  apiP95HardLimitMs: number;
  chainP95SoftLimitMs: number;
  fastCount24h: number;
  verifiedCount24h: number;
  anchoredConfirmedCount: number;
  anchoredFinalizedCount: number;
  abuseChecks: Record<string, boolean>;
  feeWithinTolerance: boolean;
  providerPlusFeeEqualsTotal: boolean;
  auditProdPass: boolean;
  artifactSecretScanPass: boolean;
  notes: string[];
}

export function writeGoNoGo(input: GauntletDecisionInput): {
  decision: "GO" | "NO-GO";
  path: string;
} {
  const abusePass = Object.values(input.abuseChecks).every(Boolean);
  const apiLatencyPass = input.timings.api.p95Ms < input.apiP95HardLimitMs;
  const chainLatencySoftPass = input.timings.chain.count === 0 || input.timings.chain.p95Ms < input.chainP95SoftLimitMs;
  const decision = (
    input.successRate >= 0.995
    && apiLatencyPass
    && input.verifiedCount24h <= input.fastCount24h
    && input.anchoredConfirmedCount >= 50
    && abusePass
    && input.feeWithinTolerance
    && input.providerPlusFeeEqualsTotal
    && input.auditProdPass
    && input.artifactSecretScanPass
  ) ? "GO" : "NO-GO";

  const lines: string[] = [];
  lines.push("# GO/NO-GO (20 Agent Gauntlet)");
  lines.push("");
  lines.push(`Decision: ${decision}`);
  lines.push("");
  lines.push("## Key Metrics");
  lines.push(`- successRate: ${input.successRate}`);
  lines.push(`- api latency p50/p95/p99: ${input.timings.api.p50Ms}/${input.timings.api.p95Ms}/${input.timings.api.p99Ms} ms`);
  lines.push(`- chain confirm p50/p95/p99: ${input.timings.chain.p50Ms}/${input.timings.chain.p95Ms}/${input.timings.chain.p99Ms} ms`);
  lines.push(`- anchor confirm p50/p95/p99: ${input.timings.anchor.p50Ms}/${input.timings.anchor.p95Ms}/${input.timings.anchor.p99Ms} ms`);
  lines.push(`- FAST/VERIFIED (24h): ${input.fastCount24h}/${input.verifiedCount24h}`);
  lines.push(`- anchored confirmations (confirmed/finalized): ${input.anchoredConfirmedCount}/${input.anchoredFinalizedCount}`);
  lines.push("");
  lines.push("## Invariants");
  lines.push(`- api p95 < ${input.apiP95HardLimitMs} ms: ${apiLatencyPass ? "PASS" : "FAIL"}`);
  lines.push(`- chain p95 < ${input.chainP95SoftLimitMs} ms (soft): ${chainLatencySoftPass ? "PASS" : "WARN"}`);
  lines.push(`- abuse checks: ${abusePass ? "PASS" : "FAIL"}`);
  lines.push(`- fee within tolerance: ${input.feeWithinTolerance ? "PASS" : "FAIL"}`);
  lines.push(`- provider+fee==total: ${input.providerPlusFeeEqualsTotal ? "PASS" : "FAIL"}`);
  lines.push(`- audit:prod: ${input.auditProdPass ? "PASS" : "FAIL"}`);
  lines.push(`- artifact secret scan: ${input.artifactSecretScanPass ? "PASS" : "FAIL"}`);
  lines.push("");
  if (input.notes.length > 0) {
    lines.push("## Notes");
    for (const note of input.notes) {
      lines.push(`- ${note}`);
    }
    lines.push("");
  }

  const outPath = path.join(input.outDir, "GO_NO_GO_20AGENTS.md");
  fs.writeFileSync(outPath, `${lines.join("\n")}\n`);
  return { decision, path: outPath };
}
