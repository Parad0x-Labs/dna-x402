import fs from "node:fs";
import path from "node:path";

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
const publicForbidden = [
  ["NOT_PRODUCTION", /NOT_PRODUCTION/i],
  ["mainnet_ready", /mainnet_ready/i],
  ["audit downer copy", /\b(?:not audited|no audit|no security audit)\b/i],
  ["local Windows path", /\b[A-Z]:\\/],
  ["absolute drive markdown path", /\/[A-Z]:/i],
  ["personal local path", /(?:C:\\Users|\/Users\/)/i],
  ["personal operator name", /\bSaulius\b/],
  ["low-signal honesty wording", /\bhonest(?:ly)?\b/i],
];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if ([".deploy", ".git", ".runtime", ".tmp", ".tools", "dist", "node_modules", "target", "vault-staging"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const failures = [];
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "x402", "package.json"), "utf8"));
if (packageJson.repository?.url !== canonical) {
  failures.push(`x402/package.json repository.url must be ${canonical}`);
}
if (packageJson.homepage !== `${canonical}#readme`) {
  failures.push(`x402/package.json homepage must be ${canonical}#readme`);
}

for (const file of walk(root)) {
  const rel = path.relative(root, file).replace(/\\/g, "/");
  if (!/\.(md|json|ts|tsx|js|mjs|toml|yml|yaml)$/i.test(rel)) continue;
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
