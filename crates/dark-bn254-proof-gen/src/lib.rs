// dark-bn254-proof-gen — off-chain BN254 Groth16 proof bundle generator
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false

use sha2::{Digest, Sha256};

// ─── Public types ──────────────────────────────────────────────────────────────

/// Raw byte representation of a BN254 Groth16 proof.
///
/// Layout (uncompressed affine coordinates):
/// - `proof_a` — G1 point:  x(32) || y(32)               =  64 bytes
/// - `proof_b` — G2 point:  x0(32)||x1(32)||y0(32)||y1(32) = 128 bytes
/// - `proof_c` — G1 point:  x(32) || y(32)               =  64 bytes
///
/// Total wire size: 256 bytes (matches [`serialize_proof`] output).
#[derive(Debug, Clone)]
pub struct Bn254ProofBytes {
    pub proof_a: [u8; 64],  // G1 point
    pub proof_b: [u8; 128], // G2 point
    pub proof_c: [u8; 64],  // G1 point
}

/// The three public inputs for the withdrawal circuit.
#[derive(Debug, Clone)]
pub struct WithdrawPublicInputs {
    pub merkle_root: [u8; 32],
    pub nullifier: [u8; 32],
    pub amount_bytes: [u8; 32], // u64 in little-endian, zero-padded to 32 bytes
}

/// A fully assembled proof + public inputs, ready for the on-chain gate.
#[derive(Debug, Clone)]
pub struct ProofBundle {
    pub proof: Bn254ProofBytes,
    pub public_inputs: WithdrawPublicInputs,
    pub circuit_version: u8, // always 1 for now
    pub mainnet_ready: bool, // always false
}

/// Errors produced by this crate.
#[derive(Debug, Clone, PartialEq)]
pub enum ProofError {
    /// A circuit constraint was violated (underflow, nullifier mismatch, …).
    CircuitViolation(String),
    /// The provided amount is out of range.
    InvalidAmount,
    /// Serialisation / deserialisation failure.
    SerializationError,
}

impl From<dark_bn254_circuit::CircuitError> for ProofError {
    fn from(e: dark_bn254_circuit::CircuitError) -> Self {
        ProofError::CircuitViolation(format!("{:?}", e))
    }
}

// ─── Core helpers ──────────────────────────────────────────────────────────────

/// Pack the 256-byte BN254 Groth16 wire format:
/// `proof_a(64) || proof_b(128) || proof_c(64)` = 256 bytes.
pub fn serialize_proof(proof: &Bn254ProofBytes) -> [u8; 256] {
    let mut out = [0u8; 256];
    out[0..64].copy_from_slice(&proof.proof_a);
    out[64..192].copy_from_slice(&proof.proof_b);
    out[192..256].copy_from_slice(&proof.proof_c);
    out
}

/// Encode a `u64` as a 32-byte little-endian field element (zero-padded).
pub fn amount_to_field_element(amount: u64) -> [u8; 32] {
    let mut fe = [0u8; 32];
    fe[0..8].copy_from_slice(&amount.to_le_bytes());
    fe
}

// ─── Proof generation ──────────────────────────────────────────────────────────

