import fs from "node:fs";
import path from "node:path";

interface CopyRecord {
  source: string;
  target: string;
}

function newestFileInDir(dir: string, predicate: (name: string) => boolean): string | undefined {
  if (!fs.existsSync(dir)) {
    return undefined;
  }
  const matches = fs.readdirSync(dir)
    .filter((name) => predicate(name))
    .map((name) => path.join(dir, name))
    .filter((fullPath) => fs.statSync(fullPath).isFile());

  if (matches.length === 0) {
    return undefined;
  }

  matches.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return matches[0];
}

function copyOrThrow(source: string | undefined, target: string, label: string, copied: CopyRecord[]): void {
  if (!source || !fs.existsSync(source)) {
    throw new Error(`missing required proof source: ${label}`);
  }
  fs.copyFileSync(source, target);
  copied.push({ source, target });
}

function main(): void {
  const x402Root = process.cwd();
  const repoRoot = path.resolve(x402Root, "..");
  const siteProofDir = path.join(repoRoot, "site", "public", "proof", "latest");
  fs.mkdirSync(siteProofDir, { recursive: true });

  const docsDir = path.join(repoRoot, "docs");
  const reportsDir = path.join(repoRoot, "reports");
  const auditOutDir = path.join(x402Root, "audit_out");

  const latestAuditFromReports = newestFileInDir(reportsDir, (name) => name.startsWith("audit-") && name.endsWith(".json"));
  const fallbackAudit = path.join(auditOutDir, "programmable_readiness.json");
  const latestAudit = latestAuditFromReports && fs.existsSync(latestAuditFromReports)
    ? latestAuditFromReports
    : (fs.existsSync(fallbackAudit) ? fallbackAudit : undefined);

  const programmabilityReport = path.join(auditOutDir, "PROGRAMMABILITY_READINESS_REPORT.md");
  const programmableDevnet = path.join(auditOutDir, "programmable_devnet.json");
  const programmableFallback = path.join(auditOutDir, "programmable_readiness.json");

  const copied: CopyRecord[] = [];
  copyOrThrow(path.join(docsDir, "FOOTPRINT.md"), path.join(siteProofDir, "footprint.md"), "docs/FOOTPRINT.md", copied);
  copyOrThrow(path.join(docsDir, "PROOF.md"), path.join(siteProofDir, "proof.md"), "docs/PROOF.md", copied);
  copyOrThrow(programmabilityReport, path.join(siteProofDir, "programmability.md"), "audit_out/PROGRAMMABILITY_READINESS_REPORT.md", copied);
  copyOrThrow(latestAudit, path.join(siteProofDir, "audit.json"), "latest audit json", copied);
  copyOrThrow(
    fs.existsSync(programmableDevnet) ? programmableDevnet : programmableFallback,
    path.join(siteProofDir, "programmable_devnet.json"),
    "audit_out/programmable_devnet.json or programmable_readiness.json",
    copied,
  );

  const manifestPath = path.join(siteProofDir, "manifest.json");
  const manifest = {
    generatedAt: new Date().toISOString(),
    files: copied.map((entry) => ({
      source: path.relative(repoRoot, entry.source),
      target: path.relative(repoRoot, entry.target),
    })),
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: true,
    outputDir: path.relative(repoRoot, siteProofDir),
    files: manifest.files,
  }, null, 2));
}

main();
