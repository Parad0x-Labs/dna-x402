use ark_bn254::{G1Affine, G2Affine};
use ark_serialize::CanonicalDeserialize;

// Test script to determine exact proof format expected by groth16-solana
// Run this to verify what byte format your verifier actually accepts

fn main() {
    println!("🧪 TESTING PROOF FORMAT FOR groth16-solana v0.0.2");

    // Test with a known valid proof (replace with your actual proof bytes)
    // For now, create a dummy test
    let dummy_proof = vec![0u8; 256];

    // Test current format: 64/128/64 = 256 bytes
    test_current_format(&dummy_proof);

    // Test standard Ark format: 48/96/48 = 192 bytes
    let dummy_proof_192 = vec![0u8; 192];
    test_standard_ark_format(&dummy_proof_192);

    println!("✅ Test complete - check which format succeeds");
}

fn test_current_format(proof_bytes: &[u8]) {
    println!("Testing current format (64/128/64 = 256 bytes)...");

    if proof_bytes.len() != 256 {
        println!("❌ Wrong length for current format");
        return;
    }

    // Try to parse with current logic
    let mut proof_a = [0u8; 64];
    proof_a.copy_from_slice(&proof_bytes[0..64]);

    match G1Affine::deserialize_compressed(&proof_a[..]) {
        Ok(a) => println!("✅ A parsed successfully"),
        Err(e) => println!("❌ A failed: {:?}", e),
    }

    let mut proof_b = [0u8; 128];
    proof_b.copy_from_slice(&proof_bytes[64..192]);

    match G2Affine::deserialize_compressed(&proof_b[..]) {
        Ok(b) => println!("✅ B parsed successfully"),
        Err(e) => println!("❌ B failed: {:?}", e),
    }

    let mut proof_c = [0u8; 64];
    proof_c.copy_from_slice(&proof_bytes[192..256]);

    match G1Affine::deserialize_compressed(&proof_c[..]) {
        Ok(c) => println!("✅ C parsed successfully"),
        Err(e) => println!("❌ C failed: {:?}", e),
    }
}

fn test_standard_ark_format(proof_bytes: &[u8]) {
    println!("Testing standard Ark format (48/96/48 = 192 bytes)...");

    if proof_bytes.len() != 192 {
        println!("❌ Wrong length for standard Ark format");
        return;
    }

    // Standard Ark BN254 compressed sizes
    match G1Affine::deserialize_compressed(&proof_bytes[0..48]) {
        Ok(a) => println!("✅ A parsed successfully (48 bytes)"),
        Err(e) => println!("❌ A failed: {:?}", e),
    }

    match G2Affine::deserialize_compressed(&proof_bytes[48..144]) {
        Ok(b) => println!("✅ B parsed successfully (96 bytes)"),
        Err(e) => println!("❌ B failed: {:?}", e),
    }

    match G1Affine::deserialize_compressed(&proof_bytes[144..192]) {
        Ok(c) => println!("✅ C parsed successfully (48 bytes)"),
        Err(e) => println!("❌ C failed: {:?}", e),
    }
}
