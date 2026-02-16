#!/bin/bash

# PDX DARK PROTOCOL - STATUS FILE DEPLOYMENT
# Deploy critical alerts and warnings to IPFS/Arweave

echo "📡 PDX Dark Protocol - Status File Deployment"
echo "============================================="
echo ""

# Check if IPFS is installed
if ! command -v ipfs &> /dev/null; then
    echo "❌ IPFS CLI not installed. Install from: https://docs.ipfs.tech/install/"
    echo "   Or use a pinning service like Pinata, Infura, or Fleek."
    exit 1
fi

# Check if status file exists
if [ ! -f "status.json" ]; then
    echo "❌ status.json not found. Copy status_template.json to status.json and edit."
    exit 1
fi

echo "📄 Current status file:"
cat status.json | jq . 2>/dev/null || cat status.json
echo ""

read -p "Deploy this status file to IPFS? (y/N): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Deployment cancelled."
    exit 0
fi

echo "🚀 Deploying to IPFS..."

# Add to IPFS
IPFS_HASH=$(ipfs add -Q status.json)

if [ $? -ne 0 ]; then
    echo "❌ Failed to add file to IPFS"
    exit 1
fi

echo "✅ File added to IPFS: $IPFS_HASH"
echo ""

# Pin the file (ensure it stays available)
echo "📌 Pinning file..."
ipfs pin add "$IPFS_HASH"

if [ $? -ne 0 ]; then
    echo "⚠️  Local pinning failed, but file is added"
fi

echo ""
echo "🌐 Access URLs:"
echo "   IPFS: https://gateway.pinata.cloud/ipfs/$IPFS_HASH"
echo "   IPFS: https://ipfs.io/ipfs/$IPFS_HASH"
echo "   IPFS: https://cloudflare-ipfs.com/ipfs/$IPFS_HASH"
echo ""

echo "⚙️  UPDATE YOUR FRONTEND:"
echo "   Edit src/utils/statusChecker.ts"
echo "   Change STATUS_FILE_CID to: '$IPFS_HASH'"
echo ""

echo "📋 REMEMBER:"
echo "   • Update this file whenever you need to warn users"
echo "   • Pin on multiple IPFS nodes for redundancy"
echo "   • Consider Arweave for permanent storage"
echo ""

echo "✅ Status file deployed successfully!"
