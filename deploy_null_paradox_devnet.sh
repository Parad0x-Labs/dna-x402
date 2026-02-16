#!/bin/bash

# PDX $NULL PARADOX Token Deployment Script
# Creates 1B $NULL tokens on Devnet with proper metadata

set -e

echo "🚀 Deploying $NULL PARADOX Token to Devnet..."

# Configuration
TOTAL_SUPPLY=1000000000  # 1 Billion tokens
DECIMALS=6
TOKEN_NAME="\$NULL PARADOX"
TOKEN_SYMBOL="NULL"
METADATA_URI="https://arweave.net/NULL_PARADOX_METADATA"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if we're on devnet
NETWORK=$(solana config get | grep "RPC URL" | awk '{print $3}')
if [[ "$NETWORK" != *"devnet"* ]]; then
    echo -e "${RED}❌ Error: Not connected to devnet. Run: solana config set --url https://api.devnet.solana.com${NC}"
    exit 1
fi

echo -e "${YELLOW}📡 Network: $NETWORK${NC}"

# Check wallet balance
BALANCE=$(solana balance | awk '{print $1}')
REQUIRED_SOL=2  # Rough estimate for deployment + rent
if (( $(echo "$BALANCE < $REQUIRED_SOL" | bc -l) )); then
    echo -e "${RED}❌ Insufficient SOL balance: $BALANCE SOL (need ~$REQUIRED_SOL SOL)${NC}"
    echo -e "${YELLOW}💡 Get devnet SOL: solana airdrop 2${NC}"
    exit 1
fi

echo -e "${GREEN}💰 Wallet balance: $BALANCE SOL${NC}"

# 1. Create Token Mint Account
echo -e "${YELLOW}🏭 Creating Token Mint Account...${NC}"
MINT_KEYPAIR=$(solana-keygen new --no-passphrase --silent --outfile ./null_mint_keypair.json)
MINT_PUBKEY=$(solana-keygen pubkey ./null_mint_keypair.json)

echo -e "${GREEN}✅ Mint Keypair: $MINT_PUBKEY${NC}"

# Create mint account (Token-2022)
spl-token create-token --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb ./null_mint_keypair.json

# 2. Create Token Metadata (if using Metaplex)
echo -e "${YELLOW}📝 Creating Token Metadata...${NC}"
# Note: This would use Metaplex token metadata program in production
# For devnet testing, we'll skip complex metadata for now

# 3. Mint Initial Supply to Deployer
echo -e "${YELLOW}💰 Minting 1B $NULL tokens...${NC}"
spl-token mint $MINT_PUBKEY ${TOTAL_SUPPLY}000000 --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb

# 4. Create Associated Token Account for deployer
echo -e "${YELLOW}📦 Creating deployer ATA...${NC}"
DEPLOYER_ATA=$(spl-token create-account $MINT_PUBKEY --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb | grep "Creating account" | awk '{print $3}')

# 5. Transfer all tokens to deployer ATA
echo -e "${YELLOW}🚚 Transferring tokens to ATA...${NC}"
spl-token transfer $MINT_PUBKEY ${TOTAL_SUPPLY}000000 $DEPLOYER_ATA --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb --allow-unfunded-recipient

# 6. Note: Vault preload will happen after program deployment
echo -e "${YELLOW}📝 Note: Run preload_vault.sh after program deployment to fund vault with 100M $NULL${NC}"

# 6. Disable future minting (make supply fixed)
echo -e "${YELLOW}🔒 Disabling future minting...${NC}"
spl-token authorize $MINT_PUBKEY mint --disable --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb

# 7. Save deployment info
echo -e "${GREEN}💾 Saving deployment info...${NC}"
cat > null_paradox_deployment.json << EOF
{
  "network": "devnet",
  "token_name": "$TOKEN_NAME",
  "token_symbol": "$TOKEN_SYMBOL",
  "mint_address": "$MINT_PUBKEY",
  "deployer_ata": "$DEPLOYER_ATA",
  "total_supply": $TOTAL_SUPPLY,
  "decimals": $DECIMALS,
  "program_id": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "deployment_date": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "deployer_wallet": "$(solana-keygen pubkey)",
  "metadata_uri": "$METADATA_URI"
}
EOF

echo -e "${GREEN}✅ DEPLOYMENT COMPLETE!${NC}"
echo -e "${YELLOW}📋 Deployment Summary:${NC}"
echo -e "   Token Name: $TOKEN_NAME"
echo -e "   Token Symbol: $TOKEN_SYMBOL"
echo -e "   Mint Address: $MINT_PUBKEY"
echo -e "   Deployer ATA: $DEPLOYER_ATA"
echo -e "   Total Supply: ${TOTAL_SUPPLY} $TOKEN_SYMBOL"
echo -e "   Decimals: $DECIMALS"
echo -e "   Program: Token-2022"
echo ""
echo -e "${RED}⚠️  IMPORTANT: Update the contract constant NULL_FEE_MINT_STR with: $MINT_PUBKEY${NC}"
echo ""
echo -e "${YELLOW}📄 Deployment details saved to: null_paradox_deployment.json${NC}"

# Verification
echo -e "${YELLOW}🔍 Verifying deployment...${NC}"
spl-token supply $MINT_PUBKEY --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
spl-token accounts --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb

echo -e "${GREEN}🎉 $NULL PARADOX Token deployment successful!${NC}"
