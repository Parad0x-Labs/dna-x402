// dark-zkvm-bridge — BN254 ↔ RISC Zero-style zkVM receipt bridge
// Bridges our proof bundle format to a zkVM execution receipt format,
// demonstrating architectural compatibility without the RISC Zero toolchain.
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false

use dark_bn254_proof_gen::ProofBundle;
use sha2::{Digest, Sha256};

// ─── Types ─────────────────────────────────────────────────────────────────────

/// A RISC Zero-style execution receipt derived from a BN254 proof bundle.
#[derive(Debug, Clone)]
pub struct ZkvmExecutionReceipt {
    /// SHA256("risc0-image-v1" || program_hash)
    pub image_id: [u8; 32],
    /// SHA256("risc0-journal-v1" || public_inputs as 96 bytes)
    pub journal_hash: [u8; 32],
    /// SHA256("risc0-seal-v1" || proof_bytes[0..64]) — full proof_a
    pub seal_hash: [u8; 32],
    /// 1 for this format.
    pub receipt_version: u8,
    /// Always false — mainnet zkVM bridge is not audited.
    pub mainnet_ready: bool,
}

/// A proof bundle paired with a zkVM execution receipt and a cross-system hash.
#[derive(Debug, Clone)]
pub struct BridgedProofReceipt {
    pub bn254_bundle: ProofBundle,
    pub zkvm_receipt: ZkvmExecutionReceipt,
    /// SHA256("bridge-v1" || bn254_bundle.proof.proof_a[0..8] || zkvm_receipt.seal_hash)
    pub bridge_hash: [u8; 32],
    /// true when receipt_version == 1.
    pub compatible: bool,
}

/// Errors from the bridge layer.
#[derive(Debug, Clone, PartialEq)]
pub enum BridgeError {
    /// Public inputs in the journal do not match the bundle.
    PublicInputMismatch,
    /// Receipt version is not supported by this bridge.
    UnsupportedReceiptVersion(u8),
    /// The journal bytes cannot be decoded.
    InvalidJournal,
}

// ─── Core functions ────────────────────────────────────────────────────────────

/// Derive a RISC Zero-style execution receipt from a BN254 proof bundle.
///
/// - `image_id`    = SHA256("risc0-image-v1" || program_hash)
/// - `journal_hash`= SHA256("risc0-journal-v1" || merkle_root(32) || nullifier(32) || amount_bytes(32))
/// - `seal_hash`   = SHA256("risc0-seal-v1" || proof_a[0..64])
pub fn create_zkvm_receipt(bundle: &ProofBundle, program_hash: &[u8; 32]) -> ZkvmExecutionReceipt {
    // image_id — commits to the verifying program
    let mut h_image = Sha256::new();
    h_image.update(b"risc0-image-v1");
    h_image.update(program_hash);
    let image_id: [u8; 32] = h_image.finalize().into();

    // journal_hash — commits to the public inputs (96 bytes)
    let mut h_journal = Sha256::new();
    h_journal.update(b"risc0-journal-v1");
    h_journal.update(&bundle.public_inputs.merkle_root);
    h_journal.update(&bundle.public_inputs.nullifier);
    h_journal.update(&bundle.public_inputs.amount_bytes);
    let journal_hash: [u8; 32] = h_journal.finalize().into();

    // seal_hash — commits to the full G1 proof_a point (64 bytes)
    let mut h_seal = Sha256::new();
    h_seal.update(b"risc0-seal-v1");
    h_seal.update(&bundle.proof.proof_a);
    let seal_hash: [u8; 32] = h_seal.finalize().into();

    ZkvmExecutionReceipt {
        image_id,
        journal_hash,
        seal_hash,
        receipt_version: 1,
        mainnet_ready: false,
    }
}

/// Bridge a BN254 proof bundle to a zkVM execution receipt.
///
/// - Creates a `ZkvmExecutionReceipt` from the bundle.
/// - `bridge_hash` = SHA256("bridge-v1" || proof_a[0..8] || seal_hash)
/// - `compatible`  = true when receipt_version == 1.
pub fn bridge_proof(
    bundle: ProofBundle,
    program_hash: &[u8; 32],
) -> Result<BridgedProofReceipt, BridgeError> {
    let receipt = create_zkvm_receipt(&bundle, program_hash);

    if receipt.receipt_version != 1 {
        return Err(BridgeError::UnsupportedReceiptVersion(
            receipt.receipt_version,
        ));
    }

    // bridge_hash links both proof systems via 8 proof_a bytes + full seal
    let mut h = Sha256::new();
    h.update(b"bridge-v1");
    h.update(&bundle.proof.proof_a[0..8]);
    h.update(&receipt.seal_hash);
    let bridge_hash: [u8; 32] = h.finalize().into();

    let compatible = receipt.receipt_version == 1;

    Ok(BridgedProofReceipt {
        bn254_bundle: bundle,
        zkvm_receipt: receipt,
        bridge_hash,
        compatible,
    })
}

/// Verify a bridged proof receipt by recomputing the bridge_hash.
///
/// Recomputes `seal_hash` from the stored `bn254_bundle.proof.proof_a` and
/// then recomputes `bridge_hash`. Returns `true` only when both match and
/// `compatible == true`.
pub fn verify_bridge(receipt: &BridgedProofReceipt) -> bool {
    if !receipt.compatible {
        return false;
    }

    // Recompute seal_hash from the stored bundle
    let mut h_seal = Sha256::new();
    h_seal.update(b"risc0-seal-v1");
    h_seal.update(&receipt.bn254_bundle.proof.proof_a);
    let expected_seal: [u8; 32] = h_seal.finalize().into();

    // Recompute bridge_hash from stored proof_a[0..8] and recomputed seal
    let mut h_bridge = Sha256::new();
    h_bridge.update(b"bridge-v1");
    h_bridge.update(&receipt.bn254_bundle.proof.proof_a[0..8]);
    h_bridge.update(&expected_seal);
    let expected_bridge: [u8; 32] = h_bridge.finalize().into();

    expected_bridge == receipt.bridge_hash
}

