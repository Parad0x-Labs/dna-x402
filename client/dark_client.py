import sys
import json
import struct
import subprocess
import time
import os
import tempfile
from pathlib import Path
from solders.pubkey import Pubkey
from solders.transaction import Transaction
from solders.instruction import Instruction, AccountMeta
from solders.system_program import ID as SYS_ID
from solana.rpc.api import Client
from solana.rpc.commitment import Confirmed
# Constants for Token 2022
TOKEN_2022_PROGRAM_ID = Pubkey.from_string("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")

def get_associated_token_address(owner, mint, token_program_id=None):
    """Derive associated token address"""
    if token_program_id is None:
        token_program_id = TOKEN_2022_PROGRAM_ID
    ata_program = Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
    seeds = [bytes(owner), bytes(token_program_id), bytes(mint)]
    return Pubkey.find_program_address(seeds, ata_program)[0]

# Import the Nebula Engine
from nebula_core import NebulaCore

# PDX Dark Protocol - Deployed Addresses
PROGRAM_ID = Pubkey.from_string("3hYWUSYmNCzrHNgsE6xo3jKT9GjCFxCpPWXj4Q4imToz")
NULL_MINT = Pubkey.from_string("ADVjd6sSVsjc165FnisTrb4HvtoLNy4RHAp2rbG1oGNa")

