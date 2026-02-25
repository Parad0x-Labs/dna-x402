#!/usr/bin/env bash
set -euo pipefail

X402_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="$X402_DIR/audit_out"
mkdir -p "$OUT_DIR"

DEPLOYER_KEYPAIR="${DEPLOYER_KEYPAIR:-$HOME/.config/solana/devnet-deployer.json}"
UPGRADE_AUTHORITY="${UPGRADE_AUTHORITY:-./deployer_wallet.json}"

RESULTS_TSV="$OUT_DIR/tests_results.tsv"
: > "$RESULTS_TSV"

run_cmd() {
  local log_name="$1"
  local command="$2"
  local log_file="$OUT_DIR/log_${log_name}.txt"
  local safe_command="${command//$/\\$}"

  echo "[audit] running ${log_name}: ${command}"
  set +e
  (
    cd "$X402_DIR"
    bash -lc "$safe_command"
  ) >"$log_file" 2>&1
  local code=$?
  set -e
  local sha
  sha="$(shasum -a 256 "$log_file" | awk '{print $1}')"

  printf "%s\t%s\t%s\t%s\t%s\n" "$log_name" "$command" "$code" "$log_file" "$sha" >> "$RESULTS_TSV"
}

run_cmd "npm_ci" "npm ci"
run_cmd "typecheck" "npm run typecheck:x402"
run_cmd "test" "npm test"
run_cmd "wow" "npm run test:wow"
run_cmd "market" "npm run test:market"
run_cmd "sim10" "npm run sim:10agents"
run_cmd "auditfull" "MARKET_ALLOW_DEV_INGEST=0 npm run audit:full -- --cluster devnet --deployer-keypair \"$DEPLOYER_KEYPAIR\" --upgrade-authority \"$UPGRADE_AUTHORITY\""

node - <<'NODE' "$RESULTS_TSV" "$OUT_DIR/tests.json"
const fs = require("node:fs");
const inPath = process.argv[2];
const outPath = process.argv[3];
const lines = fs.readFileSync(inPath, "utf8").split("\n").filter(Boolean);
const rows = lines.map((line) => {
  const [name, command, exitCode, logFile, sha256] = line.split("\t");
  return {
    name,
    command,
    exitCode: Number(exitCode),
    logFile,
    sha256,
  };
});
const payload = {
  generatedAt: new Date().toISOString(),
  allPassed: rows.every((row) => row.exitCode === 0),
  results: rows,
};
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(JSON.stringify({ ok: true, outPath, allPassed: payload.allPassed, count: rows.length }, null, 2));
NODE

if jq -e '.allPassed == true' "$OUT_DIR/tests.json" >/dev/null 2>&1; then
  exit 0
fi

node -e 'const fs=require("fs");const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,"utf8"));if(!j.allPassed){process.exit(1)}' "$OUT_DIR/tests.json"
