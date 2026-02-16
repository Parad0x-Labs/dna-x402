#!/usr/bin/env python3
"""
PDX Dark Protocol Test Suite
Tests compression, ZK proofs, and end-to-end functionality
"""

import pytest
import json
import tempfile
from pathlib import Path
from unittest.mock import Mock, patch
from nebula_core import NebulaCore
from dark_client import DarkClient

class TestNebulaCompression:
    """Test Nebula V23 compression engine"""

    def setup_method(self):
        self.nebula = NebulaCore()

    def test_compression_decompression(self):
        """Test that compression and decompression work correctly"""
        original_data = {
            "to": "11111111111111111111111111111112",
            "memo": "Parad0x Dark Protocol Test Transaction",
            "timestamp": 1640995200,
            "amount": "1000000",
            "asset": "SOL"
        }

        # Compress
        compressed = self.nebula.compress(original_data)

        # Decompress
        decompressed = self.nebula.decompress(compressed)

        # Verify
        assert decompressed == original_data

    def test_compression_ratio(self):
        """Test that compression achieves significant ratio"""
        large_data = {
            "transaction": {
                "sender": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                "receiver": "So11111111111111111111111111111111111111112",
                "amount": "5000000000",
                "fee": "5000",
                "memo": "This is a very long memo that should compress well with the Nebula engine because it contains repetitive text patterns and common cryptocurrency terminology that the dictionary can optimize for compression ratios.",
                "timestamp": 1640995200,
                "blockchain": "solana",
                "network": "mainnet-beta",
                "protocol": "PDX Dark Protocol",
                "version": "v23.1",
                "metadata": {
                    "gas_price": "0.000005",
                    "gas_limit": "200000",
                    "chain_id": 101,
                    "contract_address": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
                }
            },
            "privacy": {
                "nullifier_asset": "abc123def456",
                "nullifier_fee": "fee789ghi012",
                "commitment": "commitment_xyz",
                "root": "merkle_root_123"
            }
        }

        original_size = len(json.dumps(large_data).encode('utf-8'))
        compressed = self.nebula.compress(large_data)
        compressed_size = len(compressed)

        ratio = original_size / compressed_size
        print(f"Compression ratio: {ratio:.2f}x")

        # Should achieve at least 10x compression
        assert ratio > 10.0

    def test_invalid_artifact(self):
        """Test that invalid compressed data raises error"""
        with pytest.raises(ValueError, match="Invalid Nebula Artifact"):
            self.nebula.decompress(b"INVALID")

class TestDarkClient:
    """Test Dark Client functionality"""

    def setup_method(self):
        self.client = DarkClient.__new__(DarkClient)  # Don't call __init__
        self.client.nebula = NebulaCore()

    def test_serialize_instruction(self):
        """Test instruction serialization"""
        # Mock proof data
        proof_bytes = b"A" * 256  # 256 bytes
        public_inputs = {
            'root': b"R" * 32,
            'nullifier_asset': b"NA" * 16,
            'nullifier_fee': b"NF" * 16,
            'new_commitment': b"NC" * 16,
            'asset_id_hash': b"AH" * 16
        }
        compressed_payload = b"COMPRESSED_DATA"

        serialized = self.client._serialize_instruction(proof_bytes, public_inputs, compressed_payload)

        # Verify structure
        assert serialized[0] == 1  # Transfer variant

        # Parse back
        proof_len = int.from_bytes(serialized[1:5], 'little')
        assert proof_len == 256

        proof_start = 5
        proof_end = proof_start + 256
        assert serialized[proof_start:proof_end] == proof_bytes

        # Public inputs
        root_start = proof_end
        assert serialized[root_start:root_start+32] == public_inputs['root']

        # Payload
        payload_len_start = root_start + 32*5  # 5 public inputs
        payload_len = int.from_bytes(serialized[payload_len_start:payload_len_start+4], 'little')
        assert payload_len == len(compressed_payload)

        payload_start = payload_len_start + 4
        assert serialized[payload_start:] == compressed_payload

class TestIntegration:
    """Integration tests for the full protocol"""

    @patch('solana.rpc.api.Client')
    def test_transfer_flow(self, mock_client):
        """Test full transfer flow (mocked)"""
        # Mock RPC client
        mock_client_instance = Mock()
        mock_client.return_value = mock_client_instance

        # Mock responses
        mock_client_instance.get_recent_blockhash.return_value = Mock(value=Mock(blockhash="11111111111111111111111111111112"))
        mock_client_instance.send_transaction.return_value = Mock(value="tx_signature_123")
        mock_client_instance.confirm_transaction.return_value = True

        # Create client with mocked keypair
        client = DarkClient.__new__(DarkClient)
        client.rpc = mock_client_instance
        client.nebula = NebulaCore()

        # Mock keypair
        mock_keypair = Mock()
        mock_keypair.pubkey.return_value = Mock()
        client.keypair = mock_keypair

        # Mock transfer data
        asset_note = {
            'secret': 'secret123',
            'amount': 1000000,
            'asset_hash': 'hash123',
            'root': 'root123',
            'path_elements': [1, 2, 3],
            'path_indices': [0, 1, 0]
        }

        fee_note = {
            'secret': 'fee_secret',
            'path_elements': [4, 5, 6],
            'path_indices': [1, 0, 1]
        }

        recipient = Mock()
        memo = "Test transfer"

        # Mock the proof generation (would normally call snarkjs)
        with patch.object(client, '_generate_proof') as mock_proof:
            mock_proof.return_value = (b"P" * 256, {
                'root': b"R" * 32,
                'nullifier_asset': b"NA" * 16,
                'nullifier_fee': b"NF" * 16,
                'new_commitment': b"NC" * 16,
                'asset_id_hash': b"AH" * 16
            })

            # Execute transfer
            result = client.transfer(asset_note, fee_note, recipient, memo)

            # Verify success
            assert result == True
            mock_client_instance.send_transaction.assert_called_once()
            mock_client_instance.confirm_transaction.assert_called_once()

if __name__ == "__main__":
    # Run tests
    pytest.main([__file__, "-v"])
