#!/bin/bash

# PDX Vault Preload Script
# Funds the protocol vault with 100M $NULL tokens for devnet testing

set -e

echo "🏦 Preloading PDX Vault with 100M $NULL tokens..."

# Configuration
VAULT_PRELOAD=100000000  # 100M tokens
PROGRAM_ID="$1"  # Pass program ID as argument
NULL_MINT="$2"   # Pass NULL mint as argument

if [ -z "$PROGRAM_ID" ] || [ -z "$NULL_MINT" ]; then
    echo "Usage: $0 <program_id> <null_mint>"
    echo "Example: $0 abc123... xyz789..."
    exit 1
fi

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Derive vault authority PDA
echo -e "${YELLOW}🔑 Deriving vault authority PDA...${NC}"
VAULT_AUTHORITY=$(python3 -c "
import sys
sys.path.append('.')
from solders.pubkey import Pubkey
from solders.system_program import ID as SYS_ID

program_id = Pubkey.from_string('$PROGRAM_ID')
vault_auth, _ = Pubkey.find_program_address([b'pdx_null_vault'], program_id)
print(vault_auth)
")

# Derive vault ATA
echo -e "${YELLOW}📦 Deriving vault ATA...${NC}"
VAULT_ATA=$(python3 -c "
import sys
sys.path.append('.')
from solders.pubkey import Pubkey
from spl.token_2022.utils import get_associated_token_address

vault_auth = Pubkey.from_string('$VAULT_AUTHORITY')
null_mint = Pubkey.from_string('$NULL_MINT')
ata = get_associated_token_address(vault_auth, null_mint, token_program_id=Pubkey.from_string('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'))
print(ata)
")

echo -e "${GREEN}✅ Vault Authority: $VAULT_AUTHORITY${NC}"
echo -e "${GREEN}✅ Vault ATA: $VAULT_ATA${NC}"

# Transfer 100M tokens to vault
echo -e "${YELLOW}🚚 Transferring 100M $NULL to vault...${NC}"
spl-token transfer $NULL_MINT ${VAULT_PRELOAD}000000 $VAULT_ATA \
    --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
    --allow-unfunded-recipient \
    --fee-payer ~/.config/solana/id.json

# Verify balance
echo -e "${YELLOW}🔍 Verifying vault balance...${NC}"
VAULT_BALANCE=$(spl-token balance $VAULT_ATA --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb)
echo -e "${GREEN}✅ Vault balance: $VAULT_BALANCE $NULL tokens${NC}"

echo -e "${GREEN}🎉 Vault preloaded successfully!${NC}"
echo -e "${YELLOW}💡 Testers can now use PDX transfers without depositing $NULL${NC}"