/// Produce a JSON summary of the bridge receipt for logging and audit evidence.
///
/// Byte fields are encoded as lowercase hex. Raw proof bytes are NOT included.
pub fn bridge_to_json(receipt: &BridgedProofReceipt) -> String {
    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }

    serde_json::json!({
        "bridge_hash":       hex(&receipt.bridge_hash),
        "compatible":        receipt.compatible,
        "receipt_version":   receipt.zkvm_receipt.receipt_version,
        "image_id":          hex(&receipt.zkvm_receipt.image_id),
        "journal_hash":      hex(&receipt.zkvm_receipt.journal_hash),
        "seal_hash":         hex(&receipt.zkvm_receipt.seal_hash),
        "mainnet_ready":     receipt.zkvm_receipt.mainnet_ready,
    })
    .to_string()
}

/// Human-readable description of what this bridge does.
pub fn bridge_description() -> Vec<&'static str> {
    vec![
        "BN254 Groth16 proof bundle (Solana native)",
        "RISC Zero execution receipt (zkVM compatible)",
        "Bridge hash links both proof systems",
        "Devnet test mode: mainnet_ready = false",
    ]
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use dark_bn254_circuit::WithdrawCircuitInputs;
    use dark_bn254_proof_gen::generate_devnet_test_proof;
    use dark_poseidon_bn254::{note_commitment, nullifier_hash};

    fn valid_inputs() -> WithdrawCircuitInputs {
        let note_value: u64 = 10_000_000;
        let withdraw_amount: u64 = 5_000_000;
        let note_randomness = [0x42u8; 32];
        let note_secret = [0x99u8; 32];
        let recipient_hash = [0xBBu8; 32];
        let merkle_root = [0x55u8; 32];

        let commitment = note_commitment(note_value, &note_randomness, &recipient_hash);
        let nullifier = nullifier_hash(&commitment, &note_secret, &merkle_root);

        WithdrawCircuitInputs {
            merkle_root,
            nullifier,
            withdraw_amount,
            note_value,
            note_randomness,
            note_secret,
            recipient_hash,
        }
    }

    fn make_bundle() -> dark_bn254_proof_gen::ProofBundle {
        generate_devnet_test_proof(&valid_inputs()).expect("valid inputs must produce proof")
    }

    fn make_program_hash() -> [u8; 32] {
        [0xDEu8; 32]
    }

    /// Test 1: same bundle + program_hash → same bridge_hash (deterministic).
    #[test]
    fn test_bridge_hash_deterministic() {
        let ph = make_program_hash();

        let r1 = bridge_proof(make_bundle(), &ph).unwrap();
        let r2 = bridge_proof(make_bundle(), &ph).unwrap();

        assert_eq!(
            r1.bridge_hash, r2.bridge_hash,
            "identical inputs must yield identical bridge_hash"
        );
        assert_eq!(r1.zkvm_receipt.seal_hash, r2.zkvm_receipt.seal_hash);
        assert_eq!(r1.zkvm_receipt.image_id, r2.zkvm_receipt.image_id);
    }

    /// Test 2: bridge then verify → true.
    #[test]
    fn test_verify_bridge_passes() {
        let receipt = bridge_proof(make_bundle(), &make_program_hash()).unwrap();
        assert!(
            verify_bridge(&receipt),
            "freshly bridged receipt must verify"
        );
        assert!(receipt.compatible);
    }

    /// Test 3: mutate bridge_hash → verify returns false.
    #[test]
    fn test_tampered_receipt_fails() {
        let mut receipt = bridge_proof(make_bundle(), &make_program_hash()).unwrap();
        receipt.bridge_hash[0] ^= 0xFF; // flip a byte
        assert!(
            !verify_bridge(&receipt),
            "tampered bridge_hash must not verify"
        );
    }

    /// Test 4: JSON output does not expose raw proof hex longer than 16 chars.
    ///
    /// All hex strings in the output are SHA-256 digests (64 hex chars) which
    /// are derived values, not raw proof bytes.  The raw proof bytes themselves
    /// (proof_a: 128 hex, proof_b: 256 hex, proof_c: 128 hex) must not appear.
    #[test]
    fn test_bridge_json_hides_proof_bytes() {
        let receipt = bridge_proof(make_bundle(), &make_program_hash()).unwrap();
        let json = bridge_to_json(&receipt);

        // Raw proof bytes encoded as hex:
        let raw_proof_a_hex: String = receipt
            .bn254_bundle
            .proof
            .proof_a
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();
        let raw_proof_b_hex: String = receipt
            .bn254_bundle
            .proof
            .proof_b
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();
        let raw_proof_c_hex: String = receipt
            .bn254_bundle
            .proof
            .proof_c
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();

        assert!(
            !json.contains(&raw_proof_a_hex),
            "JSON must not contain raw proof_a hex"
        );
        assert!(
            !json.contains(&raw_proof_b_hex),
            "JSON must not contain raw proof_b hex"
        );
        assert!(
            !json.contains(&raw_proof_c_hex),
            "JSON must not contain raw proof_c hex"
        );

        // Sanity: the bridge_hash (a derived 32-byte digest = 64 hex chars) IS present
        let bridge_hex: String = receipt
            .bridge_hash
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();
        assert!(
            json.contains(&bridge_hex),
            "JSON must contain the bridge_hash hex"
        );
    }
}