/// Generate a **deterministic devnet test proof** for the given circuit inputs.
///
/// This is NOT a real Groth16 proof.  It produces consistent, structured byte
/// arrays so that the on-chain gate (running in `test_mode`) can exercise the
/// parsing and layout logic without an arkworks toolchain.
///
/// Steps:
/// 1. Run [`dark_bn254_circuit::simulate_verify`] — any constraint violation
///    is mapped to [`ProofError::CircuitViolation`].
/// 2. Derive deterministic G1/G2 point bytes from SHA-256 keyed on the public
///    inputs.
/// 3. Wrap everything in a [`ProofBundle`] with `mainnet_ready = false`.
pub fn generate_devnet_test_proof(
    inputs: &dark_bn254_circuit::WithdrawCircuitInputs,
) -> Result<ProofBundle, ProofError> {
    // Step 1 — enforce circuit constraints
    dark_bn254_circuit::simulate_verify(inputs)?;

    let merkle_root = inputs.merkle_root;
    let nullifier = inputs.nullifier;
    let amount_bytes = amount_to_field_element(inputs.withdraw_amount);

    // Helper: SHA-256(domain_tag || merkle_root || nullifier || amount_bytes)
    let hash_with_tag = |tag: &[u8]| -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(tag);
        h.update(merkle_root);
        h.update(nullifier);
        h.update(amount_bytes);
        h.finalize().into()
    };

    // Step 2 — build deterministic point bytes
    // proof_a: 2 × SHA-256 = 64 bytes
    let mut proof_a = [0u8; 64];
    proof_a[0..32].copy_from_slice(&hash_with_tag(b"devnet-proof-a-0"));
    proof_a[32..64].copy_from_slice(&hash_with_tag(b"devnet-proof-a-1"));

    // proof_b: 4 × SHA-256 = 128 bytes
    let mut proof_b = [0u8; 128];
    proof_b[0..32].copy_from_slice(&hash_with_tag(b"devnet-proof-b-0"));
    proof_b[32..64].copy_from_slice(&hash_with_tag(b"devnet-proof-b-1"));
    proof_b[64..96].copy_from_slice(&hash_with_tag(b"devnet-proof-b-2"));
    proof_b[96..128].copy_from_slice(&hash_with_tag(b"devnet-proof-b-3"));

    // proof_c: 2 × SHA-256 = 64 bytes
    let mut proof_c = [0u8; 64];
    proof_c[0..32].copy_from_slice(&hash_with_tag(b"devnet-proof-c-0"));
    proof_c[32..64].copy_from_slice(&hash_with_tag(b"devnet-proof-c-1"));

    Ok(ProofBundle {
        proof: Bn254ProofBytes {
            proof_a,
            proof_b,
            proof_c,
        },
        public_inputs: WithdrawPublicInputs {
            merkle_root,
            nullifier,
            amount_bytes,
        },
        circuit_version: 1,
        mainnet_ready: false,
    })
}

// ─── Transaction data helpers ──────────────────────────────────────────────────

/// Serialise a [`ProofBundle`] into the 352-byte instruction data format:
/// `proof_bytes(256) || merkle_root(32) || nullifier(32) || amount_bytes(32)`
pub fn build_withdraw_tx_data(bundle: &ProofBundle) -> [u8; 352] {
    let mut out = [0u8; 352];
    let proof_bytes = serialize_proof(&bundle.proof);
    out[0..256].copy_from_slice(&proof_bytes);
    out[256..288].copy_from_slice(&bundle.public_inputs.merkle_root);
    out[288..320].copy_from_slice(&bundle.public_inputs.nullifier);
    out[320..352].copy_from_slice(&bundle.public_inputs.amount_bytes);
    out
}

/// Inverse of [`build_withdraw_tx_data`]: reconstruct a [`ProofBundle`] from
/// the 352-byte instruction data slice.
///
/// `circuit_version` is set to 1 and `mainnet_ready` to false (the wire
/// format carries only proof + public inputs; metadata is implied).
pub fn parse_withdraw_tx_data(data: &[u8; 352]) -> Result<ProofBundle, ProofError> {
    let mut proof_a = [0u8; 64];
    let mut proof_b = [0u8; 128];
    let mut proof_c = [0u8; 64];
    let mut merkle_root = [0u8; 32];
    let mut nullifier = [0u8; 32];
    let mut amount_bytes = [0u8; 32];

    proof_a.copy_from_slice(&data[0..64]);
    proof_b.copy_from_slice(&data[64..192]);
    proof_c.copy_from_slice(&data[192..256]);
    merkle_root.copy_from_slice(&data[256..288]);
    nullifier.copy_from_slice(&data[288..320]);
    amount_bytes.copy_from_slice(&data[320..352]);

    Ok(ProofBundle {
        proof: Bn254ProofBytes {
            proof_a,
            proof_b,
            proof_c,
        },
        public_inputs: WithdrawPublicInputs {
            merkle_root,
            nullifier,
            amount_bytes,
        },
        circuit_version: 1,
        mainnet_ready: false,
    })
}

// ─── JSON helper ───────────────────────────────────────────────────────────────

