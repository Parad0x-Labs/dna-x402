#!/usr/bin/env bash
set -euo pipefail

# NULL Miner — devnet dress rehearsal: all 8 programs.
# No confirmation prompt. Auto-blast devnet. Writes real IDs to configs/devnet.oss.json.
# Uses separate keypairs dir (scripts/keypairs/devnet-rehearsal) to stay clean.
#
# Cost: ~6.6 SOL peak rent during deploy, ~4.1 SOL permanent.
# Run from repo root: bash scripts/deploy/devnet-rehearsal.sh

CLUSTER_URL="https://api.devnet.solana.com"
KEYPAIRS_DIR="scripts/keypairs/devnet-rehearsal"
BUILD_DIR="target/deploy"
CONFIG="configs/devnet.oss.json"

PROGRAMS=(
  "dark_semaphore"
  "dark_secp256r1_vault"
  "dark_secp256k1_auth"
  "null_token_hook"
  "null_lottery"
  "null_mint_gate"
  "receipt_anchor"
  "dark_proof_gate_lite"
)

BINARY_NAMES=(
  "dark_semaphore"
  "dark_secp256r1_vault"
  "dark_secp256k1_auth"
  "null_token_hook"
  "dark_null_lottery"
  "dark_null_mint_gate"
  "receipt_anchor"
  "dark_proof_gate_lite"
)

MANIFESTS=(
  "programs/dark_semaphore/Cargo.toml"
  "programs/dark_secp256r1_vault/Cargo.toml"
  "programs/dark_secp256k1_auth/Cargo.toml"
  "programs/null_token_hook/Cargo.toml"
  "programs/null_lottery/Cargo.toml"
  "programs/null_mint_gate/Cargo.toml"
  "programs/receipt_anchor/Cargo.toml"
  "programs/dark_proof_gate_lite/Cargo.toml"
)

echo "=== NULL Miner devnet rehearsal — 8 programs ==="
WALLET_ADDR=$(solana address --url "$CLUSTER_URL" 2>/dev/null || echo "unknown")
WALLET_BAL=$(solana balance --url "$CLUSTER_URL" 2>/dev/null || echo "unknown")
echo "Cluster: $CLUSTER_URL"
echo "Wallet:  $WALLET_ADDR"
echo "Balance: $WALLET_BAL"
echo ""

mkdir -p "$KEYPAIRS_DIR"

# ── Build phase ─────────────────────────────────────────────────────────────────
echo "--- Build phase (cargo build-sbf) ---"
BUILD_FAILURES=0
for i in "${!PROGRAMS[@]}"; do
  PROG="${PROGRAMS[$i]}"
  MANIFEST="${MANIFESTS[$i]}"
  echo "[build] $PROG from $MANIFEST"
  if ! cargo build-sbf --manifest-path "$MANIFEST"; then
    echo "[ERROR] build FAILED for $PROG" >&2
    BUILD_FAILURES=$((BUILD_FAILURES + 1))
  fi
done

if [ "$BUILD_FAILURES" -gt 0 ]; then
  echo "[ERROR] $BUILD_FAILURES build(s) failed. Fix before deploying." >&2
  exit 1
fi
echo "--- All binaries built ---"
echo ""

# ── Binary size check ────────────────────────────────────────────────────────────
echo "--- Binary sizes ---"
for BIN in "${BINARY_NAMES[@]}"; do
  SO="$BUILD_DIR/${BIN}.so"
  if [ -f "$SO" ]; then
    SIZE=$(wc -c < "$SO")
    echo "  ${BIN}.so  →  ${SIZE} bytes"
  else
    echo "  ${BIN}.so  → MISSING" >&2
    exit 1
  fi
done
echo ""

# ── Deploy phase ─────────────────────────────────────────────────────────────────
echo "--- Deploy phase ---"
PROGRAM_IDS=()
DEPLOY_FAILURES=0

for i in "${!PROGRAMS[@]}"; do
  PROG="${PROGRAMS[$i]}"
  BIN="${BINARY_NAMES[$i]}"
  KP="$KEYPAIRS_DIR/${PROG}.json"
  SO="$BUILD_DIR/${BIN}.so"

  if [ ! -f "$KP" ]; then
    echo "[keygen] $PROG — generating fresh keypair"
    solana-keygen new --no-passphrase --silent -o "$KP"
  fi

  PUBKEY=$(solana-keygen pubkey "$KP")
  echo "[deploy] $PROG → $PUBKEY"

  if ! solana program deploy --url "$CLUSTER_URL" --program-id "$KP" "$SO"; then
    echo "[ERROR] deploy FAILED for $PROG ($PUBKEY)" >&2
    DEPLOY_FAILURES=$((DEPLOY_FAILURES + 1))
    PROGRAM_IDS+=("DEPLOY_FAILED")
    continue
  fi

  # Verify the program is visible on chain
  if solana program show "$PUBKEY" --url "$CLUSTER_URL" >/dev/null 2>&1; then
    echo "[ok]     $PROG verified on devnet"
  else
    echo "[WARN]   $PROG deployed but show failed — check $PUBKEY manually"
  fi

  PROGRAM_IDS+=("$PUBKEY")
done

if [ "$DEPLOY_FAILURES" -gt 0 ]; then
  echo ""
  echo "[ERROR] $DEPLOY_FAILURES deploy(s) failed. IDs already written will be marked DEPLOY_FAILED." >&2
fi
echo ""

# ── Config update ────────────────────────────────────────────────────────────────
echo "--- Writing program IDs to $CONFIG ---"
for i in "${!PROGRAMS[@]}"; do
  PROG="${PROGRAMS[$i]}"
  ID="${PROGRAM_IDS[$i]:-DEPLOY_FAILED}"
  node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('$CONFIG', 'utf8'));
    const keyMap = {
      dark_semaphore:       'semaphore',
      dark_secp256r1_vault: 'vault',
      dark_secp256k1_auth:  'ethAuth',
      null_token_hook:      'tokenHook',
      null_lottery:         'lottery',
      null_mint_gate:       'mintGate',
      receipt_anchor:       'receiptAnchor',
      dark_proof_gate_lite: 'proofGate',
    };
    cfg.programs[keyMap['$PROG']] = '$ID';
    fs.writeFileSync('$CONFIG', JSON.stringify(cfg, null, 2) + '\n');
  "
  echo "  $PROG → $ID"
done
echo ""

# ── Env hints ───────────────────────────────────────────────────────────────────
echo "=== Rehearsal complete. Set these env vars before running the SDK: ==="
for i in "${!PROGRAMS[@]}"; do
  PROG="${PROGRAMS[$i]}"
  ID="${PROGRAM_IDS[$i]:-DEPLOY_FAILED}"
  case "$PROG" in
    receipt_anchor)       echo "  RECEIPT_ANCHOR_PROGRAM_ID=$ID" ;;
    dark_proof_gate_lite) echo "  PROOF_GATE_PROGRAM_ID=$ID" ;;
  esac
done
echo ""
echo "Remaining balance: $(solana balance --url "$CLUSTER_URL" 2>/dev/null || echo 'check manually')"
echo "Upgrade authority: $WALLET_ADDR — move to Squads multisig post-audit."

if [ "$DEPLOY_FAILURES" -gt 0 ]; then
  exit 1
fi
