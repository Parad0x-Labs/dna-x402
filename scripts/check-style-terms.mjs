#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const blockedTerms = [
  ["al", "ien"].join(""),
  ["uni", "corn"].join(""),
  ["hon", "est"].join(""),
  ["hon", "estly"].join(""),
];

const scanExtensions = new Set([
  ".md",
  ".txt",
  ".js",
  ".mjs",
  ".ts",
  ".tsx",
  ".rs",
  ".toml",
  ".json",
  ".yml",
  ".yaml",
]);

const skipFragments = [
  "node_modules/",
  "target/",
  "dist/",
  ".git/",
  ".npm-cache/",
  "exports/",
  "package-lock.json",
  "Cargo.lock",
];

function trackedFiles() {
  return execFileSync("git", ["ls-files"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split(/\r?\n/)
    .filter(Boolean);
}

function shouldScan(rel) {
  const normalized = rel.replace(/\\/g, "/");
  if (skipFragments.some((fragment) => normalized.includes(fragment))) return false;
  return scanExtensions.has(path.extname(normalized).toLowerCase());
}

const failures = [];

for (const rel of trackedFiles().filter(shouldScan)) {
  const text = fs.readFileSync(path.join(root, rel), "utf8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lower = line.toLowerCase();
    for (const term of blockedTerms) {
      if (lower.includes(term)) {
        failures.push(`${rel}:${index + 1}: blocked low-signal term`);
      }
    }
  });
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("style term scan ok");
