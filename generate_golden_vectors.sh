#!/bin/bash
# Generate golden test vectors for PDX Dark Protocol
# Run this once to create the locked test vectors

set -e

echo "🔐 GENERATING GOLDEN TEST VECTORS FOR PDX DARK PROTOCOL"
echo "======================================================"

# Check if we have the required files
if [ ! -f "circuits/proof.json" ] || [ ! -f "circuits/public.json" ]; then
    echo "❌ Missing circuits/proof.json or circuits/public.json"
    echo "Run snarkjs groth16 prove first:"
    echo "  cd circuits/"
    echo "  snarkjs groth16 prove build/circuit_final.zkey witness.wtns proof.json public.json"
    exit 1
fi

echo "✅ Found proof.json and public.json"

# Create vectors directory
mkdir -p tests/vectors

# Step 1: Pack proof into 256 bytes
echo "📦 Packing proof into 256 bytes..."
python3 - <<'PY'
import json
import sys
sys.path.append('.')

from client.proof_packer import pack_snarkjs_proof_256

print("Loading proof.json...")
with open("circuits/proof.json", "r") as f:
    proof_data = json.load(f)

print("Packing proof...")
packed = pack_snarkjs_proof_256(proof_data["proof"])

print(f"Writing {len(packed)} bytes to tests/vectors/golden_proof.bin")
with open("tests/vectors/golden_proof.bin", "wb") as f:
    f.write(packed)

print("✅ Proof packed successfully")
PY

# Step 2: Convert public signals to inputs.json
echo "📝 Converting public signals to inputs format..."
python3 - <<'PY'
import json

def i2be32_hex(n: int) -> str:
    """Convert int to 32 bytes big-endian as hex string"""
    return n.to_bytes(32, "big").hex()

print("Loading public.json...")
with open("circuits/public.json", "r") as f:
    pub_data = json.load(f)

# pub_data should be an array of public signals
if not isinstance(pub_data, list):
    print("ERROR: public.json should be an array")
    sys.exit(1)

print(f"Converting {len(pub_data)} public signals...")

out = []
for s in pub_data:
    s = str(s)
    # Handle hex or decimal
    n = int(s, 16) if s.startswith(("0x", "0X")) else int(s, 10)
    out.append(i2be32_hex(n))

print("Writing to tests/vectors/inputs.json")
with open("tests/vectors/inputs.json", "w") as f:
    json.dump(out, f, indent=2)

print(f"✅ Converted {len(out)} inputs successfully")
PY

echo ""
echo "🎉 GOLDEN VECTORS GENERATED!"
echo "==========================="
echo "Files created:"
echo "  - tests/vectors/golden_proof.bin (256 bytes)"
echo "  - tests/vectors/inputs.json (5 hex strings)"
echo ""
echo "Next steps:"
echo "1. Commit these files to git"
echo "2. Run: cargo test test_golden_proof_format_lock"
echo "3. If test fails, debug Fq2 limb order (most common issue)"
echo ""
echo "🔒 FORMAT NOW LOCKED FOREVER"
echo "   These vectors prevent future compatibility breaks."
echo "   Any format change requires protocol v2 with new vectors."
echo ""
echo "📋 NEXT: Run the lock test"
echo "   cargo test test_golden_proof_format_lock"
echo ""
echo "✅ If test passes, commit these files to lock the format."
