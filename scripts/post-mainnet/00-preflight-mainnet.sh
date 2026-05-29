#!/usr/bin/env bash
set -euo pipefail

# Preflight checks before a mainnet deploy or post-deploy verification run.
# Run this from the repo root: bash scripts/post-mainnet/00-preflight-mainnet.sh

DEPLOY_WALLET="F6Fr2Sn6jLMbpLMcg7ezrwNLZxs9MM8RYyifUAvP72BY"
MIN_SOL_LAMPORTS=1000000000  # 1 SOL in lamports (post-deploy, not pre-deploy requirement)

echo "=== DNA x402 Mainnet Preflight ==="
echo ""

# ── Git sync check ────────────────────────────────────────────────────────────
echo "Checking git state..."
git fetch origin main 2>&1
LOCAL_HASH=$(git rev-parse HEAD)
REMOTE_HASH=$(git rev-parse origin/main)
if [ "$LOCAL_HASH" != "$REMOTE_HASH" ]; then
  echo "FAIL: HEAD ($LOCAL_HASH) != origin/main ($REMOTE_HASH). Pull or push first."
  exit 1
fi
echo "OK: HEAD == origin/main ($LOCAL_HASH)"

# ── Solana CLI config ─────────────────────────────────────────────────────────
echo ""
echo "Solana CLI config:"
solana config get

# ── Deploy wallet check ───────────────────────────────────────────────────────
echo ""
echo "Checking deploy wallet on mainnet-beta..."
CURRENT_ADDRESS=$(solana address -u mainnet-beta 2>/dev/null || true)
if [ -z "$CURRENT_ADDRESS" ]; then
  echo "FAIL: Could not determine solana address. Check keypair config."
  exit 1
fi
if [ "$CURRENT_ADDRESS" != "$DEPLOY_WALLET" ]; then
  echo "FAIL: Active keypair resolves to $CURRENT_ADDRESS"
  echo "      Expected deploy wallet: $DEPLOY_WALLET"
  exit 1
fi
echo "OK: Active wallet matches deploy wallet ($DEPLOY_WALLET)"

# ── SOL balance check ─────────────────────────────────────────────────────────
echo ""
echo "Checking SOL balance..."
BALANCE_SOL=$(solana balance -u mainnet-beta 2>/dev/null | awk '{print $1}' || true)
if [ -z "$BALANCE_SOL" ]; then
  echo "FAIL: Could not retrieve balance."
  exit 1
fi
# Convert to lamports for integer comparison (remove decimal, multiply)
BALANCE_LAMPORTS=$(python3 -c "import math; print(math.floor(float('${BALANCE_SOL}') * 1_000_000_000))" 2>/dev/null \
  || node -e "console.log(Math.floor(parseFloat('${BALANCE_SOL}') * 1_000_000_000))" 2>/dev/null \
  || echo "0")
if [ "$BALANCE_LAMPORTS" -lt "$MIN_SOL_LAMPORTS" ]; then
  echo "FAIL: Balance ${BALANCE_SOL} SOL is below 1 SOL minimum."
  exit 1
fi
echo "OK: Balance ${BALANCE_SOL} SOL (>= 1 SOL required post-deploy)"

# ── Keypair files not tracked in git ─────────────────────────────────────────
echo ""
echo "Checking no keypair JSON files are tracked in git..."
TRACKED_KEYPAIRS=$(git ls-files scripts/keypairs/ 2>/dev/null | wc -l | tr -d ' ')
if [ "$TRACKED_KEYPAIRS" -gt 0 ]; then
  echo "FAIL: Keypair files are tracked in git:"
  git ls-files scripts/keypairs/
  exit 1
fi
echo "OK: No keypair files tracked in git"

# ── Config files exist ────────────────────────────────────────────────────────
echo ""
echo "Checking config files..."
if [ ! -f "configs/mainnet.commercial.json" ]; then
  echo "FAIL: configs/mainnet.commercial.json not found"
  exit 1
fi
if [ ! -f "configs/mainnet.oss.json" ]; then
  echo "FAIL: configs/mainnet.oss.json not found"
  exit 1
fi
echo "OK: Both mainnet config files exist"

# ── Config fee values (requires jq) ──────────────────────────────────────────
echo ""
echo "Checking config fee values..."
if ! command -v jq &>/dev/null; then
  echo "WARNING: jq not found — skipping fee value checks. Install jq for full preflight."
else
  COMMERCIAL_OPERATOR=$(jq -r '.operatorFeeBps' configs/mainnet.commercial.json)
  COMMERCIAL_PROTOCOL=$(jq -r '.protocolFeeBps' configs/mainnet.commercial.json)
  OSS_OPERATOR=$(jq '.operatorFeeBps // 0' configs/mainnet.oss.json)
  OSS_PROTOCOL=$(jq '.protocolFeeBps // 0' configs/mainnet.oss.json)

  if [ "$COMMERCIAL_OPERATOR" != "50" ]; then
    echo "FAIL: commercial operatorFeeBps expected 50, got $COMMERCIAL_OPERATOR"
    exit 1
  fi
  if [ "$COMMERCIAL_PROTOCOL" != "5" ]; then
    echo "FAIL: commercial protocolFeeBps expected 5, got $COMMERCIAL_PROTOCOL"
    exit 1
  fi
  if [ "$OSS_OPERATOR" != "0" ] && [ "$OSS_OPERATOR" != "null" ]; then
    echo "FAIL: OSS operatorFeeBps expected 0, got $OSS_OPERATOR"
    exit 1
  fi
  if [ "$OSS_PROTOCOL" != "0" ] && [ "$OSS_PROTOCOL" != "null" ]; then
    echo "FAIL: OSS protocolFeeBps expected 0, got $OSS_PROTOCOL"
    exit 1
  fi
  echo "OK: commercial operatorFeeBps=50, protocolFeeBps=5"
  echo "OK: OSS operatorFeeBps=0, protocolFeeBps=0"
fi

# ── x402 SDK build and test ───────────────────────────────────────────────────
echo ""
echo "Checking x402 SDK..."
if [ ! -d "x402/node_modules" ]; then
  echo "node_modules missing — running npm ci..."
  npm --prefix x402 ci
fi

echo "Building x402 SDK..."
npm --prefix x402 run build

echo "Running x402 tests..."
npm --prefix x402 test

echo "Running x402 security scan..."
npm --prefix x402 run security:scan

echo ""
echo "=== PREFLIGHT PASSED ==="
