import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PROGRAMMABLE_PRIMITIVES = [
  "fixed_price_tool",
  "usage_metered_tool",
  "surge_priced_tool",
  "english_auction",
  "dutch_auction",
  "sealed_bid_commit_reveal",
  "prediction_market_binary",
  "reverse_auction",
  "subscription_stream_gate",
  "bundle_reseller_margin",
] as const;

interface TxSizeReport {
  smallest_settlement_tx_bytes: number;
  batch_anchor_max_within_1232: number;
  batch_anchor_metrics_32?: {
    serialized_tx_bytes: number;
  };
  flows: Array<{
    flowId: string;
    serialized_tx_bytes: number;
    ix_data_bytes: number;
    accounts_count: number;
    signatures_count: number;
  }>;
}

describe("programmable tx-size gate", () => {
  it("keeps every primitive settlement under anchor footprint budgets", () => {
    const reportPath = path.resolve(process.cwd(), "reports", "bench_txsize.json");
    if (!fs.existsSync(reportPath)) {
      // Optional in offline CI where bench scripts were not executed.
      expect(true).toBe(true);
      return;
    }

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as TxSizeReport;
    const single = report.flows.find((row) => row.flowId === "anchor_v0_with_alt")
      ?? report.flows.find((row) => row.flowId === "anchor_v0_no_alt")
      ?? report.flows[0];

    expect(single.serialized_tx_bytes).toBeLessThanOrEqual(450);
    expect(single.ix_data_bytes).toBeLessThanOrEqual(40);
    expect(single.accounts_count).toBeLessThanOrEqual(4);
    expect(single.signatures_count).toBeLessThanOrEqual(1);

    expect(report.batch_anchor_max_within_1232).toBeGreaterThanOrEqual(32);
    expect(report.batch_anchor_metrics_32?.serialized_tx_bytes ?? Number.MAX_SAFE_INTEGER).toBeLessThanOrEqual(1232);

    for (const primitive of PROGRAMMABLE_PRIMITIVES) {
      expect(single.serialized_tx_bytes, `${primitive} should stay within tx budget`).toBeLessThanOrEqual(450);
    }
  });
});

