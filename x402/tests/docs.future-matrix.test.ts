import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const approvedLabels = new Set([
  "READY_AFTER_PROD_GATES",
  "SUPPORTED_SANDBOX",
  "ARCHITECTURE_READY",
  "REQUIRES_ADAPTER",
  "REQUIRES_COUNSEL",
  "REQUIRES_MANUAL_OPS",
  "BLOCKED_BY_POLICY",
  "DO_NOT_BUILD_YET",
]);

const restrictedRows = [
  "Physical goods",
  "Polymarket agents",
  "Copy-agent fees",
  "High-risk categories",
  "Broad multi-chain production settlement",
  "Unattended live agent spending",
];

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

describe("future-proof commerce matrix", () => {
  it("uses only approved status labels and does not overclaim restricted rows", () => {
    const doc = fs.readFileSync(path.join(repoRoot(), "docs", "DNA_X402_FUTURE_PROOF_COMMERCE_MATRIX.md"), "utf8");
    const labels = [...doc.matchAll(/`([A-Z_]+)`/g)].map((match) => match[1]).filter((label) => approvedLabels.has(label) || /^[A-Z_]+$/.test(label));
    for (const label of labels) {
      expect(approvedLabels.has(label), `unapproved status label: ${label}`).toBe(true);
    }

    for (const rowName of restrictedRows) {
      const row = doc.split("\n").find((line) => line.includes(`| ${rowName} |`));
      expect(row, `missing restricted row ${rowName}`).toBeTruthy();
      expect(row).not.toContain("READY_AFTER_PROD_GATES");
      expect(row).not.toContain("SUPPORTED_SANDBOX");
    }
  });
});
