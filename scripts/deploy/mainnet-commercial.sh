#!/usr/bin/env bash
set -euo pipefail

# NULL Miner - unaudited commercial mainnet pilot deploy.
#
# This deploys program accounts and writes their IDs into
# configs/mainnet.commercial.json. It does not enable third-party audited
# production settlement. By default IS_MAINNET_READY remains false.
#
# To build audited enforcement paths after review, set:
#   AUDIT_VERIFIED=1 ./scripts/deploy/mainnet-commercial.sh

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

echo "NULL Miner unaudited commercial mainnet pilot deploy"
echo "Cluster: $CLUSTER_URL"
echo "Wallet:  $(solana address --url "$CLUSTER_URL")"
echo "Balance: $(solana balance --url "$CLUSTER_URL")"
echo ""
echo "This spends real SOL."
echo "Status: no completed third-party audit yet."
echo "Review: internal developer review, automated analysis tools, regression tests."
echo "Pre-audit pilot builds keep IS_MAINNET_READY=false."
echo "Type 'deploy-mainnet-pilot' to continue."
read -r CONFIRM
if [ "$CONFIRM" != "deploy-mainnet-pilot" ]; then
  echo "Aborted."
  exit 0
fi

FEATURE_ARGS=()
if [ "${AUDIT_VERIFIED:-0}" = "1" ]; then
  echo "AUDIT_VERIFIED=1 set: building with mainnet,audit-verified features."
  FEATURE_ARGS=(--features "mainnet,audit-verified")
else
  echo "Building pre-audit pilot binaries. Enforcement gate remains off."
fi

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
  fi
  if [ ! -f "$SO" ]; then
    echo "Missing binary: $SO"
    exit 1
  fi

  PUBKEY=$(solana-keygen pubkey "$KP")
  echo "Deploying $PROG to $PUBKEY..."
  solana program deploy --url "$CLUSTER_URL" --program-id "$KP" "$SO"
  solana program show "$PUBKEY" --url "$CLUSTER_URL" >/dev/null
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

echo ""
echo "Deploy complete. Verify every program:"
for id in "${PROGRAM_IDS[@]}"; do
  echo "  solana program show $id -u mainnet-beta"
done
echo ""
echo "Move upgrade authority to multisig before expanded public use."
