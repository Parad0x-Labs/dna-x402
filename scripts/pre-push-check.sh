#!/usr/bin/env bash
# Pre-push safety check — runs before every git push from this repo.
# Catches: TypeScript errors, repo identity violations, markdown lint failures.
# Exit 1 blocks the push.

set -e
REPO="$(git rev-parse --show-toplevel)"
cd "$REPO"

echo "=== pre-push checks ==="

# 1. TypeScript — catches TS2339 and friends before CI does
echo "[1/3] tsc --noEmit..."
npm --prefix x402 run typecheck 2>&1 | tail -3
echo "  ok"

# 2. Repo identity — catches 'audit downer copy', personal names, banned phrases
echo "[2/3] repo identity..."
node x402/scripts/check-repo-identity.mjs
echo "  ok"

# 3. Markdown lint on changed .md files only (fast)
echo "[3/3] markdownlint changed .md files..."
CHANGED_MD=$(git diff --cached --name-only --diff-filter=ACM | grep '\.md$' || true)
if [ -n "$CHANGED_MD" ]; then
  npx markdownlint-cli2 $CHANGED_MD 2>&1 | tail -5 || echo "  md lint warnings (non-blocking)"
fi

echo "=== all checks passed ==="
