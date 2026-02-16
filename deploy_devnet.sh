#!/bin/bash

# PDX Dark Protocol - Devnet Deployment Script
# This script handles the complete deployment process

set -e

echo "🚀 PDX Dark Protocol - Devnet Deployment"
echo "======================================="

# Check prerequisites
command -v cargo >/dev/null 2>&1 || { echo "❌ Cargo not found. Install Rust."; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "❌ Python3 not found."; exit 1; }
command -v node >/dev/null 2>&1 || { echo "❌ Node.js not found."; exit 1; }
command -v circom >/dev/null 2>&1 || { echo "❌ Circom not found. Run: npm install -g circom"; exit 1; }
command -v snarkjs >/dev/null 2>&1 || { echo "❌ SnarkJS not found. Run: npm install -g snarkjs"; exit 1; }

KEYPAIR_PATH="${1:-$HOME/.config/solana/id.json}"
if [ ! -f "$KEYPAIR_PATH" ]; then
    echo "❌ Keypair not found at $KEYPAIR_PATH"
    echo "Create one with: solana-keygen new"
    exit 1
fi

echo "[1/6] Creating $NULL token..."
python3 create_null_token.py "$KEYPAIR_PATH"

echo "[2/6] Setting up ZK circuit..."
cd circuits
chmod +x setup_pdx.sh
./setup_pdx.sh
cd ..

echo "[3/6] Converting verification key..."
cd tools
node vk_to_rust.mjs
cd ..

echo "[4/6] Building Solana program..."
cargo build-sbf

echo "[5/6] Deploying to devnet..."
# Generate program keypair if it doesn't exist
if [ ! -f "pdp-keypair.json" ]; then
    solana-keygen new --no-passphrase -o pdp-keypair.json --force
fi

PROGRAM_ID=$(solana-keygen pubkey pdp-keypair.json)
echo "Program ID: $PROGRAM_ID"

# Deploy
solana program deploy --program-id pdp-keypair.json target/deploy/pdx_dark_protocol.so --url devnet

echo "[6/6] Updating client configuration..."
# Update program ID in client
sed -i.bak "s/11111111111111111111111111111112/$PROGRAM_ID/" client/dark_client.py

echo "[✅] Deployment Complete!"
echo ""
echo "🎉 Your PDX Dark Protocol is live on Devnet!"
echo ""
echo "📋 Next Steps:"
echo "1. Fund your wallet with devnet SOL if needed"
echo "2. Run tests: cd client && python -m pytest test_dark_protocol.py -v"
echo "3. Test a transfer (you'll need to create proper Merkle tree notes)"
echo ""
echo "🔗 Program ID: $PROGRAM_ID"
echo "💰 $NULL Token: $(cat null_mint.json | grep '"mint"' | cut -d'"' -f4)"
echo ""
echo "Happy privacy engineering! 🛡️"
