#![cfg(feature = "integration-tests")]

use pdx_dark_protocol::*;
use solana_program::pubkey::Pubkey;
use std::fs;

// Test to determine exact proof format expected by groth16-solana
#[test]
fn test_proof_format_detection() {
    println!("🧪 DETERMINING PROOF FORMAT FOR groth16-solana v0.0.2");

    // Read a real proof from disk if it exists (you'll generate this)
    // For now, we'll test with known invalid proofs to see error patterns

    // Test 1: Current format (64/128/64 = 256 bytes)
    let dummy_256 = vec![0u8; 256];
    test_format("Current (64/128/64)", &dummy_256, 256);

    // Test 2: Standard Ark (48/96/48 = 192 bytes)
    let dummy_192 = vec![0u8; 192];
    test_format("Standard Ark (48/96/48)", &dummy_192, 192);

    // Test 3: Raw coordinates (8 × 32 = 256 bytes)
    // This would be: ax, ay, bx1, bx2, by1, by2, cx, cy
    test_format("Raw coords (8×32)", &dummy_256, 256);

    println!("✅ Run this test with a real proof to see which format succeeds");
}

fn test_format(name: &str, proof_bytes: &[u8], expected_len: usize) {
    println!("\n📋 Testing {} format ({} bytes)", name, expected_len);

    if proof_bytes.len() != expected_len {
        println!("❌ Length mismatch");
        return;
    }

    // Try to call verify_proof with dummy public inputs
    let dummy_inputs = vec![
        [0u8; 32], // root
        [0u8; 32], // nullifier_asset
        [0u8; 32], // nullifier_fee
        [0u8; 32], // new_commitment
        [0u8; 32], // asset_id_hash
    ];

    // This will fail because proof is invalid, but we'll see parsing errors
    match verify_proof(proof_bytes, &dummy_inputs) {
        Ok(result) => println!("✅ Parsed successfully (verification: {})", result),
        Err(e) => println!("❌ Failed: {:?}", e),
    }
}

// Integration test: Generate real proof and test format
#[test]
#[ignore] // Remove this when you have real test vectors
fn test_with_real_proof() {
    // 1. Generate a real proof using snarkjs (you do this manually first)
    // 2. Save it as tests/vectors/proof.json
    // 3. Run this test to see which packing works

    let proof_path = "tests/vectors/proof.json";

    if !std::path::Path::new(proof_path).exists() {
        panic!("Generate a real proof first: {}", proof_path);
    }

    let proof_data: serde_json::Value = serde_json::from_reader(
        fs::File::open(proof_path).unwrap()
    ).unwrap();

    let proof = &proof_data["proof"];

    // Test different packing methods
    // This is where you'll add your packer functions

    println!("📄 Loaded real proof from {}", proof_path);
    println!("🔍 Now implement packers and test which one works");
}
