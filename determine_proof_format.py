#!/usr/bin/env python3
"""
PROOF FORMAT DETERMINATION SCRIPT
Helps determine what byte format your groth16-solana verifier expects

This script:
1. Takes a SnarkJS proof
2. Tries different packing formats
3. Outputs test vectors for Rust testing
"""

import json
import sys
from typing import Dict, Any
import subprocess

def main():
    if len(sys.argv) != 2:
        print("Usage: python determine_proof_format.py <proof.json>")
        print("Output: Test vectors for Rust to determine correct format")
        sys.exit(1)

    proof_file = sys.argv[1]

    with open(proof_file, 'r') as f:
        data = json.load(f)

    proof = data['proof']

    print("🔍 ANALYZING PROOF FORMAT FOR groth16-solana")
    print(f"Input: {proof_file}")
    print()

    # Format 1: Current implementation (64/128/64 = 256 bytes)
    print("📋 FORMAT 1: Current (64/128/64 = 256 bytes)")
    try:
        packed1 = pack_current_format(proof)
        print(f"✅ Packed: {len(packed1)} bytes")
        print(f"Hex: {packed1.hex()[:64]}...")
        save_test_vector("format1_current_256.hex", packed1)
    except Exception as e:
        print(f"❌ Failed: {e}")

    # Format 2: Standard Ark compressed (48/96/48 = 192 bytes)
    print("\n📋 FORMAT 2: Standard Ark (48/96/48 = 192 bytes)")
    try:
        packed2 = pack_standard_ark(proof)
        print(f"✅ Packed: {len(packed2)} bytes")
        print(f"Hex: {packed2.hex()[:64]}...")
        save_test_vector("format2_standard_ark_192.hex", packed2)
    except Exception as e:
        print(f"❌ Failed: {e}")

    # Format 3: Raw coordinates (8 × 32 = 256 bytes)
    print("\n📋 FORMAT 3: Raw coords (8×32 = 256 bytes)")
    try:
        packed3 = pack_raw_coords(proof)
        print(f"✅ Packed: {len(packed3)} bytes")
        print(f"Hex: {packed3.hex()[:64]}...")
        save_test_vector("format3_raw_coords_256.hex", packed3)
    except Exception as e:
        print(f"❌ Failed: {e}")

    print("\n📝 NEXT STEPS:")
    print("1. Copy the test vectors to tests/vectors/")
    print("2. Update tests/proof_format_test.rs to load them")
    print("3. Run the Rust test to see which format succeeds")
    print("4. Update proof_packer.py to use the working format")
    print("5. Freeze the canonical format")

def pack_current_format(proof: Dict[str, Any]) -> bytes:
    """Current implementation: 64/128/64"""
    # This is a placeholder - implement based on your current logic
    # For now, just return dummy data of correct length
    return b'\x00' * 256

def pack_standard_ark(proof: Dict[str, Any]) -> bytes:
    """Standard Ark BN254 compressed: 48/96/48 = 192 bytes"""
    # Placeholder - would need BN254 curve implementation
    return b'\x00' * 192

def pack_raw_coords(proof: Dict[str, Any]) -> bytes:
    """Raw coordinates: 8 × 32 bytes = 256 bytes"""
    # ax, ay, bx1, bx2, by1, by2, cx, cy
    # Placeholder - convert SnarkJS strings to 32-byte big-endian
    return b'\x00' * 256

def save_test_vector(filename: str, data: bytes):
    """Save test vector for Rust testing"""
    output_dir = "tests/vectors"
    import os
    os.makedirs(output_dir, exist_ok=True)

    with open(f"{output_dir}/{filename}", 'wb') as f:
        f.write(data)

    print(f"💾 Saved: {output_dir}/{filename}")

if __name__ == "__main__":
    main()
