# 🔐 PROOF FORMAT DETERMINATION GUIDE

## 🚨 CRITICAL: Your Proof Format is NOT Frozen

The current implementation assumes a 256-byte proof format split as [64, 128, 64], but this **may not match** what `groth16-solana v0.0.2` actually expects.

## 📋 STEP-BY-STEP FORMAT DETERMINATION

### **Step 1: Generate a Real Proof**
```bash
# In your circuits directory
snarkjs groth16 prove circuit.zkey witness.wtns proof.json public.json
```

### **Step 2: Run Format Analysis**
```bash
python determine_proof_format.py path/to/proof.json
```
This creates test vectors in `tests/vectors/` for different formats.

### **Step 3: Test in Rust**
```bash
# Update tests/proof_format_test.rs to load your real proof
cargo test test_with_real_proof
```
This will show which format successfully parses with your verifier.

### **Step 4: Update Packer**
Once you know the working format, update `client/proof_packer.py` to implement it correctly.

### **Step 5: Create Golden Test Vector**
```bash
# Run successful packing on your real proof
# Save the output as tests/vectors/golden_proof.bin
# Add assertion in tests to ensure future changes don't break format
```

## 🎯 POSSIBLE FORMATS

### **Format A: Current (64/128/64 = 256 bytes)**
- What your code currently assumes
- May work if groth16-solana uses non-standard compression

### **Format B: Standard Ark (48/96/48 = 192 bytes)**
- Standard BN254 compressed point sizes
- Most likely correct for pure Ark libraries

### **Format C: Raw Coordinates (8×32 = 256 bytes)**
- ax, ay, bx1, bx2, by1, by2, cx, cy
- Common for Solana verifiers that handle raw coords

## ⚠️ WHY THIS MATTERS

**Getting proof format wrong = 100% verification failure**

Your "no spectre space" security depends on proofs actually verifying. If the byte format is wrong, **no transaction will ever succeed**.

## 🔧 IMMEDIATE ACTION REQUIRED

1. **Generate a real proof** with your circuit
2. **Run the determination script**
3. **Test in Rust** to find the working format
4. **Update the packer** to match
5. **Add golden test vector** to prevent regression

Only then can you claim "proof encoding frozen" and deploy safely.

## 📞 STATUS

**Current Status: INVESTIGATION REQUIRED**

**Next Step: Generate real proof and determine format**
