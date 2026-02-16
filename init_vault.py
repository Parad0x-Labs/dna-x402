#!/usr/bin/env python3
"""
Initialize PDX Dark Protocol vaults
"""

import json
import sys
from solders.pubkey import Pubkey
from solders.transaction import Transaction
from solders.instruction import Instruction, AccountMeta
from solders.system_program import ID as SYS_ID
from solana.rpc.api import Client
from solana.rpc.commitment import Confirmed

# PDX Program
PROGRAM_ID = Pubkey.from_string("3hYWUSYmNCzrHNgsE6xo3jKT9GjCFxCpPWXj4Q4imToz")

def load_keypair(filename):
    with open(filename, 'r') as f:
        data = json.load(f)
    return bytes(data)

def init_sol_vault():
    """Initialize SOL vault PDA"""
    print(">>> Initializing SOL Vault...")

    rpc = Client("https://api.devnet.solana.com")

    # Load deployer keypair
    keypair_bytes = load_keypair("deployer_wallet.json")
    from solders.keypair import Keypair
    keypair = Keypair.from_bytes(keypair_bytes)

    # Instruction data: InitVault (discriminator 0)
    instruction_data = b'\x00'  # u8 discriminator for InitVault

    # No accounts needed for InitVault
    accounts = []

    ix = Instruction(
        PROGRAM_ID,
        instruction_data,
        accounts
    )

    # Get recent blockhash
    recent_blockhash = rpc.get_recent_blockhash(Confirmed).value.blockhash

    # Create transaction
    tx = Transaction()
    tx.recent_blockhash = recent_blockhash
    tx.add(ix)
    tx.sign(keypair)

    # Send transaction
    result = rpc.send_transaction(tx, opts={"skip_preflight": False})
    print(f"✅ SOL Vault Init TX: {result.value}")

    # Confirm
    rpc.confirm_transaction(result.value, Confirmed)
    print("✅ SOL Vault initialized!")

    return result.value

def init_null_vault():
    """Initialize $NULL vault (authority PDA + ATA)"""
    print("🔐 Initializing $NULL Vault...")

    rpc = Client("https://api.devnet.solana.com")

    # Load deployer keypair
    keypair_bytes = load_keypair("deployer_wallet.json")
    from solders.keypair import Keypair
    keypair = Keypair.from_bytes(keypair_bytes)

    # Derive vault authority PDA
    vault_auth, _ = Pubkey.find_program_address([b'pdx_null_vault'], PROGRAM_ID)

    # NULL mint
    null_mint = Pubkey.from_string("ADVjd6sSVsjc165FnisTrb4HvtoLNy4RHAp2rbG1oGNa")
    token_2022 = Pubkey.from_string("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")

    # Derive NULL vault ATA
    ata_program = Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
    seeds = [bytes(vault_auth), bytes(token_2022), bytes(null_mint)]
    null_vault_ata, _ = Pubkey.find_program_address(seeds, ata_program)

    # Instruction data: InitNullVault (discriminator 3)
    instruction_data = b'\x03'  # u8 discriminator for InitNullVault

    accounts = [
        AccountMeta(keypair.pubkey(), True, True),    # payer
        AccountMeta(vault_auth, False, True),          # vault_authority
        AccountMeta(null_vault_ata, False, True),      # null_vault_ata
        AccountMeta(null_mint, False, False),          # null_mint
        AccountMeta(token_2022, False, False),         # token_2022_program
        AccountMeta(ata_program, False, False),        # ata_program
        AccountMeta(SYS_ID, False, False),             # system_program
    ]

    ix = Instruction(
        PROGRAM_ID,
        instruction_data,
        accounts
    )

    # Get recent blockhash
    recent_blockhash = rpc.get_recent_blockhash(Confirmed).value.blockhash

    # Create transaction
    tx = Transaction()
    tx.recent_blockhash = recent_blockhash
    tx.add(ix)
    tx.sign(keypair)

    # Send transaction
    result = rpc.send_transaction(tx, opts={"skip_preflight": False})
    print(f"✅ $NULL Vault Init TX: {result.value}")

    # Confirm
    rpc.confirm_transaction(result.value, Confirmed)
    print("✅ $NULL Vault initialized!")

    return result.value

if __name__ == "__main__":
    print(">>> PDX Vault Initialization")
    print("=" * 40)

    try:
        # Init SOL vault
        sol_tx = init_sol_vault()
        print()

        # Init NULL vault
        null_tx = init_null_vault()
        print()

        print("🎉 All vaults initialized!")
        print(f"SOL Vault TX: https://explorer.solana.com/tx/{sol_tx}?cluster=devnet")
        print(f"NULL Vault TX: https://explorer.solana.com/tx/{null_tx}?cluster=devnet")

    except Exception as e:
        print(f"❌ Error: {e}")
        sys.exit(1)
