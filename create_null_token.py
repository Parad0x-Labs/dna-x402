#!/usr/bin/env python3
"""
PDX $NULL Token Creation Script
Creates 1,000,000,000 $NULL tokens on Solana Devnet
"""

import json
import sys
from pathlib import Path
from solders.pubkey import Pubkey
from solders.system_program import ID as SYS_ID
from solana.rpc.api import Client
from solana.rpc.commitment import Confirmed
from spl.token.constants import TOKEN_PROGRAM_ID
from spl.token.instructions import create_mint, initialize_mint, mint_to

def create_null_token(keypair_path: str, rpc_url: str = "https://api.devnet.solana.com"):
    """Create $NULL token with 1B supply"""

    print("🚀 Creating $NULL Token on Devnet...")

    # Load keypair
    with open(keypair_path, 'r') as f:
        keypair_data = json.load(f)

    from solders.keypair import Keypair
    keypair = Keypair.from_bytes(bytes(keypair_data))

    # Connect to devnet
    client = Client(rpc_url)

    # Check balance
    balance = client.get_balance(keypair.pubkey(), Confirmed).value
    print(f"[*] Wallet Balance: {balance / 1e9} SOL")

    if balance < 1_000_000:  # Less than 0.001 SOL
        print("❌ Insufficient balance. Get devnet SOL from https://faucet.solana.com/")
        return None

    # Create mint account
    print("[*] Creating mint account...")
    mint_keypair = Keypair()  # New keypair for mint

    # Calculate rent
    mint_rent = client.get_minimum_balance_for_rent_exemption(82, Confirmed).value  # Mint account size

    # Create mint account instruction
    from solders.transaction import Transaction
    from solders.instruction import Instruction, AccountMeta

    recent_blockhash = client.get_recent_blockhash(Confirmed).value.blockhash

    tx = Transaction()
    tx.recent_blockhash = recent_blockhash

    # Create account for mint
    from solders.system_program import create_account
    create_ix = create_account(
        from_pubkey=keypair.pubkey(),
        to_pubkey=mint_keypair.pubkey(),
        lamports=mint_rent,
        space=82,
        owner=TOKEN_PROGRAM_ID
    )
    tx.add(create_ix)

    # Initialize mint
    init_mint_ix = initialize_mint(
        mint=mint_keypair.pubkey(),
        mint_authority=keypair.pubkey(),
        freeze_authority=keypair.pubkey(),
        decimals=9  # 9 decimals for $NULL (1 token = 1e9 units)
    )
    tx.add(init_mint_ix)

    # Sign and send
    tx.sign([keypair, mint_keypair])
    result = client.send_transaction(tx, opts={"skip_preflight": False})
    print(f"[*] Mint account created: {result.value}")

    # Wait for confirmation
    client.confirm_transaction(result.value, Confirmed)
    print("[✅] Mint initialized successfully!")

    # Create associated token account for the deployer
    print("[*] Creating associated token account...")
    from spl.token.instructions import get_associated_token_address, create_associated_token_account

    ata = get_associated_token_address(keypair.pubkey(), mint_keypair.pubkey())

    # Check if ATA exists
    try:
        client.get_account_info(ata, Confirmed)
        print("[*] ATA already exists")
    except:
        # Create ATA
        tx2 = Transaction()
        tx2.recent_blockhash = client.get_recent_blockhash(Confirmed).value.blockhash

        create_ata_ix = create_associated_token_account(
            payer=keypair.pubkey(),
            owner=keypair.pubkey(),
            mint=mint_keypair.pubkey()
        )
        tx2.add(create_ata_ix)

        tx2.sign([keypair])
        result2 = client.send_transaction(tx2, opts={"skip_preflight": False})
        client.confirm_transaction(result2.value, Confirmed)
        print(f"[✅] ATA created: {ata}")

    # Mint 1B tokens
    print("[*] Minting 1,000,000,000 $NULL tokens...")
    mint_amount = 1_000_000_000 * (10 ** 9)  # 1B tokens with 9 decimals

    tx3 = Transaction()
    tx3.recent_blockhash = client.get_recent_blockhash(Confirmed).value.blockhash

    mint_to_ix = mint_to(
        mint=mint_keypair.pubkey(),
        dest=ata,
        mint_authority=keypair.pubkey(),
        amount=mint_amount,
        signer=keypair.pubkey()
    )
    tx3.add(mint_to_ix)

    tx3.sign([keypair])
    result3 = client.send_transaction(tx3, opts={"skip_preflight": False})
    client.confirm_transaction(result3.value, Confirmed)

    print("[✅] $NULL Token Created Successfully!")
    print(f"   Mint Address: {mint_keypair.pubkey()}")
    print(f"   Total Supply: 1,000,000,000 $NULL")
    print(f"   Decimals: 9")
    print(f"   Your Balance: {mint_amount} units")

    # Save mint address
    with open('null_mint.json', 'w') as f:
        json.dump({
            'mint': str(mint_keypair.pubkey()),
            'ata': str(ata),
            'supply': mint_amount,
            'decimals': 9
        }, f, indent=2)

    print("[💾] Mint info saved to null_mint.json")

    return str(mint_keypair.pubkey())

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python create_null_token.py <keypair.json>")
        print("Make sure you have devnet SOL in your wallet!")
        sys.exit(1)

    mint_address = create_null_token(sys.argv[1])
    if mint_address:
        print(f"\n🎉 $NULL Token ready for PDX Dark Protocol!")
        print(f"Update your client with: {mint_address}")
