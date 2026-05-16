import fs from "node:fs";
import path from "node:path";
import { buildProductionEvidenceReport, redactValue } from "../../src/deploy/productionEvidence.js";

function hasFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag);
}

function stamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function probe(url: string, label: string): Promise<{ label: string; url: string; ok: boolean; status?: number; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return {
      label,
      url: redactValue(`${label}_URL`, url),
      ok: response.ok,
      status: response.status,
    };
  } catch (error) {
    return {
      label,
      url: redactValue(`${label}_URL`, url),
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const allowBlockedReport = hasFlag("--allow-blocked-report");
  const yesProductionEvidence = hasFlag("--yes-production-evidence");

  const report = buildProductionEvidenceReport(process.env);
  const probes = [];

  const apiUrl = process.env.X402_PRODUCTION_API_URL?.trim();
  if (apiUrl) {
    probes.push(await probe(new URL("/health", apiUrl).toString(), "production_api_health"));
    probes.push(await probe(new URL("/metrics", apiUrl).toString(), "production_api_metrics"));
  }

  const frontendUrl = process.env.X402_PRODUCTION_FRONTEND_URL?.trim();
  if (frontendUrl) {
    probes.push(await probe(frontendUrl, "production_frontend"));
  }

  const monitoringUrl = process.env.X402_PRODUCTION_MONITORING_URL?.trim();
  if (monitoringUrl) {
    probes.push(await probe(monitoringUrl, "production_monitoring"));
  }

  const reportDir = path.resolve(process.cwd(), "..", "reports", "production-launch", `${stamp()}-production-evidence`);
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "production-launch-evidence.redacted.json");
  fs.writeFileSync(reportPath, `${JSON.stringify({
    ...report,
    probes,
    approvalDecision: report.status === "PASS" && yesProductionEvidence
      ? "EVIDENCE_COLLECTED_NOT_APPROVAL"
      : "BLOCKED_OR_DRY_RUN",
  }, null, 2)}\n`);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: report.status === "PASS",
    status: report.status,
    reportPath,
    blockers: report.blockers,
    probes,
  }, null, 2));

  if (report.status !== "PASS" && !allowBlockedReport) {
    throw new Error("Production evidence is blocked. Re-run with --allow-blocked-report only to save a blocked evidence report.");
  }
  if (report.status === "PASS" && !yesProductionEvidence) {
    throw new Error("Production evidence fields look complete, but --yes-production-evidence was not supplied.");
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
