#!/usr/bin/env bash
set -euo pipefail

# NULL Miner - commercial mainnet pilot deploy with external audit pending.
#
# This deploys program accounts and writes their IDs into
# configs/mainnet.commercial.json. It does not enable externally audited
# production settlement. By default IS_MAINNET_READY remains false.
#
# To flip IS_MAINNET_READY=true post-audit, rebuild with --features mainnet after
# an external audit approves each program. No env flag needed — just build normally.

CLUSTER_URL="https://api.mainnet-beta.solana.com"
KEYPAIRS_DIR="scripts/keypairs/mainnet-commercial"
BUILD_DIR="target/deploy"
CONFIG="configs/mainnet.commercial.json"

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

echo "NULL Miner commercial mainnet pilot deploy"
echo "Cluster: $CLUSTER_URL"
echo "Wallet:  $(solana address --url "$CLUSTER_URL")"
echo "Balance: $(solana balance --url "$CLUSTER_URL")"
echo ""
echo "This spends real SOL."
echo "Status: external audit pending."
echo "Review: internal technical review, automated analysis tools, regression tests."
echo "Pre-audit pilot builds keep IS_MAINNET_READY=false."
echo "Type 'deploy-mainnet-pilot' to continue."
read -r CONFIRM
if [ "$CONFIRM" != "deploy-mainnet-pilot" ]; then
  echo "Aborted."
  exit 0
fi

# Check for orphaned buffers from any previous failed deploy — recover SOL before spending more.
BUFFERS=$(solana program show --buffers --url "$CLUSTER_URL" 2>/dev/null | grep -c "Buffer Address" || true)
if [ "$BUFFERS" -gt 0 ]; then
  echo ""
  echo "WARNING: $BUFFERS orphaned buffer account(s) found."
  echo "Run this FIRST to recover SOL, then re-run this script:"
  echo "  solana program close --buffers --url $CLUSTER_URL"
  echo ""
  echo "DO NOT run: solana program close <PROGRAM_ID> --bypass-warning"
  echo "  That destroys deployed programs, not buffers."
  exit 1
fi

FEATURE_ARGS=()
echo "Building pilot binaries WITHOUT --features mainnet — IS_MAINNET_READY=false on all programs. Post-audit: rebuild per-program with --features mainnet."

mkdir -p "$KEYPAIRS_DIR"

for i in "${!PROGRAMS[@]}"; do
  PROG="${PROGRAMS[$i]}"
  MANIFEST="${MANIFESTS[$i]}"
  echo "Building $PROG..."
  cargo build-sbf --manifest-path "$MANIFEST" "${FEATURE_ARGS[@]}"
done

PROGRAM_IDS=()
for i in "${!PROGRAMS[@]}"; do
  PROG="${PROGRAMS[$i]}"
  BIN="${BINARY_NAMES[$i]}"
  KP="$KEYPAIRS_DIR/${PROG}.json"
  SO="$BUILD_DIR/${BIN}.so"

  if [ ! -f "$KP" ]; then
    solana-keygen new --no-passphrase --silent -o "$KP"
    echo "Generated keypair: $KP"
    echo "  IMPORTANT: back up $KP outside git before proceeding."
    echo "  Program ID will be: $(solana-keygen pubkey "$KP")"
  fi
  if [ ! -f "$SO" ]; then
    echo "Missing binary: $SO"
    exit 1
  fi

  PUBKEY=$(solana-keygen pubkey "$KP")

  # Skip-if-already-live: avoids redundant re-deploy and buffer churn on retry.
  if solana program show "$PUBKEY" --url "$CLUSTER_URL" >/dev/null 2>&1; then
    echo "SKIP: $PROG already live at $PUBKEY"
    PROGRAM_IDS+=("$PUBKEY")
    continue
  fi

  echo "Deploying $PROG to $PUBKEY..."
  solana program deploy --url "$CLUSTER_URL" --program-id "$KP" "$SO"
  solana program show "$PUBKEY" --url "$CLUSTER_URL" >/dev/null
  echo "OK: $PROG live at $PUBKEY"
  PROGRAM_IDS+=("$PUBKEY")
done

echo "Writing program IDs to $CONFIG..."
for i in "${!PROGRAMS[@]}"; do
  PROG="${PROGRAMS[$i]}"
  ID="${PROGRAM_IDS[$i]}"
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
done

echo ""
echo "Deploy complete. Verify every program:"
for id in "${PROGRAM_IDS[@]}"; do
  echo "  solana program show $id -u mainnet-beta"
done
echo ""
echo "Move upgrade authority to multisig before expanded public use."
