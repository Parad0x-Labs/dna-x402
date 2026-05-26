use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};

// ── Constants ──────────────────────────────────────────────────────────────

pub const MAX_BIT_WIDTH: u8 = 64;

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RangeStatement {
    pub min: u64,
    pub max: u64,
    pub bit_width: u8,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RangeProofV2 {
    pub proof_id: [u8; 32],
    pub commitment: [u8; 32],
    pub proof_hash: [u8; 32],
    pub in_range: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum RangeError {
    InvalidRange,
    BitWidthZero,
    BitWidthTooLarge,
    ValueOutOfRange { value: u64, min: u64, max: u64 },
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn xor_fold(bufs: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = [0u8; 32];
    for b in bufs {
        for i in 0..32 {
            acc[i] ^= b[i];
        }
    }
    acc
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn create_statement(min: u64, max: u64, bit_width: u8) -> Result<RangeStatement, RangeError> {
    if min >= max {
        return Err(RangeError::InvalidRange);
    }
    if bit_width == 0 {
        return Err(RangeError::BitWidthZero);
    }
    if bit_width > MAX_BIT_WIDTH {
        return Err(RangeError::BitWidthTooLarge);
    }
    Ok(RangeStatement { min, max, bit_width, mainnet_ready: false })
}

pub fn prove_range(
    stmt: &RangeStatement,
    value: u64,
    blinding: &[u8; 32],
) -> Result<RangeProofV2, RangeError> {
    if value < stmt.min || value > stmt.max {
        return Err(RangeError::ValueOutOfRange { value, min: stmt.min, max: stmt.max });
    }

    let value_le = value.to_le_bytes();
    let commitment = sha256_multi(&[b"rangev2-commit-v1", &value_le, blinding]);

    // Bit commitments for bit_width bits
    let bit_commits: Vec<[u8; 32]> = (0..stmt.bit_width)
        .map(|i| {
            let bit_val = ((value >> i) & 1) as u8;
            let bit_blind = sha256_multi(&[b"rangev2-bit-blind-v1", blinding, &[i]]);
            sha256_multi(&[b"rangev2-bit-v1", &[i], &[bit_val], &bit_blind])
        })
        .collect();

    let xor_bits = xor_fold(&bit_commits);
    let proof_hash = sha256_multi(&[b"rangev2-proof-v1", &commitment, &xor_bits, &[stmt.bit_width]]);
    let proof_id = sha256_multi(&[b"rangev2-id-v1", &proof_hash]);

    Ok(RangeProofV2 {
        proof_id,
        commitment,
        proof_hash,
        in_range: true,
        mainnet_ready: false,
    })
}

pub fn verify_range_v2(
    stmt: &RangeStatement,
    proof: &RangeProofV2,
    value: u64,
    blinding: &[u8; 32],
) -> bool {
    if !proof.in_range {
        return false;
    }

    let value_le = value.to_le_bytes();
    let commitment = sha256_multi(&[b"rangev2-commit-v1", &value_le, blinding]);

    if commitment != proof.commitment {
        return false;
    }

    let bit_commits: Vec<[u8; 32]> = (0..stmt.bit_width)
        .map(|i| {
            let bit_val = ((value >> i) & 1) as u8;
            let bit_blind = sha256_multi(&[b"rangev2-bit-blind-v1", blinding, &[i]]);
            sha256_multi(&[b"rangev2-bit-v1", &[i], &[bit_val], &bit_blind])
        })
        .collect();

    let xor_bits = xor_fold(&bit_commits);
    let expected_proof_hash = sha256_multi(&[b"rangev2-proof-v1", &commitment, &xor_bits, &[stmt.bit_width]]);

    expected_proof_hash == proof.proof_hash
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn blinding(b: u8) -> [u8; 32] {
        let mut bl = [0u8; 32];
        bl[0] = b;
        bl
    }

    #[test]
    fn test_prove_verify_in_range() {
        let stmt = create_statement(0, 100, 8).unwrap();
        assert!(!stmt.mainnet_ready);
        let bl = blinding(0x11);
        let proof = prove_range(&stmt, 42, &bl).unwrap();
        assert!(proof.in_range);
        assert!(!proof.mainnet_ready);
        assert!(verify_range_v2(&stmt, &proof, 42, &bl));
    }

    #[test]
    fn test_value_out_of_range_rejected() {
        let stmt = create_statement(10, 20, 8).unwrap();
        let bl = blinding(0x22);
        let err = prove_range(&stmt, 5, &bl).unwrap_err();
        assert_eq!(err, RangeError::ValueOutOfRange { value: 5, min: 10, max: 20 });

        let err2 = prove_range(&stmt, 21, &bl).unwrap_err();
        assert_eq!(err2, RangeError::ValueOutOfRange { value: 21, min: 10, max: 20 });
    }

    #[test]
    fn test_bit_width_zero_rejected() {
        let err = create_statement(0, 100, 0).unwrap_err();
        assert_eq!(err, RangeError::BitWidthZero);
    }

    #[test]
    fn test_invalid_range_min_gte_max_rejected() {
        let err = create_statement(50, 50, 8).unwrap_err();
        assert_eq!(err, RangeError::InvalidRange);

        let err2 = create_statement(100, 50, 8).unwrap_err();
        assert_eq!(err2, RangeError::InvalidRange);
    }

    #[test]
    fn test_different_values_different_proofs() {
        let stmt = create_statement(0, 1000, 16).unwrap();
        let bl = blinding(0x33);
        let p1 = prove_range(&stmt, 100, &bl).unwrap();
        let p2 = prove_range(&stmt, 200, &bl).unwrap();
        assert_ne!(p1.proof_hash, p2.proof_hash);
        assert_ne!(p1.proof_id, p2.proof_id);
        assert_ne!(p1.commitment, p2.commitment);
    }

    #[test]
    fn test_bit_width_affects_proof() {
        let bl = blinding(0x44);
        let stmt8 = create_statement(0, 255, 8).unwrap();
        let stmt16 = create_statement(0, 255, 16).unwrap();
        let p8 = prove_range(&stmt8, 42, &bl).unwrap();
        let p16 = prove_range(&stmt16, 42, &bl).unwrap();
        // Same value but different bit_width → different proof_hash
        assert_ne!(p8.proof_hash, p16.proof_hash);
        // Both should verify with their own statements
        assert!(verify_range_v2(&stmt8, &p8, 42, &bl));
        assert!(verify_range_v2(&stmt16, &p16, 42, &bl));
    }
}
