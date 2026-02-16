#!/usr/bin/env bash
set -euo pipefail

X402_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
WORKSPACE_ROOT="$(cd "$X402_DIR/.." && pwd)"
REPORTS_DIR="$WORKSPACE_ROOT/reports"
OUT_DIR="$X402_DIR/audit_out"
mkdir -p "$OUT_DIR"

DEPLOYER_KEYPAIR="${DEPLOYER_KEYPAIR:-/Users/sauliuskruopis/.config/solana/devnet-deployer.json}"
LATEST_LEDGER="$(ls -1t "$REPORTS_DIR"/deploy-ledger-*.json 2>/dev/null | head -n1 || true)"
if [ -z "$LATEST_LEDGER" ]; then
  echo "No deploy-ledger-*.json found in $REPORTS_DIR" >&2
  exit 1
fi

PROGRAM_ID="${PROGRAM_ID:-}"
if [ -z "$PROGRAM_ID" ]; then
  PROGRAM_ID="$(node -e 'const fs=require("fs");const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,"utf8"));const id=(j.entries&&j.entries[0]&&j.entries[0].programId)||"";process.stdout.write(id);' "$LATEST_LEDGER")"
fi
if [ -z "$PROGRAM_ID" ]; then
  echo "PROGRAM_ID not provided and not found in ledger: $LATEST_LEDGER" >&2
  exit 1
fi

solana program show "$PROGRAM_ID" -u devnet > "$OUT_DIR/program_show.txt" 2>&1
solana address -k "$DEPLOYER_KEYPAIR" > "$OUT_DIR/deployer_address.txt"
solana balance -k "$DEPLOYER_KEYPAIR" -u devnet > "$OUT_DIR/deployer_balance_now.txt"

solana program show --buffers -u devnet -k "$DEPLOYER_KEYPAIR" > "$OUT_DIR/buffers_before.txt" 2>&1 || true
solana program show --buffers -u devnet -k "$DEPLOYER_KEYPAIR" --output json-compact > "$OUT_DIR/buffers_before.json" 2>&1 || true
solana balance -u devnet -k "$DEPLOYER_KEYPAIR" > "$OUT_DIR/balance_before_close.txt"

set +e
solana program close --buffers -u devnet -k "$DEPLOYER_KEYPAIR" --bypass-warning > "$OUT_DIR/close_buffers.txt" 2>&1
CLOSE_EXIT=$?
set -e

solana balance -u devnet -k "$DEPLOYER_KEYPAIR" > "$OUT_DIR/balance_after_close.txt"
solana program show --buffers -u devnet -k "$DEPLOYER_KEYPAIR" > "$OUT_DIR/buffers_after.txt" 2>&1 || true
solana program show --buffers -u devnet -k "$DEPLOYER_KEYPAIR" --output json-compact > "$OUT_DIR/buffers_after.json" 2>&1 || true

node - <<'NODE' "$LATEST_LEDGER" "$OUT_DIR/deployer_address.txt" "$OUT_DIR/deployer_balance_now.txt" "$OUT_DIR/balance_before_close.txt" "$OUT_DIR/balance_after_close.txt" "$OUT_DIR/buffers_before.json" "$OUT_DIR/buffers_after.json" "$OUT_DIR/devnet.json" "$PROGRAM_ID" "$CLOSE_EXIT"
const fs = require("node:fs");

const [ledgerPath, addressPath, nowBalancePath, beforePath, afterPath, beforeJsonPath, afterJsonPath, outPath, programId, closeExitRaw] = process.argv.slice(2);

function read(path) {
  return fs.existsSync(path) ? fs.readFileSync(path, "utf8").trim() : "";
}

function parseBalance(raw) {
  if (!raw) return null;
  const m = raw.match(/(-?\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

function parseBuffers(jsonPath) {
  try {
    const parsed = JSON.parse(read(jsonPath));
    const buffers = Array.isArray(parsed.buffers) ? parsed.buffers : [];
    return { count: buffers.length, buffers };
  } catch {
    return { count: null, buffers: [] };
  }
}

const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
const beforeClose = parseBalance(read(beforePath));
const afterClose = parseBalance(read(afterPath));
const beforeBuffers = parseBuffers(beforeJsonPath);
const afterBuffers = parseBuffers(afterJsonPath);
const reclaimed = (beforeClose !== null && afterClose !== null)
  ? Number((afterClose - beforeClose).toFixed(9))
  : null;

const payload = {
  generatedAt: new Date().toISOString(),
  cluster: "devnet",
  program_id: programId,
  deployer_keypair: process.env.DEPLOYER_KEYPAIR || null,
  deployer_address: read(addressPath),
  balance_now: read(nowBalancePath),
  deploy_ledger_file: ledgerPath,
  balance_before: ledger.balanceBeforeLamports ?? null,
  balance_after: ledger.balanceAfterLamports ?? null,
  delta_sol: ledger.totalDeltaSol ?? null,
  deployed_programs: Array.isArray(ledger.entries)
    ? ledger.entries.map((e) => ({
      programName: e.programName,
      programId: e.programId,
      success: e.success,
      deltaSol: e.deltaSol,
    }))
    : [],
  buffers_before_count: beforeBuffers.count,
  buffers_after_count: afterBuffers.count,
  reclaimed_sol: reclaimed,
  close_buffers_exit_code: Number(closeExitRaw),
  files: {
    program_show: "audit_out/program_show.txt",
    deployer_address: "audit_out/deployer_address.txt",
    deployer_balance_now: "audit_out/deployer_balance_now.txt",
    buffers_before: "audit_out/buffers_before.txt",
    buffers_after: "audit_out/buffers_after.txt",
    balance_before_close: "audit_out/balance_before_close.txt",
    balance_after_close: "audit_out/balance_after_close.txt",
    close_buffers: "audit_out/close_buffers.txt",
  },
};

fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(JSON.stringify({ ok: true, outPath, programId, buffersBefore: beforeBuffers.count, buffersAfter: afterBuffers.count, reclaimedSol: reclaimed }, null, 2));
NODE
