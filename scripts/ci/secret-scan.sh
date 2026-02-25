#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

npm --prefix x402 run security:scan

SCAN_EXCLUDES="scripts/ci/secret-scan.sh|x402/scripts/audit/run-prod-audit.ts"
hits=$(git ls-files | grep -Ev "$SCAN_EXCLUDES" | xargs -I{} sh -c "grep -n '/Us''ers/' \"{}\" >/dev/null 2>&1 && echo {}" || true)
if [ -n "$hits" ]; then
  echo "Absolute local paths found in tracked files:"
  echo "$hits"
  exit 1
fi

echo "Secret scan passed with no absolute /Users paths in tracked files."
