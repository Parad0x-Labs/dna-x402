import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

interface CheckResult {
  name: string;
  ok: boolean;
  command?: string;
  details?: string;
  stdout?: string;
  stderr?: string;
}

interface ProdAuditReport {
  generatedAt: string;
  cwd: string;
  overallOk: boolean;
  checks: CheckResult[];
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[:]/g, "-");
}

function runCommand(cwd: string, name: string, command: string, args: string[]): CheckResult {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
  });

  return {
    name,
    ok: (result.status ?? 1) === 0,
    command: [command, ...args].join(" "),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    details: `exit=${result.status ?? 1}`,
  };
}

function runUsersPathCheck(repoRoot: string): CheckResult {
  const result = spawnSync("git", ["grep", "-n", "/Users/"], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
  });

  if (result.status === 1) {
    return {
      name: "no_absolute_users_paths",
      ok: true,
      command: "git grep -n /Users/",
      details: "no tracked /Users/ paths found",
      stdout: "",
      stderr: "",
    };
  }

  return {
    name: "no_absolute_users_paths",
    ok: false,
    command: "git grep -n /Users/",
    details: "tracked files still contain /Users/ paths",
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runRequiredFilesCheck(repoRoot: string): CheckResult {
  const required = [
    "docs/X402_COMPAT.md",
    "docs/SECURITY.md",
    "scripts/ci/secret-scan.sh",
    ".github/workflows/security-scan.yml",
  ];

  const missing = required.filter((entry) => !fs.existsSync(path.join(repoRoot, entry)));
  if (missing.length > 0) {
    return {
      name: "required_files_present",
      ok: false,
      details: `missing: ${missing.join(", ")}`,
    };
  }

  return {
    name: "required_files_present",
    ok: true,
    details: "all required files present",
  };
}

function writeReport(repoRoot: string, report: ProdAuditReport): string {
  const reportsDir = path.join(repoRoot, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const outPath = path.join(reportsDir, `prod-audit-${nowStamp()}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return outPath;
}

function main(): void {
  const x402Dir = process.cwd();
  const repoRoot = path.resolve(x402Dir, "..");

  const checks: CheckResult[] = [];

  checks.push(runRequiredFilesCheck(repoRoot));
  checks.push(runCommand(x402Dir, "security_scan", "npm", ["run", "security:scan"]));
  checks.push(runUsersPathCheck(repoRoot));
  checks.push(runCommand(x402Dir, "dx_security_tests", "npx", [
    "vitest",
    "run",
    "tests/x402.errors.test.ts",
    "tests/x402.doctor.test.ts",
    "tests/replay.test.ts",
    "tests/receipt.binding.test.ts",
    "tests/logging.redact.test.ts",
  ]));

  const overallOk = checks.every((check) => check.ok);
  const report: ProdAuditReport = {
    generatedAt: new Date().toISOString(),
    cwd: x402Dir,
    overallOk,
    checks,
  };

  const reportPath = writeReport(repoRoot, report);
  // eslint-disable-next-line no-console
  console.log(`prod audit report: ${path.relative(repoRoot, reportPath)}`);
  if (!overallOk) {
    for (const check of checks) {
      if (!check.ok) {
        // eslint-disable-next-line no-console
        console.error(`[fail] ${check.name}: ${check.details ?? "failed"}`);
        if (check.stdout) {
          // eslint-disable-next-line no-console
          console.error(check.stdout.trim());
        }
        if (check.stderr) {
          // eslint-disable-next-line no-console
          console.error(check.stderr.trim());
        }
      }
    }
    process.exitCode = 1;
    return;
  }

  // eslint-disable-next-line no-console
  console.log("prod audit passed");
}

main();
