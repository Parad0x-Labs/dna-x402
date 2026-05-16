import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function readDoc(fileName: string): string {
  return fs.readFileSync(path.join(repoRoot(), "docs", fileName), "utf8");
}

describe("production launch packet", () => {
  it("keeps production approval blocked until external approvals exist", () => {
    const approval = readDoc("DNA_X402_PRODUCTION_LAUNCH_APPROVAL.md");

    expect(approval).toContain("BLOCKED_NOT_PUBLIC_PRODUCTION_APPROVED");
    expect(approval).toContain("Public Beta Agent/API Pilot");
    expect(approval).toContain("PASSED_STAGING_PRODUCTION_CONTABO_SEQUENTIAL_RUN_PUBLIC_PROD_STILL_BLOCKED");
    expect(approval).toContain("https://parad0xlabs.com/x402/health");
    expect(approval).toContain("public metrics exposure is intentionally blocked");
    expect(approval).toContain("BLOCKED_COUNSEL_RESPONSE_PENDING");
    expect(approval).toContain("BLOCKED_BACKUP_OPERATORS_PENDING");
    expect(approval).toContain("CONTABO_FINAL_DUST_DRILL_PENDING");
    expect(approval).toContain("dna-x402-postgres-backup.timer");
    expect(approval).toContain("managed PITR or equivalent production backup policy pending");
    expect(approval).toContain("BLOCKED_RELEASE_TAG_REQUIRED");
    expect(approval).toContain("Decision: `BLOCKED`");

    for (const blocked of [
      "auto-sweep",
      "backend custody",
      "hidden fees",
      "unattended signing",
      "public netting",
      "physical goods",
      "high-risk categories",
      "Polymarket live movement",
      "broad multi-chain production settlement",
    ]) {
      expect(approval).toContain(blocked);
    }
  });

  it("adds a Public Beta gate without approving dangerous gates", () => {
    const gates = readDoc("DNA_X402_LIVE_GATE_CHECKLISTS.md");
    const pilotSection = gates.split("## Public Beta Agent/API Pilot Gate")[1]?.split("## Small-Scale Real-Money Builder/API Pilot Gate")[0] ?? "";

    expect(pilotSection).toContain("Approval: `PUBLIC_BETA_OPEN_LIMITED_SCOPE`");
    expect(pilotSection).toContain("production Postgres migration/health/concurrency/backup passed with no skips");
    expect(pilotSection).toContain("public-production backup operators assigned");
    expect(pilotSection).toContain("external counsel response received");
    expect(pilotSection).toContain("public direct fee collection unless the direct split gate is separately approved");

    for (const gate of [
      "Production Money Movement Gate",
      "Polymarket Live Movement Gate",
      "Public Netting Gate",
      "Physical Goods Gate",
      "High-Risk Category Gate",
      "Multi-Chain Settlement Gate",
      "Direct Split Fee Gate",
    ]) {
      const section = gates.split(`## ${gate}`)[1]?.split("\n## ")[0] ?? "";
      expect(section, `missing ${gate}`).toContain("Approval: `BLOCKED`");
    }
  });

  it("ships public messaging that forbids overclaiming", () => {
    const messaging = readDoc("DNA_X402_PUBLIC_LAUNCH_MESSAGING.md");

    expect(messaging).toContain("PUBLIC_BETA_MESSAGING_READY_LIMITED_SCOPE");
    expect(messaging).toContain("DNA x402 is in Public Beta.");
    expect(messaging).toContain("Current publishing status: `PUBLIC_BETA_ALLOWED_WITH_SCOPE_CAVEAT`");

    for (const forbidden of [
      "fully permissionless public marketplace",
      "all categories open",
      "we custody funds",
      "auto fee sweep",
      "Polymarket live",
      "guaranteed compliance",
      "legal approved everywhere",
    ]) {
      expect(messaging).toContain(forbidden);
    }
  });
});
