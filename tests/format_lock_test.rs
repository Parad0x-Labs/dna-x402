#![cfg(feature = "integration-tests")]

// FORMAT LOCK TEST - Prevents future regression of proof encoding
//
// This test loads committed golden test vectors and verifies they work.
// If this test fails, someone changed the proof format or packer.
//
// CI-ready: Only reads committed files, never generates anything.

#[test]
fn test_golden_proof_format_lock() {
    // Load committed golden test vectors
    let proof_path = "tests/vectors/golden_proof.bin";
    let inputs_path = "tests/vectors/inputs.json";

    // Check files exist (CI will fail here if not committed)
    if !std::path::Path::new(proof_path).exists() {
        panic!("❌ Golden proof vector missing. Run ./generate_golden_vectors.sh and commit files.");
    }
    if !std::path::Path::new(inputs_path).exists() {
        panic!("❌ Golden inputs vector missing. Run ./generate_golden_vectors.sh and commit files.");
    }

    // Load and validate proof bytes
    let proof = fs::read(proof_path)
        .expect("Failed to read golden proof");
    if proof.len() != 256 {
        panic!("❌ Golden proof length {} != 256 bytes. Format corrupted.", proof.len());
    }

    // Load and validate public inputs
    let inputs_hex: Vec<String> =
        serde_json::from_str(&fs::read_to_string(inputs_path).unwrap())
            .expect("Failed to parse inputs JSON");

    const N: usize = 5; // PDX Transfer has exactly 5 public inputs
    if inputs_hex.len() != N {
        panic!("❌ Golden inputs count {} != {} expected. Format corrupted.", inputs_hex.len(), N);
    }

    // Validate and convert hex strings to canonical big-endian bytes
    let mut public_inputs = [[0u8; 32]; N];
    for (i, hx) in inputs_hex.iter().enumerate() {
        let bytes = hex::decode(hx)
            .unwrap_or_else(|_| panic!("❌ Input {}: Invalid hex string '{}'", i, hx));

        if bytes.len() != 32 {
            panic!("❌ Input {}: Length {} != 32 bytes. Padding issue.", i, bytes.len());
        }

        // Verify input < BN254 modulus (big-endian)
        let input_bigint = num_bigint::BigUint::from_bytes_be(&bytes);
        let modulus = ark_bn254::Fr::MODULUS;
        if input_bigint >= *modulus {
            panic!("❌ Input {}: Value >= BN254 modulus. Invalid field element.", i);
        }

        public_inputs[i].copy_from_slice(&bytes);
    }

    // Attempt verification with helpful error messages
    match verify_groth16_solana::<N>(&proof, &public_inputs, &VERIFYING_KEY) {
        Ok(()) => {
            println!("✅ Golden proof verification succeeded - format is locked");
        }
        Err(e) => {
            // Detailed debugging hints for common failure modes
            println!("❌ GOLDEN PROOF VERIFICATION FAILED - FORMAT REGRESSION DETECTED!");
            println!("");
            println!("🔍 DEBUGGING HINTS:");
            println!("1. Most likely: B Fq2 limb order changed (bx0↔bx1 or by0↔by1)");
            println!("   Check: client/proof_packer.py Fq2 ordering");
            println!("");
            println!("2. Or: Public input endianness/padding changed");
            println!("   Check: inputs.json format (must be 32 bytes BE, left-padded)");
            println!("");
            println!("3. Or: Wrong verifying key committed");
            println!("   Check: src/verifying_key.rs matches circuit compilation");
            println!("");
            println!("4. Or: A-negation handling changed");
            println!("   Check: verify_groth16_solana A-negation logic");
            println!("");
            println!("❌ VERIFIER ERROR: {:?}", e);
            panic!("Format regression detected - see debugging hints above");
        }
    }
}
