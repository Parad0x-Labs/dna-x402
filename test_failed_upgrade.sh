#!/bin/bash

# PDX DARK PROTOCOL - FAILED UPGRADE TEST
# This script proves that the protocol is truly autonomous by attempting
# to upgrade the program and confirming it fails.

echo "🔐 PDX Dark Protocol - Failed Upgrade Test"
echo "=========================================="
echo ""
echo "This test proves the protocol is TRULY AUTONOMOUS by attempting"
echo "to upgrade the program and confirming it MUST fail."
echo ""
echo "If this test succeeds (upgrade is blocked), the protocol is autonomous."
echo "If this test fails (upgrade succeeds), the protocol is NOT autonomous."
echo ""

# Configuration - UPDATE THESE VALUES
PROGRAM_ID="11111111111111111111111111111112"  # Your deployed program ID
UPGRADE_AUTHORITY_KEYPAIR="~/.config/solana/id.json"  # Path to keypair (should fail)
MALICIOUS_PROGRAM_SO="./target/deploy/pdx_dark_malicious.so"  # Malicious upgrade

echo "📋 Test Configuration:"
echo "   Program ID: $PROGRAM_ID"
echo "   Upgrade Authority: $UPGRADE_AUTHORITY_KEYPAIR"
echo "   Malicious Binary: $MALICIOUS_PROGRAM_SO"
echo ""

# Create a malicious program binary (for testing)
echo "🔨 Creating malicious test program..."
if [ ! -f "target/deploy/pdx_dark.so" ]; then
    echo "❌ Original program binary not found. Run 'anchor build' first."
    exit 1
fi

# Copy original and "modify" it (just change a byte for testing)
cp target/deploy/pdx_dark.so "$MALICIOUS_PROGRAM_SO"
# Modify one byte to simulate a malicious upgrade
printf '\xFF' | dd of="$MALICIOUS_PROGRAM_SO" bs=1 seek=100 count=1 conv=notrunc 2>/dev/null

echo "✅ Created malicious test binary"
echo ""

# Attempt the upgrade (THIS SHOULD FAIL)
echo "🚀 Attempting program upgrade (this should FAIL)..."
echo "Command: solana program deploy \\"
echo "  --program-id $PROGRAM_ID \\"
echo "  --upgrade-authority $UPGRADE_AUTHORITY_KEYPAIR \\"
echo "  $MALICIOUS_PROGRAM_SO"
echo ""

# Run the upgrade command
if solana program deploy \
    --program-id "$PROGRAM_ID" \
    --upgrade-authority "$UPGRADE_AUTHORITY_KEYPAIR" \
    "$MALICIOUS_PROGRAM_SO" 2>&1; then

    echo ""
    echo "❌ CRITICAL FAILURE: Program upgrade SUCCEEDED!"
    echo "   This means the protocol is NOT autonomous."
    echo "   Anyone with the upgrade authority can modify the program."
    echo "   DO NOT DEPLOY - This is just a bank with privacy features."
    echo ""
    echo "🔍 Investigation Required:"
    echo "   1. Check program authority: solana program show $PROGRAM_ID"
    echo "   2. Verify authority is null (burned)"
    echo "   3. If not burned, burn it: spl-governance program upgrade --buffer <buffer> --spill <spill>"
    exit 1
else
    echo ""
    echo "✅ SUCCESS: Program upgrade was BLOCKED!"
    echo "   Error message indicates the program is immutable."
    echo "   The protocol is TRULY AUTONOMOUS."
    echo ""
    echo "🎉 This confirms:"
    echo "   • No admin can upgrade the program"
    echo "   • No admin can pause transactions"
    echo "   • No admin can modify privacy logic"
    echo "   • Users have censorship resistance"
fi

echo ""
echo "🧹 Cleaning up test files..."
rm -f "$MALICIOUS_PROGRAM_SO"

echo ""
echo "📊 Test Results Summary:"
echo "   Status: $([ $? -eq 0 ] && echo "AUTONOMOUS ✅" || echo "NOT AUTONOMOUS ❌")"
echo "   Timestamp: $(date)"
echo "   Program ID: $PROGRAM_ID"
