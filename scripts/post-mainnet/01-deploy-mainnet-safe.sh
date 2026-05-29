#!/usr/bin/env bash
set -euo pipefail

# Safe mainnet deploy wrapper.
# Run from repo root: bash scripts/post-mainnet/01-deploy-mainnet-safe.sh
#
# NEVER run `solana program close <PROGRAM_ID>` — that destroys deployed programs.
# Buffer recovery only: `solana program close --buffers -u mainnet-beta`

TIMESTAMP=$(date +%Y%m%dT%H%M%S)
LOG_DIR="logs/mainnet"
LOG_FILE="${LOG_DIR}/deploy-${TIMESTAMP}.log"

mkdir -p "$LOG_DIR"

echo "=== DNA x402 Safe Mainnet Deploy Wrapper ==="
echo "Logging to: $LOG_FILE"
echo ""

run_deploy() {
  bash scripts/deploy/mainnet-commercial.sh
}

# Run deploy with tee to capture output
if run_deploy 2>&1 | tee "$LOG_FILE"; then
  echo ""
  echo "=== DEPLOY COMPLETED SUCCESSFULLY ==="
  echo "Log: $LOG_FILE"
  echo ""
  echo "Next: run post-deploy verification:"
  echo "  npm run mainnet:verify"
  echo "  npm run mainnet:buffers"
  echo "  npm run mainnet:smoke:receipt"
else
  EXIT_CODE=$?
  echo ""
  echo "=== DEPLOY FAILED (exit $EXIT_CODE) ==="
  echo "Log saved to: $LOG_FILE"
  echo ""
  echo "--- RECOVERY STEPS ---"
  echo "1. Check for orphaned buffers (these waste SOL):"
  echo "   solana program show --buffers -u mainnet-beta"
  echo ""
  echo "2. If orphaned buffers found, close them to recover SOL:"
  echo "   solana program close --buffers -u mainnet-beta"
  echo ""
  echo "WARNING: NEVER run the following — it destroys deployed programs:"
  echo "   solana program close <PROGRAM_ID> --bypass-warning"
  echo ""
  echo "3. Fix the underlying issue, then re-run this script."
  exit $EXIT_CODE
fi
