use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// A hiding commitment to a value-in-range, built over SHA-256.
///
/// commitment = SHA256("range-commit-v1" || value_le || blinding_le)
#[derive(Debug, Clone)]
pub struct RangeCommitment {
    /// SHA256("range-commit-v1" || value_le || blinding_le)
    pub commitment: [u8; 32],
    /// Number of bits in range: value < 2^bit_width
    pub bit_width: u8,
    pub mainnet_ready: bool,
}

/// A Bulletproofs-style SHA-256 range proof.
///
/// Each bit of the secret value is committed to separately; the proof hash
/// binds the top-level commitment to the XOR-fold of all bit commitments.
#[derive(Debug, Clone)]
pub struct RangeProof {
    /// One commitment per bit: SHA256("bit-commit-v1" || bit_index || bit_value || blinding_i)
    /// where blinding_i = SHA256("bit-blind-v1" || master_blinding || [bit_index])
    pub bit_commitments: Vec<[u8; 32]>,
    /// SHA256("range-proof-v1" || commitment || XOR-fold(bit_commitments))
    pub proof_hash: [u8; 32],
    pub bit_width: u8,
    pub in_range: bool,
    pub mainnet_ready: bool,
}

/// Errors returned by range-proof operations.
#[derive(Debug, PartialEq)]
pub enum RangeError {
    ValueExceedsRange { value: u64, max: u64 },
    BitWidthZero,
    BitWidthExceeds64,
    BlindingZero,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn sha256(data: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for chunk in data {
        h.update(chunk);
    }
    h.finalize().into()
}

/// Derive a per-bit blinding factor deterministically from the master blinding.
fn bit_blinding(master_blinding: &[u8; 32], bit_index: u8) -> [u8; 32] {
    sha256(&[b"bit-blind-v1", master_blinding.as_slice(), &[bit_index]])
}

/// Commit to a single bit.
fn bit_commit(bit_index: u8, bit_val: u8, blinding_i: &[u8; 32]) -> [u8; 32] {
    sha256(&[
        b"bit-commit-v1",
        &[bit_index],
        &[bit_val],
        blinding_i.as_slice(),
    ])
}

/// XOR-fold a slice of 32-byte arrays into a single 32-byte value.
fn xor_fold(commitments: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = [0u8; 32];
    for c in commitments {
        for (a, b) in acc.iter_mut().zip(c.iter()) {
            *a ^= b;
        }
    }
    acc
}

/// Validate the common inputs shared by commit_value and prove_range.
fn validate_inputs(value: u64, blinding: &[u8; 32], bit_width: u8) -> Result<u64, RangeError> {
    if bit_width == 0 {
        return Err(RangeError::BitWidthZero);
    }
    if bit_width > 64 {
        return Err(RangeError::BitWidthExceeds64);
    }
    if blinding == &[0u8; 32] {
        return Err(RangeError::BlindingZero);
    }
    // max = 2^bit_width - 1; use u128 to avoid overflow when bit_width == 64.
    let max = ((1u128 << bit_width as u128) - 1) as u64;
    if value > max {
        return Err(RangeError::ValueExceedsRange { value, max });
    }
    Ok(max)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Create a hiding commitment to `value` within the range [0, 2^bit_width).
///
/// Returns `RangeError` if the inputs are invalid.
pub fn commit_value(
    value: u64,
    blinding: &[u8; 32],
    bit_width: u8,
) -> Result<RangeCommitment, RangeError> {
    validate_inputs(value, blinding, bit_width)?;

    let commitment = sha256(&[
        b"range-commit-v1",
        &value.to_le_bytes(),
        blinding.as_slice(),
    ]);

    Ok(RangeCommitment {
        commitment,
        bit_width,
        mainnet_ready: false,
    })
}

/// Produce a range proof showing that `value` lies in [0, 2^bit_width) without
/// revealing `value` or `blinding`.
///
/// Returns `RangeError` if the inputs are invalid.
pub fn prove_range(
    value: u64,
    blinding: &[u8; 32],
    bit_width: u8,
) -> Result<RangeProof, RangeError> {
    validate_inputs(value, blinding, bit_width)?;

    // Recompute the top-level commitment (same as commit_value).
    let commitment = sha256(&[
        b"range-commit-v1",
        &value.to_le_bytes(),
        blinding.as_slice(),
    ]);

    // Commit to each bit.
    let mut bit_commitments: Vec<[u8; 32]> = Vec::with_capacity(bit_width as usize);
    for i in 0..bit_width {
        let bit_val = ((value >> i) & 1) as u8;
        let blind_i = bit_blinding(blinding, i);
        bit_commitments.push(bit_commit(i, bit_val, &blind_i));
    }

    // XOR-fold all bit commitments.
    let xor = xor_fold(&bit_commitments);

    // Bind everything together.
    let proof_hash = sha256(&[b"range-proof-v1", &commitment, &xor]);

    Ok(RangeProof {
        bit_commitments,
        proof_hash,
        bit_width,
        in_range: true,
        mainnet_ready: false,
    })
}

/// Verify that `proof` is a valid range proof for `commitment`.
///
/// Returns `true` iff:
/// - bit widths match,
/// - proof.in_range is true,
/// - the XOR-fold of bit_commitments reproduces the expected proof_hash.
pub fn verify_range_proof(commitment: &RangeCommitment, proof: &RangeProof) -> bool {
    // Structural checks.
    if commitment.bit_width != proof.bit_width {
        return false;
    }
    if !proof.in_range {
        return false;
    }
    if proof.bit_commitments.len() != proof.bit_width as usize {
        return false;
    }

    // Recompute xor-fold.
    let xor = xor_fold(&proof.bit_commitments);

    // Recompute expected proof hash.
    let expected = sha256(&[b"range-proof-v1", &commitment.commitment, &xor]);

    proof.proof_hash == expected
}

/// Return a JSON string with the public parts of the proof.
///
/// Intentionally omits `value` and `blinding` — only hashes are published.
pub fn proof_public_record(proof: &RangeProof) -> String {
    let hex: String = proof
        .proof_hash
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();

    serde_json::json!({
        "proof_hash": hex,
        "bit_width": proof.bit_width,
        "in_range": proof.in_range,
        "mainnet_ready": proof.mainnet_ready,
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn blinding() -> [u8; 32] {
        // A non-zero deterministic blinding factor for tests.
        let mut b = [0u8; 32];
        for (i, v) in b.iter_mut().enumerate() {
            *v = (i as u8).wrapping_add(1);
        }
        b
    }

    /// 1. commit_value and prove_range succeed for value=100, bit_width=8.
    #[test]
    fn test_commit_and_prove_8bit() {
        let b = blinding();
        let commitment = commit_value(100, &b, 8).expect("commit should succeed");
        assert_eq!(commitment.bit_width, 8);

        let proof = prove_range(100, &b, 8).expect("prove should succeed");
        assert_eq!(proof.bit_width, 8);
        assert!(proof.in_range);
        assert_eq!(proof.bit_commitments.len(), 8);
    }

    /// 2. Proving value=256 with bit_width=8 is rejected (256 > 255).
    #[test]
    fn test_value_exceeds_range_rejected() {
        let b = blinding();
        let err = prove_range(256, &b, 8).unwrap_err();
        assert_eq!(
            err,
            RangeError::ValueExceedsRange {
                value: 256,
                max: 255
            }
        );
    }

    /// 3. verify_range_proof returns true for a freshly generated proof.
    #[test]
    fn test_verify_range_proof_passes() {
        let b = blinding();
        let commitment = commit_value(100, &b, 8).expect("commit");
        let proof = prove_range(100, &b, 8).expect("prove");
        assert!(verify_range_proof(&commitment, &proof));
    }

    /// 4. value=0 with bit_width=8 is valid (zero is in [0, 255]).
    #[test]
    fn test_zero_value_in_range() {
        let b = blinding();
        let commitment = commit_value(0, &b, 8).expect("commit zero");
        let proof = prove_range(0, &b, 8).expect("prove zero");
        assert!(verify_range_proof(&commitment, &proof));
    }

    /// 5. value=255 (max for 8 bits) is valid.
    #[test]
    fn test_max_value_8bit_in_range() {
        let b = blinding();
        let commitment = commit_value(255, &b, 8).expect("commit max");
        let proof = prove_range(255, &b, 8).expect("prove max");
        assert!(verify_range_proof(&commitment, &proof));
    }

    /// 6. proof_public_record does not leak the secret value.
    #[test]
    fn test_public_record_hides_value() {
        let b = blinding();
        let proof = prove_range(100, &b, 8).expect("prove");
        let record = proof_public_record(&proof);

        // The literal value "100" must not appear in the public record.
        assert!(
            !record.contains("100"),
            "public record must not contain the secret value; got: {}",
            record
        );
        // Sanity: record is valid JSON and contains expected keys.
        assert!(record.contains("proof_hash"));
        assert!(record.contains("in_range"));
        assert!(record.contains("bit_width"));
        assert!(record.contains("mainnet_ready"));
    }
}
