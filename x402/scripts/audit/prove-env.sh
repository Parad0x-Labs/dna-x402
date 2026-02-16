#!/usr/bin/env bash
set -euo pipefail

X402_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
WORKSPACE_ROOT="$(cd "$X402_DIR/.." && pwd)"
OUT_DIR="$X402_DIR/audit_out"
mkdir -p "$OUT_DIR"
OUT_FILE="$OUT_DIR/env.json"

node - <<'NODE' "$WORKSPACE_ROOT" "$OUT_FILE"
const { execSync } = require("node:child_process");
const fs = require("node:fs");

const workspaceRoot = process.argv[2];
const outFile = process.argv[3];

function run(cmd, cwd = workspaceRoot) {
  try {
    return {
      ok: true,
      stdout: execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8").trim(),
    };
  } catch (error) {
    const stdout = error.stdout ? error.stdout.toString("utf8").trim() : "";
    const stderr = error.stderr ? error.stderr.toString("utf8").trim() : "";
    return {
      ok: false,
      stdout,
      stderr,
      message: error.message,
    };
  }
}

const gitCommit = run("git rev-parse HEAD");
const gitStatus = run("git status --porcelain");
const gitAvailable = gitCommit.ok;
const dirty = gitAvailable ? (gitStatus.stdout.length > 0 ? "yes" : "no") : "unavailable";

const nodeVersion = run("node -v", workspaceRoot);
const npmVersion = run("npm -v", workspaceRoot);
const solanaVersion = run("solana --version", workspaceRoot);
const solanaConfig = run("solana config get", workspaceRoot);

const payload = {
  generatedAt: new Date().toISOString(),
  workspaceRoot,
  git: {
    available: gitAvailable,
    commit: gitCommit.ok ? gitCommit.stdout : null,
    dirty,
    statusPorcelain: gitStatus.ok ? gitStatus.stdout.split("\n").filter(Boolean) : [],
    error: gitAvailable ? null : (gitCommit.stderr || gitCommit.message || "git unavailable"),
  },
  tools: {
    node: nodeVersion.ok ? nodeVersion.stdout : null,
    npm: npmVersion.ok ? npmVersion.stdout : null,
    solana: solanaVersion.ok ? solanaVersion.stdout : null,
  },
  solanaConfig: {
    raw: solanaConfig.ok ? solanaConfig.stdout : null,
    error: solanaConfig.ok ? null : (solanaConfig.stderr || solanaConfig.message || "solana config get failed"),
  },
};

fs.mkdirSync(require("node:path").dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
console.log(JSON.stringify({ ok: true, outFile }, null, 2));
NODE
