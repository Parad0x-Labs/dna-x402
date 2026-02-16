#!/usr/bin/env python3
"""
Quick PDX Dark Protocol Test Transfer
Demonstrates anonymous transfer with $NULL fee burn
"""

import json
import sys
from solders.pubkey import Pubkey
from solders.system_program import ID as SYS_ID
# Constants for Token 2022
TOKEN_2022_PROGRAM_ID = Pubkey.from_string("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")

def get_associated_token_address(owner, mint, token_program_id=None):
    """Derive associated token address"""
    if token_program_id is None:
        token_program_id = TOKEN_2022_PROGRAM_ID
    # ATA derivation seeds: [owner, token_program, mint]
    ata_program = Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
    seeds = [
        bytes(owner),
        bytes(token_program_id),
        bytes(mint)
    ]
    return Pubkey.find_program_address(seeds, ata_program)[0]
from client.dark_client import DarkClient

# Program addresses
PROGRAM_ID = Pubkey.from_string("3hYWUSYmNCzrHNgsE6xo3jKT9GjCFxCpPWXj4Q4imToz")
NULL_MINT = Pubkey.from_string("ADVjd6sSVsjc165FnisTrb4HvtoLNy4RHAp2rbG1oGNa")
NULL_FEE_MINT = Pubkey.from_string("8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump")

def create_test_notes():
    """Create mock asset and fee notes for testing"""
    # Mock asset note (represents 0.1 SOL)
    asset_note = {
        'secret': '0x123456789abcdef',
        'amount': 10000000,  # 0.01 SOL in lamports
        'asset_hash': '0xabcdef123456789',
        'root': '0x1111111111111111111111111111111111111111111111111111111111111111',
        'path_elements': ['0x2222222222222222222222222222222222222222222222222222222222222222'] * 10,
        'path_indices': [0] * 10
    }

    # Mock fee note (represents $NULL fee)
    fee_note = {
        'secret': '0xfedcba987654321',
        'path_elements': ['0x3333333333333333333333333333333333333333333333333333333333333333'] * 10,
        'path_indices': [1] * 10
    }

    return asset_note, fee_note

def main():
    print("🚀 PDX Dark Protocol Test Transfer")
    print("=" * 50)

    # Create test notes
    asset_note, fee_note = create_test_notes()
    print("✅ Created mock ZK notes")

    # Initialize client with test wallet
    client = DarkClient("extension/test_wallet.json")
    print(f"✅ Connected wallet: {client.keypair.pubkey()}")

    # Test recipient (the deployer wallet)
    recipient = Pubkey.from_string("7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ")
    memo = "PDX Dark Protocol Test Transfer - Anonymous SOL"

    print(f"📤 Transferring to: {recipient}")
    print("🔥 Burning 1 $NULL token fee")

    # Execute transfer
    success = client.transfer(asset_note, fee_note, recipient, memo)

    if success:
        print("🎉 SUCCESS: PDX Dark Transfer completed!")
        print("🔒 Transaction is anonymous - no on-chain link to sender")
        print("🔥 $NULL fee burned to fund privacy operations")
    else:
        print("❌ Transfer failed")
        sys.exit(1)

if __name__ == "__main__":
    main()
