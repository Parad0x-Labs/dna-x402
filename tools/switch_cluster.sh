#!/usr/bin/env bash
set -euo pipefail

CLUSTER="${1:-devnet}"
KEYPAIR_ARG="${2:-}"

if [[ "$CLUSTER" != "devnet" && "$CLUSTER" != "mainnet" ]]; then
  echo "Usage: $0 [devnet|mainnet] [optional-keypair-path]"
  exit 1
fi

case "$CLUSTER" in
  devnet)
    RPC_URL="https://api.devnet.solana.com"
    DEFAULT_KEYPAIR="$HOME/.config/solana/devnet-deployer.json"
    ;;
  mainnet)
    RPC_URL="https://api.mainnet-beta.solana.com"
    DEFAULT_KEYPAIR="$HOME/.config/solana/mainnet-deployer.json"
    ;;
esac

KEYPAIR_PATH="${KEYPAIR_ARG:-$DEFAULT_KEYPAIR}"

if [[ ! -f "$KEYPAIR_PATH" ]]; then
  echo "Keypair not found: $KEYPAIR_PATH"
  exit 1
fi

solana config set \
  --url "$RPC_URL" \
  --keypair "$KEYPAIR_PATH" \
  --commitment confirmed >/dev/null

echo "Switched to $CLUSTER"
solana config get

