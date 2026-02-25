#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

npm --prefix x402 run security:scan

if git ls-files | xargs -I{} sh -c "grep -n '/Users/' \"{}\" >/dev/null 2>&1 && echo {}" | grep -q .; then
  echo "Absolute /Users paths found in tracked files."
  git ls-files | xargs -I{} sh -c "grep -n '/Users/' \"{}\" >/dev/null 2>&1 && echo {}"
  exit 1
fi

echo "Secret scan passed with no absolute /Users paths in tracked files."
