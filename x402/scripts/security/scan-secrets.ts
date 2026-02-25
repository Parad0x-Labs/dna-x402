import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

interface Finding {
  file: string;
  line: number;
  reason: string;
  snippet: string;
}

const MAX_BYTES = 1_000_000;

const LINE_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  {
    regex: /^\s*(?!#)(RECEIPT_SIGNING_SECRET|PRIVATE_KEY|SECRET_KEY|API_KEY|ANCHORING_KEYPAIR_PATH)\s*=\s*.+$/i,
    reason: "env-style secret assignment",
  },
  {
    regex: /\b(secret_key|mnemonic)\b/i,
    reason: "secret keyword",
  },
  {
    regex: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    reason: "private key block",
  },
  {
    regex: /\/Users\//,
    reason: "absolute user path",
  },
  {
    regex: /\[\s*(\d{1,3}\s*,\s*){40,}\d{1,3}\s*\]/,
    reason: "potential keypair byte array",
  },
];

function trackedFiles(repoRoot: string): string[] {
  const out = execSync("git ls-files", { cwd: repoRoot, encoding: "utf8" });
  return out.split("\n").map((line) => line.trim()).filter(Boolean);
}

function isIgnoredExample(file: string): boolean {
  return file.endsWith(".env.example")
    || file.endsWith(".example")
    || file.includes("/examples/")
    || file.includes("/fixtures/");
}

function hasForbiddenEnvFilename(file: string): boolean {
  const base = path.basename(file);
  return base === ".env" || base === ".env.local" || base === ".env.production";
}

function scanFile(repoRoot: string, relPath: string): Finding[] {
  const absolute = path.join(repoRoot, relPath);
  const stats = fs.statSync(absolute);
  if (!stats.isFile() || stats.size > MAX_BYTES) {
    return [];
  }

  const raw = fs.readFileSync(absolute, "utf8");
  const lines = raw.split(/\r?\n/);
  const findings: Finding[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const pattern of LINE_PATTERNS) {
      if (pattern.regex.test(line)) {
        findings.push({
          file: relPath,
          line: i + 1,
          reason: pattern.reason,
          snippet: line.trim().slice(0, 160),
        });
      }
    }
  }

  return findings;
}

function main(): void {
  const repoRoot = path.resolve(process.cwd(), "..");
  const files = trackedFiles(repoRoot);
  const findings: Finding[] = [];

  for (const relPath of files) {
    if (hasForbiddenEnvFilename(relPath)) {
      findings.push({
        file: relPath,
        line: 1,
        reason: "tracked env file",
        snippet: relPath,
      });
      continue;
    }

    if (isIgnoredExample(relPath)) {
      continue;
    }

    if (relPath.endsWith(".png") || relPath.endsWith(".jpg") || relPath.endsWith(".jpeg") || relPath.endsWith(".gif") || relPath.endsWith(".wasm") || relPath.endsWith(".zip")) {
      continue;
    }

    try {
      findings.push(...scanFile(repoRoot, relPath));
    } catch {
      // Ignore unreadable/binary files.
    }
  }

  if (findings.length > 0) {
    // eslint-disable-next-line no-console
    console.error("Secret scan failed with findings:");
    for (const finding of findings) {
      // eslint-disable-next-line no-console
      console.error(`- ${finding.file}:${finding.line} ${finding.reason} :: ${finding.snippet}`);
    }
    process.exitCode = 1;
    return;
  }

  // eslint-disable-next-line no-console
  console.log("Secret scan passed: no tracked env files or inline secret assignments found.");
}

main();
