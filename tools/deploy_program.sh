#!/usr/bin/env bash
set -euo pipefail

CLUSTER="${1:-devnet}"
PROGRAM_SO="${2:-target/deploy/pdx_dark_protocol.so}"
PROGRAM_KEYPAIR="${3:-target/deploy/pdx_dark_protocol-keypair.json}"

if [[ "$CLUSTER" != "devnet" && "$CLUSTER" != "mainnet" ]]; then
  echo "Usage: $0 [devnet|mainnet] [program-so] [program-keypair]"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$SCRIPT_DIR/switch_cluster.sh" "$CLUSTER"

if [[ ! -f "$PROGRAM_SO" ]]; then
  echo "Program .so not found: $PROGRAM_SO"
  echo "Building program..."
  cargo build-sbf
fi

if [[ ! -f "$PROGRAM_KEYPAIR" ]]; then
  echo "Program keypair not found: $PROGRAM_KEYPAIR"
  exit 1
fi

echo "Current deployer pubkey: $(solana address)"
echo "Current balance: $(solana balance)"
echo "Deploying $PROGRAM_SO to $CLUSTER..."

solana program deploy \
  "$PROGRAM_SO" \
  --program-id "$PROGRAM_KEYPAIR"

