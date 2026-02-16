# TEST VECTORS FOR PROOF FORMAT LOCK

This directory contains golden test vectors that lock the proof format forever.

**FORMAT IS LOCKED - DO NOT CHANGE WITHOUT PROTOCOL V2**

## ONE-TIME GENERATION (AUTOMATED)

Run this script after generating a valid proof:

```bash
# 1. Generate proof (in circuits/ directory)
cd circuits/
snarkjs groth16 prove build/circuit_final.zkey witness.wtns proof.json public.json

# 2. Generate golden vectors automatically
cd ../  # back to project root
./generate_golden_vectors.sh

# 3. Run the lock test
cargo test test_golden_proof_format_lock
```

## MANUAL GENERATION (if script fails)

```bash
# Step 1: Pack proof into 256 bytes
python3 - <<'PY'
import json
from client.proof_packer import pack_snarkjs_proof_256

with open("circuits/proof.json", "r") as f:
    proof_data = json.load(f)

packed = pack_snarkjs_proof_256(proof_data["proof"])
with open("tests/vectors/golden_proof.bin", "wb") as f:
    f.write(packed)
PY

# Step 2: Convert public signals to inputs format
python3 - <<'PY'
import json

def i2be32_hex(n: int) -> str:
    return n.to_bytes(32, "big").hex()

with open("circuits/public.json", "r") as f:
    pub_data = json.load(f)

out = []
for s in pub_data:
    s = str(s)
    n = int(s, 16) if s.startswith(("0x", "0X")) else int(s, 10)
    out.append(i2be32_hex(n))

with open("tests/vectors/inputs.json", "w") as f:
    json.dump(out, f, indent=2)
PY
```

## FILES

- `golden_proof.bin` - 256 bytes of packed proof data (binary)
- `inputs.json` - Array of 5 hex strings (64 chars each, 32 bytes big-endian)
- `README.md` - This file

## DEBUGGING

If test_golden_proof_format_lock fails, check these in order:

1. **Fq2 limb order** (most common): B field ordering changed
   - Current: bx0, bx1, by0, by1 (Arkworks c0, c1)
   - If swapped, the test will fail with detailed hints

2. **Public input format**: Endianness/padding changed
   - Must be: 32 bytes big-endian, left-padded hex
   - Each input < BN254 modulus

3. **Verifying key**: Wrong VK committed
   - Must match the circuit that generated this proof

4. **A-negation**: On-chain handling changed
   - verify_groth16_solana A-negation logic modified

The test provides detailed error messages for each case.

## SECURITY IMPORTANCE

These vectors ensure that future changes to the proof packer or verifier don't silently break compatibility. If the test fails, someone changed the format and broke the protocol.

**COMMIT THESE FILES TO VERSION CONTROL**
**FORMAT IS LOCKED FOREVER - PROTOCOL V2 REQUIRES NEW VECTORS**