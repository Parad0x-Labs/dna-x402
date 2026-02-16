#!/bin/bash

# PDX Dark Protocol ZK Setup Script
# This generates the proving keys for the dark transfer circuit

set -e

echo "🚀 Setting up PDX Dark Protocol ZK Keys..."

# Check if circom is installed
if ! command -v circom &> /dev/null; then
    echo "❌ Circom not found. Install with: npm install -g circom"
    exit 1
fi

# Check if snarkjs is installed
if ! command -v snarkjs &> /dev/null; then
    echo "❌ SnarkJS not found. Install with: npm install -g snarkjs"
    exit 1
fi

echo "📝 Compiling circuit..."
circom dark_transfer.circom --r1cs --wasm --sym

echo "🎯 Setting up trusted setup..."
snarkjs groth16 setup dark_transfer.r1cs pot12_final.ptau dark.zkey

echo "🔐 Exporting verification key..."
snarkjs zkey export verificationkey dark.zkey verification_key.json

echo "✅ ZK Setup Complete!"
echo "📁 Files generated:"
echo "   - dark_transfer.r1cs"
echo "   - dark_transfer_js/"
echo "   - dark.zkey"
echo "   - verification_key.json"
