#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
USE_TOOLS="${SCRIPT_DIR}/use-tools-wsl.sh"

step() {
  echo
  echo "==> $1"
}

if [[ -f "${USE_TOOLS}" ]]; then
  source "${USE_TOOLS}"
else
  echo "missing ${USE_TOOLS}; run scripts/dev/bootstrap-wsl-ubuntu.sh first" >&2
  exit 1
fi

step "Rust validation"
( cd "${REPO_ROOT}" && cargo test --manifest-path programs/receipt_anchor/Cargo.toml )

step "x402 install/build/test"
( cd "${REPO_ROOT}/x402" && npm ci && npm run build )
( cd "${REPO_ROOT}" && node scripts/dev/verify-x402-smoke.mjs )
( cd "${REPO_ROOT}/x402" && npm test )

step "site build"
( cd "${REPO_ROOT}/site" && npm run build )

step "site-agent install/build/test"
( cd "${REPO_ROOT}/site-agent" && npm ci && npm run build && npm test )

step "Verification complete"