/// Serialise a [`ProofBundle`] to JSON for logging / audit evidence.
///
/// All byte arrays are encoded as lowercase hex strings.
pub fn proof_bundle_to_json(bundle: &ProofBundle) -> serde_json::Value {
    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }

    serde_json::json!({
        "circuit_version": bundle.circuit_version,
        "mainnet_ready": bundle.mainnet_ready,
        "proof": {
            "proof_a": hex(&bundle.proof.proof_a),
            "proof_b": hex(&bundle.proof.proof_b),
            "proof_c": hex(&bundle.proof.proof_c),
        },
        "public_inputs": {
            "merkle_root":   hex(&bundle.public_inputs.merkle_root),
            "nullifier":     hex(&bundle.public_inputs.nullifier),
            "amount_bytes":  hex(&bundle.public_inputs.amount_bytes),
        }
    })
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use dark_poseidon_bn254::{note_commitment, nullifier_hash};

    /// Build a valid set of circuit inputs whose constraints all pass.
    fn valid_inputs() -> dark_bn254_circuit::WithdrawCircuitInputs {
        let note_value: u64 = 10_000_000;
        let withdraw_amount: u64 = 5_000_000;
        let note_randomness = [0x42u8; 32];
        let note_secret = [0x99u8; 32];
        let recipient_hash = [0xBBu8; 32];
        let merkle_root = [0x55u8; 32];

        let commitment = note_commitment(note_value, &note_randomness, &recipient_hash);
        let nullifier = nullifier_hash(&commitment, &note_secret, &merkle_root);

        dark_bn254_circuit::WithdrawCircuitInputs {
            merkle_root,
            nullifier,
            withdraw_amount,
            note_value,
            note_randomness,
            note_secret,
            recipient_hash,
        }
    }

    /// Test 1: generated bundles must always have mainnet_ready = false.
    #[test]
    fn test_proof_bundle_mainnet_ready_false() {
        let inputs = valid_inputs();
        let bundle = generate_devnet_test_proof(&inputs).expect("valid inputs should succeed");
        assert!(!bundle.mainnet_ready, "mainnet_ready must always be false");
    }

    /// Test 2: build_withdraw_tx_data → parse_withdraw_tx_data round-trip.
    #[test]
    fn test_serialize_deserialize_roundtrip() {
        let inputs = valid_inputs();
        let bundle = generate_devnet_test_proof(&inputs).unwrap();

        let wire = build_withdraw_tx_data(&bundle);
        let recovered = parse_withdraw_tx_data(&wire).unwrap();

        assert_eq!(recovered.proof.proof_a, bundle.proof.proof_a);
        assert_eq!(recovered.proof.proof_b, bundle.proof.proof_b);
        assert_eq!(recovered.proof.proof_c, bundle.proof.proof_c);
        assert_eq!(
            recovered.public_inputs.merkle_root,
            bundle.public_inputs.merkle_root
        );
        assert_eq!(
            recovered.public_inputs.nullifier,
            bundle.public_inputs.nullifier
        );
        assert_eq!(
            recovered.public_inputs.amount_bytes,
            bundle.public_inputs.amount_bytes
        );
    }

    /// Test 3: withdraw_amount > note_value must propagate as CircuitViolation.
    #[test]
    fn test_circuit_violation_propagates() {
        let mut inputs = valid_inputs();
        // Make the withdrawal exceed the note value — violates C1 (Underflow).
        inputs.withdraw_amount = inputs.note_value + 1;

        let result = generate_devnet_test_proof(&inputs);
        match result {
            Err(ProofError::CircuitViolation(msg)) => {
                assert!(
                    msg.contains("Underflow"),
                    "expected Underflow in message, got: {msg}"
                );
            }
            other => panic!("expected CircuitViolation, got: {:?}", other),
        }
    }

    /// Test 4: identical inputs must always produce identical proof bytes.
    #[test]
    fn test_devnet_proof_deterministic() {
        let inputs = valid_inputs();
        let bundle1 = generate_devnet_test_proof(&inputs).unwrap();
        let bundle2 = generate_devnet_test_proof(&inputs).unwrap();

        assert_eq!(bundle1.proof.proof_a, bundle2.proof.proof_a);
        assert_eq!(bundle1.proof.proof_b, bundle2.proof.proof_b);
        assert_eq!(bundle1.proof.proof_c, bundle2.proof.proof_c);
    }

    /// Test 5: amount_to_field_element encodes u64 as little-endian in bytes 0..8.
    #[test]
    fn test_amount_field_element_roundtrip() {
        let amount: u64 = 42;
        let fe = amount_to_field_element(amount);

        let mut recovered = [0u8; 8];
        recovered.copy_from_slice(&fe[0..8]);
        assert_eq!(recovered, amount.to_le_bytes());

        // Confirm the rest is zero-padded
        assert_eq!(&fe[8..], &[0u8; 24]);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_circuit_version_is_one() {
        let inputs = valid_inputs();
        let bundle = generate_devnet_test_proof(&inputs).unwrap();
        assert_eq!(bundle.circuit_version, 1);
    }

    #[test]
    fn test_parsed_bundle_mainnet_ready_false() {
        let inputs = valid_inputs();
        let bundle = generate_devnet_test_proof(&inputs).unwrap();
        let wire = build_withdraw_tx_data(&bundle);
        let parsed = parse_withdraw_tx_data(&wire).unwrap();
        assert!(!parsed.mainnet_ready);
    }

    #[test]
    fn test_parsed_bundle_circuit_version_one() {
        let inputs = valid_inputs();
        let bundle = generate_devnet_test_proof(&inputs).unwrap();
        let wire = build_withdraw_tx_data(&bundle);
        let parsed = parse_withdraw_tx_data(&wire).unwrap();
        assert_eq!(parsed.circuit_version, 1);
    }

    #[test]
    fn test_serialize_proof_size() {
        let inputs = valid_inputs();
        let bundle = generate_devnet_test_proof(&inputs).unwrap();
        let serialized = serialize_proof(&bundle.proof);
        assert_eq!(serialized.len(), 256);
    }

    #[test]
    fn test_tx_data_size() {
        let inputs = valid_inputs();
        let bundle = generate_devnet_test_proof(&inputs).unwrap();
        let wire = build_withdraw_tx_data(&bundle);
        assert_eq!(wire.len(), 352);
    }

    #[test]
    fn test_proof_bytes_nonzero() {
        let inputs = valid_inputs();
        let bundle = generate_devnet_test_proof(&inputs).unwrap();
        assert_ne!(bundle.proof.proof_a, [0u8; 64]);
        assert_ne!(bundle.proof.proof_b, [0u8; 128]);
        assert_ne!(bundle.proof.proof_c, [0u8; 64]);
    }

    #[test]
    fn test_json_has_mainnet_ready_false() {
        let inputs = valid_inputs();
        let bundle = generate_devnet_test_proof(&inputs).unwrap();
        let json = proof_bundle_to_json(&bundle);
        assert_eq!(json["mainnet_ready"], false);
    }

    #[test]
    fn test_json_has_circuit_version_one() {
        let inputs = valid_inputs();
        let bundle = generate_devnet_test_proof(&inputs).unwrap();
        let json = proof_bundle_to_json(&bundle);
        assert_eq!(json["circuit_version"], 1);
    }

    #[test]
    fn test_different_amounts_different_proofs() {
        let inputs1 = valid_inputs();
        let mut inputs2 = valid_inputs();
        inputs2.withdraw_amount = 1_000_000; // different amount, still ≤ note_value

        let bundle1 = generate_devnet_test_proof(&inputs1).unwrap();
        let bundle2 = generate_devnet_test_proof(&inputs2).unwrap();

        assert_ne!(bundle1.proof.proof_a, bundle2.proof.proof_a);
    }

    #[test]
    fn test_amount_zero_field_element() {
        let fe = amount_to_field_element(0);
        assert_eq!(fe, [0u8; 32]);
    }

    #[test]
    fn test_nullifier_mismatch_propagates_as_circuit_violation() {
        let mut inputs = valid_inputs();
        inputs.nullifier[0] ^= 0xFF; // tamper public nullifier
        let result = generate_devnet_test_proof(&inputs);
        assert!(
            matches!(result, Err(ProofError::CircuitViolation(_))),
            "expected CircuitViolation, got {:?}",
            result
        );
    }
}
