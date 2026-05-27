import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve("..");
const canonical = "https://github.com/Parad0x-Labs/dna-x402";
const legacy = `https://github.com/Parad0x-Labs/${["x402", "dna"].join("-")}`;
const allowedLegacyFiles = new Set([
  "README.md",
  "docs/REPOSITORY_IDENTITY.md",
  "docs/INTERNAL_REVIEW.md",
  "docs/DNA_X402_GITHUB_EXPORT_INTERNAL_AUDIT.md",
]);
const publicEntryFiles = [
  "README.md",
  "x402/README.md",
  "x402/AGENTS.md",
  "docs/REPOSITORY_IDENTITY.md",
  "docs/BUILDER_QUICKSTART.md",
  "docs/AGENT_QUICKSTART.md",
  "docs/API_REFERENCE.md",
  "docs/DARK_NULL_PRIVACY_PATH.md",
];
const personalOperatorPattern = new RegExp(`\\b${["Sa", "ulius"].join("")}\\b`, "i");
const hypeLabelPattern = new RegExp(
  `\\b(?:${[["al", "ien"].join(""), ["uni", "corn"].join(""), ["moon", "shot"].join("")].join("|")})\\b`,
  "i",
);
const publicForbidden = [
  ["NOT_PRODUCTION", /NOT_PRODUCTION/i],
  ["mainnet_ready", /mainnet_ready/i],
  ["audit downer copy", /\b(?:not audited|no audit|no security audit)\b/i],
  ["local Windows path", /\b[A-Z]:\\/],
  ["absolute drive markdown path", /\/[A-Z]:/i],
  ["personal local path", /(?:C:\\Users|\/Users\/)/i],
  ["personal operator name", personalOperatorPattern],
  ["hype/internal labels", hypeLabelPattern],
  ["low-signal claim framing", new RegExp(`\\b${["hon", "est"].join("")}(?:ly)?\\b`, "i")],
];

function trackedFiles() {
  return execFileSync("git", ["ls-files"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .split(/\r?\n/)
    .filter(Boolean);
}

const failures = [];
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "x402", "package.json"), "utf8"));
if (packageJson.repository?.url !== canonical) {
  failures.push(`x402/package.json repository.url must be ${canonical}`);
}
if (packageJson.homepage !== `${canonical}#readme`) {
  failures.push(`x402/package.json homepage must be ${canonical}#readme`);
}

for (const rel of trackedFiles()) {
  if (!/\.(md|json|ts|tsx|js|mjs|toml|yml|yaml)$/i.test(rel)) continue;
  const file = path.join(root, rel);
  const text = fs.readFileSync(file, "utf8");
  if (text.includes(legacy) && !allowedLegacyFiles.has(rel)) {
    failures.push(`${rel} links to legacy mirror ${legacy}`);
  }
}

const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
if (!readme.includes(canonical)) {
  failures.push("README.md must include canonical dna-x402 repository URL");
}

for (const rel of publicEntryFiles) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    failures.push(`${rel} is missing from public entrypoint checks`);
    continue;
  }
  const text = fs.readFileSync(file, "utf8");
  for (const [label, pattern] of publicForbidden) {
    if (pattern.test(text)) {
      failures.push(`${rel} contains ${label}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("repo identity ok");
