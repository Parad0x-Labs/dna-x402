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

function npmArgs(args: string[]): { command: string; args: string[] } {
  if (process.env.npm_execpath) {
    return { command: process.execPath, args: [process.env.npm_execpath, ...args] };
  }
  return { command: process.platform === "win32" ? "npm.cmd" : "npm", args };
}

function runNpm(cwd: string, name: string, args: string[]): CheckResult {
  const resolved = npmArgs(args);
  return runCommand(cwd, name, resolved.command, resolved.args);
}

function trackedFiles(repoRoot: string): string[] {
  const result = spawnSync("git", ["ls-files"], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr || "git ls-files failed");
  }
  return (result.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function looksTextual(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return ![
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".wasm",
    ".zip",
    ".gz",
    ".tgz",
    ".bz2",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
  ].includes(extension);
}

function runUsersPathCheck(repoRoot: string): CheckResult {
  const findings: string[] = [];
  for (const relPath of trackedFiles(repoRoot)) {
    const absolute = path.join(repoRoot, relPath);
    if (!looksTextual(absolute)) {
      continue;
    }
    try {
      const text = fs.readFileSync(absolute, "utf8");
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (/\/Users\//.test(lines[i]) || /[A-Za-z]:\\Users\\/.test(lines[i])) {
          findings.push(`${relPath}:${i + 1}:${lines[i].trim().slice(0, 160)}`);
        }
      }
    } catch {
      continue;
    }
  }

  if (findings.length === 0) {
    return {
      name: "no_absolute_users_paths",
      ok: true,
      command: "git ls-files + node path scan",
      details: "no tracked absolute user-home paths found",
      stdout: "",
      stderr: "",
    };
  }

  return {
    name: "no_absolute_users_paths",
    ok: false,
    command: "git ls-files + node path scan",
    details: "tracked files still contain absolute user-home paths",
    stdout: findings.join("\n"),
    stderr: "",
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
  checks.push(runNpm(x402Dir, "build", ["run", "build"]));
  checks.push(runNpm(x402Dir, "security_scan", ["run", "security:scan"]));
  checks.push(runUsersPathCheck(repoRoot));
  checks.push(runNpm(x402Dir, "prod_dependency_audit", ["audit", "--omit", "dev", "--audit-level=high"]));
  checks.push(runNpm(x402Dir, "full_dependency_audit", ["audit", "--audit-level=high"]));
  checks.push(runNpm(x402Dir, "dx_security_tests", [
    "exec",
    "--",
    "vitest",
    "run",
    "tests/x402.errors.test.ts",
    "tests/x402.doctor.test.ts",
    "tests/replay.test.ts",
    "tests/receipt.binding.test.ts",
    "tests/logging.redact.test.ts",
  ]));
  checks.push(runNpm(x402Dir, "site_agent_build", ["--prefix", "../site-agent", "run", "build"]));
  checks.push(runNpm(x402Dir, "site_agent_prod_dependency_audit", ["--prefix", "../site-agent", "audit", "--omit", "dev", "--audit-level=high"]));
  checks.push(runNpm(x402Dir, "site_agent_full_dependency_audit", ["--prefix", "../site-agent", "audit", "--audit-level=high"]));

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
