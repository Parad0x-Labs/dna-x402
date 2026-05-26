use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BulletproofRange {
    pub proof_id: [u8; 32],
    pub commitment: [u8; 32],
    pub inner_product_hash: [u8; 32],
    pub a_hash: [u8; 32],
    pub b_hash: [u8; 32],
    pub proof_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum BpError {
    ZeroBlinding,
    ValueOutOfRange { value: u64, max: u64 },
    BitWidthZero,
}

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

fn sha256_2(a: &[u8], b: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(a);
    h.update(b);
    h.finalize().into()
}

fn sha256_3(a: &[u8], b: &[u8], c: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(a);
    h.update(b);
    h.update(c);
    h.finalize().into()
}

fn sha256_4(a: &[u8], b: &[u8], c: &[u8], d: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(a);
    h.update(b);
    h.update(c);
    h.update(d);
    h.finalize().into()
}

fn sha256_1(a: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(a);
    h.finalize().into()
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

/// commitment = SHA256("bp-commit-v1" || value_le || blinding)
fn compute_commitment(value: u64, blinding: &[u8; 32]) -> [u8; 32] {
    sha256_3(b"bp-commit-v1", &value.to_le_bytes(), blinding)
}

/// a_bytes = bit decomposition of value for n bits (LSB first)
/// a_hash = SHA256("bp-vec-a-v1" || SHA256(a_bytes))
fn compute_a_hash(value: u64, bit_width: u8) -> [u8; 32] {
    let n = bit_width as usize;
    let mut a_bytes = vec![0u8; n];
    for i in 0..n {
        a_bytes[i] = ((value >> i) & 1) as u8;
    }
    let inner = sha256_1(&a_bytes);
    sha256_2(b"bp-vec-a-v1", &inner)
}

/// b_bytes = complement bits (1 - bit_i)
/// b_hash = SHA256("bp-vec-b-v1" || SHA256(b_bytes))
fn compute_b_hash(value: u64, bit_width: u8) -> [u8; 32] {
    let n = bit_width as usize;
    let mut b_bytes = vec![0u8; n];
    for i in 0..n {
        b_bytes[i] = 1 - (((value >> i) & 1) as u8);
    }
    let inner = sha256_1(&b_bytes);
    sha256_2(b"bp-vec-b-v1", &inner)
}

/// inner_product_hash = SHA256("bp-inner-v1" || a_hash || b_hash)
fn compute_inner_product_hash(a_hash: &[u8; 32], b_hash: &[u8; 32]) -> [u8; 32] {
    sha256_3(b"bp-inner-v1", a_hash, b_hash)
}

/// proof_hash = SHA256("bp-proof-v1" || commitment || inner_product_hash || [bit_width])
fn compute_proof_hash(commitment: &[u8; 32], inner_product_hash: &[u8; 32], bit_width: u8) -> [u8; 32] {
    sha256_4(b"bp-proof-v1", commitment, inner_product_hash, &[bit_width])
}

/// proof_id = SHA256("bp-id-v1" || proof_hash)
fn compute_proof_id(proof_hash: &[u8; 32]) -> [u8; 32] {
    sha256_2(b"bp-id-v1", proof_hash)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Create a bulletproof-style range proof for value in [0, 2^bit_width).
///
/// Errors:
/// - ZeroBlinding: blinding is all zeros
/// - BitWidthZero: bit_width is 0
/// - ValueOutOfRange: value >= 2^bit_width
pub fn create_bp_range(
    value: u64,
    bit_width: u8,
    blinding: &[u8; 32],
) -> Result<BulletproofRange, BpError> {
    if *blinding == [0u8; 32] {
        return Err(BpError::ZeroBlinding);
    }
    if bit_width == 0 {
        return Err(BpError::BitWidthZero);
    }
    let max = if bit_width >= 64 { u64::MAX } else { (1u64 << bit_width) - 1 };
    if bit_width < 64 && value > max {
        return Err(BpError::ValueOutOfRange { value, max });
    }

    let commitment = compute_commitment(value, blinding);
    let a_hash = compute_a_hash(value, bit_width);
    let b_hash = compute_b_hash(value, bit_width);
    let inner_product_hash = compute_inner_product_hash(&a_hash, &b_hash);
    let proof_hash = compute_proof_hash(&commitment, &inner_product_hash, bit_width);
    let proof_id = compute_proof_id(&proof_hash);

    Ok(BulletproofRange {
        proof_id,
        commitment,
        inner_product_hash,
        a_hash,
        b_hash,
        proof_hash,
        mainnet_ready: false,
    })
}

/// Verify a bulletproof range proof by recomputing from value and blinding.
pub fn verify_bp(proof: &BulletproofRange, value: u64, blinding: &[u8; 32]) -> bool {
    let commitment = compute_commitment(value, blinding);
    if commitment != proof.commitment {
        return false;
    }

    // We need bit_width to recompute a/b hashes — derive from proof_hash
    // Strategy: try to recover bit_width by checking proof_hash for bw in 1..=64
    for bw in 1u8..=64u8 {
        let a_hash = compute_a_hash(value, bw);
        let b_hash = compute_b_hash(value, bw);
        let iph = compute_inner_product_hash(&a_hash, &b_hash);
        let ph = compute_proof_hash(&commitment, &iph, bw);
        if ph == proof.proof_hash {
            let pid = compute_proof_id(&ph);
            return pid == proof.proof_id
                && a_hash == proof.a_hash
                && b_hash == proof.b_hash
                && iph == proof.inner_product_hash;
        }
    }
    false
}

/// Public JSON record: exposes proof_id, commitment, inner_product_hash, mainnet_ready.
/// Does NOT expose the blinding factor or value directly.
pub fn bp_public_record(proof: &BulletproofRange) -> String {
    let proof_id_hex: String = proof.proof_id.iter().map(|b| format!("{:02x}", b)).collect();
    let commitment_hex: String = proof.commitment.iter().map(|b| format!("{:02x}", b)).collect();
    let iph_hex: String = proof.inner_product_hash.iter().map(|b| format!("{:02x}", b)).collect();
    serde_json::json!({
        "proof_id": proof_id_hex,
        "commitment": commitment_hex,
        "inner_product_hash": iph_hex,
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
        let mut b = [0u8; 32];
        b[0] = 0xBB;
        b[1] = 0xCC;
        b
    }

    #[test]
    fn test_create_and_verify() {
        let proof = create_bp_range(42, 8, &blinding()).unwrap();
        assert!(!proof.mainnet_ready);
        assert_eq!(proof.proof_id.len(), 32);
        assert!(verify_bp(&proof, 42, &blinding()));
    }

    #[test]
    fn test_value_out_of_range_rejected() {
        // value=256 is out of range for bit_width=8 (max=255)
        let err = create_bp_range(256, 8, &blinding()).unwrap_err();
        assert_eq!(err, BpError::ValueOutOfRange { value: 256, max: 255 });
    }

    #[test]
    fn test_zero_blinding_rejected() {
        let err = create_bp_range(42, 8, &[0u8; 32]).unwrap_err();
        assert_eq!(err, BpError::ZeroBlinding);
    }

    #[test]
    fn test_bit_width_zero_rejected() {
        let err = create_bp_range(0, 0, &blinding()).unwrap_err();
        assert_eq!(err, BpError::BitWidthZero);
    }

    #[test]
    fn test_different_values_produce_different_proofs() {
        let p1 = create_bp_range(10, 8, &blinding()).unwrap();
        let p2 = create_bp_range(11, 8, &blinding()).unwrap();
        assert_ne!(p1.proof_id, p2.proof_id);
        assert_ne!(p1.commitment, p2.commitment);
    }

    #[test]
    fn test_inner_product_hash_correct() {
        let value: u64 = 5;
        let bw: u8 = 4;
        let proof = create_bp_range(value, bw, &blinding()).unwrap();

        // Manually recompute inner_product_hash
        let a_hash = compute_a_hash(value, bw);
        let b_hash = compute_b_hash(value, bw);
        let expected_iph = compute_inner_product_hash(&a_hash, &b_hash);

        assert_eq!(proof.inner_product_hash, expected_iph);
        assert_eq!(proof.a_hash, a_hash);
        assert_eq!(proof.b_hash, b_hash);
    }
}