class DarkClient:
    def __init__(self, keypair_path, rpc_url="https://api.devnet.solana.com"):
        self.rpc = Client(rpc_url)
        self.nebula = NebulaCore()

        # Load Keypair
        with open(keypair_path, 'r') as f:
            keypair_data = json.load(f)
        self.keypair = self._bytes_to_keypair(bytes(keypair_data))

    def transfer(self, asset_note, fee_note, recipient_pubkey, memo):
        print(f"[*] Preparing Dark Transfer...")
        print(f"[*] Burning 1.0 $NULL Fee (Token-2022)...")

        # 1. Compress Memo with Nebula
        payload = {
            "to": str(recipient_pubkey),
            "memo": memo,
            "timestamp": int(time.time())
        }
        compressed_payload = self.nebula.compress(payload)
        print(f"[*] Nebula Compression: {len(json.dumps(payload))}b -> {len(compressed_payload)}b")

        # 2. Generate ZK Proof
        proof_data, public_inputs = self._generate_proof(asset_note, fee_note)

        # 3. Derive Token-2022 $NULL fee ATA
        null_fee_mint = Pubkey.from_string("8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump")
        payer_fee_ata = get_associated_token_address(
            self.keypair.pubkey(),
            null_fee_mint,
            TOKEN_2022_PROGRAM_ID
        )

        # 4. Build Instruction
        ix_data = self._serialize_instruction(proof_data, public_inputs, compressed_payload)

        # 4. Accounts for vault burn (9 total)
        null_asset_pda = self._derive_nullifier(public_inputs['nullifier_asset'])
        null_fee_pda = self._derive_nullifier(public_inputs['nullifier_fee'])
        vault_pda = self._derive_vault()
        vault_authority = self._derive_vault_authority()
        null_vault_ata = self._derive_null_vault_ata(null_fee_mint)

        ix = Instruction(
            PROGRAM_ID,
            ix_data,
            [
                AccountMeta(self.keypair.pubkey(), True, True),        # 0: payer
                AccountMeta(null_asset_pda, False, True),              # 1: null_asset_pda
                AccountMeta(null_fee_pda, False, True),                # 2: null_fee_pda
                AccountMeta(vault_pda, False, True),                   # 3: vault_pda (SOL)
                AccountMeta(SYS_ID, False, False),                     # 4: system_program
                AccountMeta(TOKEN_2022_PROGRAM_ID, False, False),      # 5: token_2022_program
                AccountMeta(null_fee_mint, False, False),              # 6: fee_mint
                AccountMeta(null_vault_ata, False, True),              # 7: null_vault_ata
                AccountMeta(vault_authority, False, True),             # 8: vault_authority
            ]
        )

        # 5. Send Transaction
        print("[*] Broadcasting to Solana...")
        try:
            # Get recent blockhash
            recent_blockhash = self.rpc.get_recent_blockhash(Confirmed).value.blockhash

            # Create and sign transaction
            tx = Transaction()
            tx.recent_blockhash = recent_blockhash
            tx.add(ix)
            tx.sign(self.keypair)

            # Send transaction
            result = self.rpc.send_transaction(tx, opts={"skip_preflight": False})
            print(f"[SUCCESS] Transaction Sent: {result.value}")

            # Wait for confirmation
            self.rpc.confirm_transaction(result.value, Confirmed)
            print("[SUCCESS] Transaction Confirmed!")

        except Exception as e:
            print(f"[ERROR] Transaction failed: {e}")
            return False

        return True

    def _generate_proof(self, asset_note, fee_note):
        """Generate ZK proof using snarkjs"""
        # Create temporary directory for proof generation
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)

            # Create input.json for snarkjs
            input_data = {
                "root": asset_note['root'],
                "nullifierHash_Asset": self._hash_nullifier(asset_note['secret'], 111),
                "nullifierHash_Fee": self._hash_nullifier(fee_note['secret'], 222),
                "commitment_New": self._generate_commitment(asset_note['secret'], asset_note['amount'], asset_note['asset_hash']),
                "assetIdHash": asset_note['asset_hash'],
                "secret_Asset": asset_note['secret'],
                "amount_Asset": asset_note['amount'],
                "pathElements_Asset": asset_note['path_elements'],
                "pathIndices_Asset": asset_note['path_indices'],
                "secret_Fee": fee_note['secret'],
                "amount_Fee": 1000000000,  # 1.0 $NULL
                "pathElements_Fee": fee_note['path_elements'],
                "pathIndices_Fee": fee_note['path_indices']
            }

            input_file = temp_path / "input.json"
            with open(input_file, 'w') as f:
                json.dump(input_data, f)

            # Run snarkjs prove
            proof_file = temp_path / "proof.json"
            public_file = temp_path / "public.json"

            try:
                subprocess.run([
                    "snarkjs", "groth16", "prove",
                    "../../circuits/dark.zkey",
                    str(input_file),
                    str(proof_file),
                    str(public_file)
                ], check=True, cwd=temp_dir)

                # Read proof and public inputs
                with open(proof_file, 'r') as f:
                    proof = json.load(f)
                with open(public_file, 'r') as f:
                    public_inputs = json.load(f)

                # Convert proof to bytes (Groth16 format)
                proof_bytes = self._proof_to_bytes(proof)

                return proof_bytes, {
                    'root': bytes.fromhex(public_inputs[0][2:]),
                    'nullifier_asset': bytes.fromhex(public_inputs[1][2:]),
                    'nullifier_fee': bytes.fromhex(public_inputs[2][2:]),
                    'new_commitment': bytes.fromhex(public_inputs[3][2:]),
                    'asset_id_hash': bytes.fromhex(public_inputs[4][2:])
                }

            except subprocess.CalledProcessError as e:
                print(f"[ERROR] Proof generation failed: {e}")
                raise

    def _proof_to_bytes(self, proof):
        """Convert snarkjs proof JSON to bytes for Solana"""
        # Groth16 proof format: [a, b, c] where a and c are G1, b is G2
        a_x = int(proof['pi_a'][0], 16).to_bytes(32, 'big')
        a_y = int(proof['pi_a'][1], 16).to_bytes(32, 'big')

        b_x1 = int(proof['pi_b'][0][0], 16).to_bytes(32, 'big')
        b_x2 = int(proof['pi_b'][0][1], 16).to_bytes(32, 'big')
        b_y1 = int(proof['pi_b'][1][0], 16).to_bytes(32, 'big')
        b_y2 = int(proof['pi_b'][1][1], 16).to_bytes(32, 'big')

        c_x = int(proof['pi_c'][0], 16).to_bytes(32, 'big')
        c_y = int(proof['pi_c'][1], 16).to_bytes(32, 'big')

        return a_x + a_y + b_x1 + b_x2 + b_y1 + b_y2 + c_x + c_y

    def _serialize_instruction(self, proof_bytes, public_inputs, compressed_payload):
        """Serialize instruction data for the program"""
        # Instruction format:
        # 1 byte: variant (1 = Transfer)
        # 1 byte: asset_type (0 = NativeSol, 1 = SplToken, 2 = Token2022)
        # 8 bytes: amount (u64)
        # 4 bytes: proof length
        # N bytes: proof
        # 32 bytes: root
        # 32 bytes: nullifier_asset
        # 32 bytes: nullifier_fee
        # 32 bytes: new_commitment
        # 32 bytes: asset_id_hash
        # 4 bytes: payload length
        # N bytes: compressed payload

        data = bytearray()
        data.append(1)  # Transfer variant

        # Asset type (for now, assume NativeSol = 0)
        data.append(0)  # AssetType::NativeSol

        # Amount (placeholder - will be 0 for now since we're focusing on fee burn)
        data.extend((0).to_bytes(8, 'little'))

        # Proof
        data.extend(len(proof_bytes).to_bytes(4, 'little'))
        data.extend(proof_bytes)

        # Public inputs
        data.extend(public_inputs['root'])
        data.extend(public_inputs['nullifier_asset'])
        data.extend(public_inputs['nullifier_fee'])
        data.extend(public_inputs['new_commitment'])
        data.extend(public_inputs['asset_id_hash'])

        # Compressed payload
        data.extend(len(compressed_payload).to_bytes(4, 'little'))
        data.extend(compressed_payload)

        return bytes(data)

    def _hash_nullifier(self, secret, domain):
        """Hash secret with domain for nullifier"""
        # This should match the circuit's Poseidon hash
        # For now, simple hash - in production use proper Poseidon
        import hashlib
        data = str(secret) + str(domain)
        return hashlib.sha256(data.encode()).digest()

    def _generate_commitment(self, secret, amount, asset_hash):
        """Generate new commitment"""
        # This should match the circuit's Poseidon hash
        import hashlib
        data = str(secret) + str(amount) + str(asset_hash)
        return hashlib.sha256(data.encode()).digest()

    def _derive_nullifier(self, null_hash):
        """Derive PDA for nullifier"""
        pda, _ = Pubkey.find_program_address([b"pdx_nullifier", null_hash], PROGRAM_ID)
        return pda

    def _derive_vault(self):
        """Derive PDA for SOL vault"""
        pda, _ = Pubkey.find_program_address([b"pdx_vault"], PROGRAM_ID)
        return pda

    def _derive_vault_authority(self):
        """Derive PDA for $NULL vault authority"""
        pda, _ = Pubkey.find_program_address([b"pdx_null_vault"], PROGRAM_ID)
        return pda

    def _derive_null_vault_ata(self, null_mint):
        """Derive ATA for $NULL vault"""
        vault_authority = self._derive_vault_authority()
        ata = get_associated_token_address(
            vault_authority,
            null_mint,
            TOKEN_2022_PROGRAM_ID
        )
        return ata

    def _bytes_to_keypair(self, keypair_bytes):
        """Convert bytes to solders Keypair"""
        from solders.keypair import Keypair
        return Keypair.from_bytes(keypair_bytes)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python dark_client.py <keypair.json>")
        sys.exit(1)

    client = DarkClient(sys.argv[1])

    # Example usage (you'll need real note data)
    # client.transfer(asset_note, fee_note, recipient_pubkey, "Mission Complete.")
