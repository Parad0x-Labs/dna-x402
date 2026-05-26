use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BulletproofStatement {
    pub commitment: [u8; 32],
    pub bit_width: u8,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BulletproofWitness {
    pub value: u64,
    pub blinding: [u8; 32],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BulletproofProof {
    pub statement: BulletproofStatement,
    pub inner_product_hash: [u8; 32],
    pub folded_proof: [u8; 32],
    pub verify_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum BulletproofError {
    ValueOutOfRange,
    BlindingZero,
    BitWidthInvalid,
}

fn sha256_hash(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

pub fn create_statement(
    value: u64,
    blinding: &[u8; 32],
    bit_width: u8,
) -> Result<BulletproofStatement, BulletproofError> {
    if *blinding == [0u8; 32] {
        return Err(BulletproofError::BlindingZero);
    }
    if bit_width == 0 || bit_width > 64 {
        return Err(BulletproofError::BitWidthInvalid);
    }
    // Check value fits in bit_width bits
    let max_value = if bit_width == 64 {
        u64::MAX
    } else {
        (1u64 << bit_width) - 1
    };
    if value > max_value {
        return Err(BulletproofError::ValueOutOfRange);
    }

    let mut input = b"bp-commit-v1".to_vec();
    input.extend_from_slice(&value.to_le_bytes());
    input.extend_from_slice(blinding);
    let commitment = sha256_hash(&input);

    Ok(BulletproofStatement {
        commitment,
        bit_width,
        mainnet_ready: false,
    })
}

pub fn prove(
    statement: &BulletproofStatement,
    witness: &BulletproofWitness,
) -> Result<BulletproofProof, BulletproofError> {
    if witness.blinding == [0u8; 32] {
        return Err(BulletproofError::BlindingZero);
    }

    // inner_product_hash = SHA256("bp-inner-v1" || commitment || value_le)
    let mut ip_input = b"bp-inner-v1".to_vec();
    ip_input.extend_from_slice(&statement.commitment);
    ip_input.extend_from_slice(&witness.value.to_le_bytes());
    let inner_product_hash = sha256_hash(&ip_input);

    // folded_proof = SHA256("bp-fold-v1" || inner_product_hash || blinding)
    let mut fold_input = b"bp-fold-v1".to_vec();
    fold_input.extend_from_slice(&inner_product_hash);
    fold_input.extend_from_slice(&witness.blinding);
    let folded_proof = sha256_hash(&fold_input);

    // verify_hash = SHA256("bp-verify-v1" || inner_product_hash || commitment)
    let mut verify_input = b"bp-verify-v1".to_vec();
    verify_input.extend_from_slice(&inner_product_hash);
    verify_input.extend_from_slice(&statement.commitment);
    let verify_hash = sha256_hash(&verify_input);

    Ok(BulletproofProof {
        statement: statement.clone(),
        inner_product_hash,
        folded_proof,
        verify_hash,
        mainnet_ready: false,
    })
}

pub fn verify(proof: &BulletproofProof) -> bool {
    // Recompute verify_hash = SHA256("bp-verify-v1" || inner_product_hash || commitment)
    let mut verify_input = b"bp-verify-v1".to_vec();
    verify_input.extend_from_slice(&proof.inner_product_hash);
    verify_input.extend_from_slice(&proof.statement.commitment);
    let expected = sha256_hash(&verify_input);
    expected == proof.verify_hash
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blinding(seed: u8) -> [u8; 32] {
        let mut b = [0u8; 32];
        b[0] = seed;
        b[31] = 0xff;
        b
    }

    #[test]
    fn test_8bit_range_proof() {
        let stmt = create_statement(200, &blinding(1), 8).unwrap();
        assert!(!stmt.mainnet_ready);
        let witness = BulletproofWitness { value: 200, blinding: blinding(1) };
        let proof = prove(&stmt, &witness).unwrap();
        assert!(!proof.mainnet_ready);
        assert!(verify(&proof));
    }

    #[test]
    fn test_16bit_range_proof() {
        let stmt = create_statement(60000, &blinding(2), 16).unwrap();
        let witness = BulletproofWitness { value: 60000, blinding: blinding(2) };
        let proof = prove(&stmt, &witness).unwrap();
        assert!(verify(&proof));
    }

    #[test]
    fn test_out_of_range_rejected() {
        // value 256 does not fit in 8 bits
        let err = create_statement(256, &blinding(3), 8).unwrap_err();
        assert_eq!(err, BulletproofError::ValueOutOfRange);
    }

    #[test]
    fn test_zero_blinding_rejected() {
        let err = create_statement(10, &[0u8; 32], 8).unwrap_err();
        assert_eq!(err, BulletproofError::BlindingZero);
    }

    #[test]
    fn test_verify_passes() {
        let stmt = create_statement(1023, &blinding(5), 10).unwrap();
        let witness = BulletproofWitness { value: 1023, blinding: blinding(5) };
        let proof = prove(&stmt, &witness).unwrap();
        assert!(verify(&proof));
        // Tampered proof should fail
        let mut bad_proof = proof.clone();
        bad_proof.inner_product_hash[0] ^= 0xff;
        assert!(!verify(&bad_proof));
    }

    #[test]
    fn test_invalid_bit_width_rejected() {
        let err = create_statement(0, &blinding(6), 0).unwrap_err();
        assert_eq!(err, BulletproofError::BitWidthInvalid);
        let err2 = create_statement(0, &blinding(6), 65).unwrap_err();
        assert_eq!(err2, BulletproofError::BitWidthInvalid);
    }
}
