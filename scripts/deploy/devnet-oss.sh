#!/usr/bin/env bash
set -euo pipefail

# NULL Miner - OSS devnet deploy.
# Zero-fee profile. IS_MAINNET_READY remains false.

CLUSTER_URL="https://api.devnet.solana.com"
KEYPAIRS_DIR="scripts/keypairs/devnet-oss"
BUILD_DIR="target/deploy"
CONFIG="configs/devnet.oss.json"

PROGRAMS=(
  "dark_semaphore"
  "dark_secp256r1_vault"
  "dark_secp256k1_auth"
  "null_token_hook"
  "null_lottery"
  "null_mint_gate"
)

BINARY_NAMES=(
  "dark_semaphore"
  "dark_secp256r1_vault"
  "dark_secp256k1_auth"
  "null_token_hook"
  "dark_null_lottery"
  "dark_null_mint_gate"
)

MANIFESTS=(
  "programs/dark_semaphore/Cargo.toml"
  "programs/dark_secp256r1_vault/Cargo.toml"
  "programs/dark_secp256k1_auth/Cargo.toml"
  "programs/null_token_hook/Cargo.toml"
  "programs/null_lottery/Cargo.toml"
  "programs/null_mint_gate/Cargo.toml"
)

echo "NULL Miner OSS devnet deploy"
echo "Cluster: $CLUSTER_URL"
echo "Wallet:  $(solana address --url "$CLUSTER_URL")"
echo "Balance: $(solana balance --url "$CLUSTER_URL")"

mkdir -p "$KEYPAIRS_DIR"

for i in "${!PROGRAMS[@]}"; do
  PROG="${PROGRAMS[$i]}"
  MANIFEST="${MANIFESTS[$i]}"
  echo "Building $PROG..."
  cargo build-sbf --manifest-path "$MANIFEST"
done

PROGRAM_IDS=()
for i in "${!PROGRAMS[@]}"; do
  PROG="${PROGRAMS[$i]}"
  BIN="${BINARY_NAMES[$i]}"
  KP="$KEYPAIRS_DIR/${PROG}.json"
  SO="$BUILD_DIR/${BIN}.so"

  if [ ! -f "$KP" ]; then
    solana-keygen new --no-passphrase --silent -o "$KP"
  fi
  if [ ! -f "$SO" ]; then
    echo "Missing binary: $SO"
    exit 1
  fi

  PUBKEY=$(solana-keygen pubkey "$KP")
  echo "Deploying $PROG to $PUBKEY..."
  solana program deploy --url "$CLUSTER_URL" --program-id "$KP" "$SO"
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
      dark_semaphore: 'semaphore',
      dark_secp256r1_vault: 'vault',
      dark_secp256k1_auth: 'ethAuth',
      null_token_hook: 'tokenHook',
      null_lottery: 'lottery',
      null_mint_gate: 'mintGate',
    };
    cfg.programs[keyMap['$PROG']] = '$ID';
    fs.writeFileSync('$CONFIG', JSON.stringify(cfg, null, 2) + '\n');
  "
done

echo "Devnet deploy complete."
