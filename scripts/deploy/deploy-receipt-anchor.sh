#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLUSTER="${CLUSTER:-devnet}"
KEYPAIR="${DEPLOYER_KEYPAIR:-${KEYPAIR:-}}"
UPGRADE_AUTHORITY="${UPGRADE_AUTHORITY:-${KEYPAIR}}"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/reports}"
PROGRAM_SO="$REPO_ROOT/target/deploy/receipt_anchor.so"

echo "[receipt-anchor] building SBF program"
cargo-build-sbf \
  --manifest-path "$REPO_ROOT/programs/receipt_anchor/Cargo.toml" \
  --sbf-out-dir "$REPO_ROOT/target/deploy"

if [[ ! -f "$PROGRAM_SO" ]]; then
  echo "receipt_anchor.so not found at $PROGRAM_SO" >&2
  exit 1
fi

echo "[receipt-anchor] deploying via ledger script"
cd "$REPO_ROOT/x402"

ARGS=(--cluster "$CLUSTER" --program "$PROGRAM_SO" --out "$OUT_DIR/deploy-ledger-receipt-anchor-$(date -u +%Y%m%dT%H%M%SZ).json")
if [[ -n "$KEYPAIR" ]]; then
  ARGS+=(--keypair "$KEYPAIR")
fi
if [[ -n "$UPGRADE_AUTHORITY" ]]; then
  ARGS+=(--upgrade-authority "$UPGRADE_AUTHORITY")
fi

npm run deploy:ledger -- "${ARGS[@]}"

echo "[receipt-anchor] done"
