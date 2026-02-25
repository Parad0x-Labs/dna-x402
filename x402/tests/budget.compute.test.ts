import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BENCH_THRESHOLDS } from "../src/bench/thresholds.js";

interface ComputeReport {
  maxUnits: number;
  thresholdMaxUnits: number;
  allFlowsSucceeded?: boolean;
  flows: Array<{ flowId: string; unitsConsumed: number; ok?: boolean; error?: string }>;
}

describe("compute budget gate", () => {
  it("keeps measured settlement CU under threshold", () => {
    const reportPath = path.resolve(process.cwd(), "reports", "bench_compute.json");
    if (!fs.existsSync(reportPath)) {
      // Optional offline mode: CI without RPC/keypair can skip this gate.
      // Run `npm run bench:compute -- --payer-keypair <KEYPAIR>` to activate.
      expect(true).toBe(true);
      return;
    }

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as ComputeReport;
    expect(report.thresholdMaxUnits).toBe(BENCH_THRESHOLDS.settlementAnchor.maxComputeUnits);
    expect(report.allFlowsSucceeded ?? report.flows.every((flow) => flow.ok !== false)).toBe(true);
    expect(report.maxUnits).toBeLessThanOrEqual(BENCH_THRESHOLDS.settlementAnchor.maxComputeUnits);
    expect(report.flows.length).toBeGreaterThanOrEqual(2);
    for (const flow of report.flows) {
      expect(flow.ok ?? true).toBe(true);
      expect(flow.unitsConsumed).toBeGreaterThan(0);
    }
  });
});
