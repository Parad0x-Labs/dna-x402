#!/usr/bin/env bash
set -euo pipefail

X402_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
WORKSPACE_ROOT="$(cd "$X402_DIR/.." && pwd)"
REPORTS_DIR="$WORKSPACE_ROOT/reports"
OUT_DIR="$X402_DIR/audit_out"
mkdir -p "$OUT_DIR"

export DEPLOYER_KEYPAIR="${DEPLOYER_KEYPAIR:-/Users/sauliuskruopis/.config/solana/devnet-deployer.json}"
export UPGRADE_AUTHORITY="${UPGRADE_AUTHORITY:-/Users/sauliuskruopis/Desktop/dark \$NULL/dark_null_protocol/deployer_wallet.json}"
export MARKET_ALLOW_DEV_INGEST="0"

"$X402_DIR/scripts/audit/prove-env.sh"
"$X402_DIR/scripts/audit/run-tests-proof.sh"
"$X402_DIR/scripts/audit/prove-devnet.sh"

if [ "${SMOKE_WITH_TX_SIGNATURE:-0}" = "1" ]; then
  npx tsx "$X402_DIR/scripts/audit/devnet-smoke.ts" \
    --out-dir "$OUT_DIR" \
    --base-url "${DEVNET_X402_BASE_URL:-}" \
    --with-tx-signature \
    --payer-keypair "$DEPLOYER_KEYPAIR" \
    --rpc-url "${SOLANA_RPC_URL:-https://api.devnet.solana.com}"
else
  npx tsx "$X402_DIR/scripts/audit/devnet-smoke.ts" --out-dir "$OUT_DIR"
fi
MARKET_ALLOW_DEV_INGEST=0 npx tsx "$X402_DIR/scripts/audit/capture-market.ts" --out-dir "$OUT_DIR"
npx tsx "$X402_DIR/scripts/audit/export-receipts.ts" --sample 10 --out "$OUT_DIR/receipts_sample.json"

LATEST_SIM="$(ls -1t "$REPORTS_DIR"/sim-10agents-*.json 2>/dev/null | head -n1 || true)"
if [ -n "$LATEST_SIM" ]; then
  cp "$LATEST_SIM" "$OUT_DIR/sim10.json"
else
  echo "No sim-10agents report found in $REPORTS_DIR" >&2
  exit 1
fi

npx tsx "$X402_DIR/scripts/audit/build-evidence.ts" --out-dir "$OUT_DIR"

echo "[audit] reality check completed: $OUT_DIR"
