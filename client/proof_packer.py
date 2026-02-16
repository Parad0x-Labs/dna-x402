#!/usr/bin/env python3
"""
CANONICAL PROOF PACKER FOR PDX DARK PROTOCOL
Converts SnarkJS proof format to groth16-solana expected format (256 bytes)

This matches the groth16-solana verifier expectations exactly:
- A: 64 bytes (G1 point as expected by verifier)
- B: 128 bytes (G2 point as expected by verifier)
- C: 64 bytes (G1 point as expected by verifier)
"""

import json
import sys


def parse_int(x):
    """Parse integer from string or int, handling hex"""
    if isinstance(x, int):
        return x
    x = str(x)
    if x.startswith("0x") or x.startswith("0X"):
        return int(x, 16)
    return int(x, 10)


def i2be32(n: int) -> bytes:
    """Convert int to 32 bytes big-endian"""
    if n < 0:
        raise ValueError("negative not allowed")
    return n.to_bytes(32, "big")


def pack_snarkjs_proof_256(proof_json: dict) -> bytes:
    """
    LOCKED FORMAT: Convert SnarkJS proof to groth16-solana format (256 bytes)

    This format is locked by golden test vectors. DO NOT CHANGE.

    Fq2 limb order: bx0, bx1, by0, by1 (Arkworks c0, c1 convention)
    Raw SnarkJS points - on-chain handles A-negation.
    Big-endian 32-byte limbs throughout.
    """
    a = proof_json["pi_a"]  # [ax, ay, 1]
    b = proof_json["pi_b"]  # [[bx0, bx1], [by0, by1], [1,0]]
    c = proof_json["pi_c"]  # [cx, cy, 1]

    ax, ay = parse_int(a[0]), parse_int(a[1])
    cx, cy = parse_int(c[0]), parse_int(c[1])

    # LOCKED: Arkworks Fq2 order (c0, c1) - verified by golden vectors
    bx0, bx1 = parse_int(b[0][0]), parse_int(b[0][1])
    by0, by1 = parse_int(b[1][0]), parse_int(b[1][1])

    out = b"".join([
        i2be32(ax), i2be32(ay),
        i2be32(bx0), i2be32(bx1), i2be32(by0), i2be32(by1),
        i2be32(cx), i2be32(cy),
    ])

    if len(out) != 256:
        raise ValueError(f"proof packing failed: got {len(out)} bytes, expected 256")
    return out


def main():
    """CLI interface for proof packing"""
    if len(sys.argv) != 2:
        print("Usage: python proof_packer.py <proof.json>")
        print("Outputs 256-byte proof in groth16-solana format")
        sys.exit(1)

    proof_path = sys.argv[1]

    try:
        with open(proof_path, "r") as f:
            proof_data = json.load(f)

        # Use the FROZEN packer for groth16-solana (no options)
        packed = pack_snarkjs_proof_256(proof_data["proof"])

        # Output as hex for Solana transactions
        hex_output = "0x" + packed.hex()
        print(hex_output)

        # Save to file
        output_file = proof_path.replace('.json', '_packed.hex')
        with open(output_file, 'w') as f:
            f.write(hex_output)

        print(f"✅ Proof packed: {len(packed)} bytes (groth16-solana format)")
        print(f"💾 Saved to: {output_file}")

    except Exception as e:
        print(f"❌ Error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()