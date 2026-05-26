use sha2::{Digest, Sha256};

pub struct RangeProofV3 {
    pub proof_id: [u8; 32],
    pub value_commitment: [u8; 32],
    pub range_commitment: [u8; 32],
    pub in_range: bool,
    pub is_stub: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum RangeErrorV3 {
    ZeroBlinding,
    InvalidRange,
    ValueOutOfRange { value: u64, low: u64, high: u64 },
}

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

pub fn prove_range(
    value: u64,
    low: u64,
    high: u64,
    blinding: &[u8; 32],
) -> Result<RangeProofV3, RangeErrorV3> {
    if blinding == &[0u8; 32] {
        return Err(RangeErrorV3::ZeroBlinding);
    }
    if low > high {
        return Err(RangeErrorV3::InvalidRange);
    }
    if value < low || value > high {
        return Err(RangeErrorV3::ValueOutOfRange { value, low, high });
    }
    let value_le = value.to_le_bytes();
    let low_le = low.to_le_bytes();
    let high_le = high.to_le_bytes();
    let value_commitment = sha256_multi(&[b"rangev3-val-v1", &value_le, blinding]);
    let range_commitment = sha256_multi(&[b"rangev3-range-v1", &low_le, &high_le]);
    let in_range_byte = [1u8];
    let proof_id = sha256_multi(&[
        b"rangev3-proof-v1",
        &value_commitment,
        &range_commitment,
        &in_range_byte,
    ]);
    Ok(RangeProofV3 {
        proof_id,
        value_commitment,
        range_commitment,
        in_range: true,
        is_stub: true,
        mainnet_ready: false,
    })
}

pub fn verify_range(proof: &RangeProofV3) -> bool {
    proof.in_range
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blinding() -> [u8; 32] {
        [0xbbu8; 32]
    }

    #[test]
    fn prove_range_in_range_is_stub_mainnet_ready_false() {
        let proof = prove_range(50, 0, 100, &blinding()).unwrap();
        assert_eq!(proof.is_stub, true);
        assert_eq!(proof.mainnet_ready, false);
        assert!(proof.in_range);
        assert_ne!(proof.proof_id, [0u8; 32]);
    }

    #[test]
    fn verify_returns_true() {
        let proof = prove_range(42, 0, 100, &blinding()).unwrap();
        assert!(verify_range(&proof));
    }

    #[test]
    fn value_out_of_range_rejected_with_values() {
        let result = prove_range(200, 0, 100, &blinding());
        assert_eq!(
            result.err(),
            Some(RangeErrorV3::ValueOutOfRange {
                value: 200,
                low: 0,
                high: 100
            })
        );
    }

    #[test]
    fn zero_blinding_rejected() {
        let result = prove_range(50, 0, 100, &[0u8; 32]);
        assert_eq!(result.err(), Some(RangeErrorV3::ZeroBlinding));
    }

    #[test]
    fn invalid_range_rejected_low_greater_than_high() {
        let result = prove_range(50, 100, 0, &blinding());
        assert_eq!(result.err(), Some(RangeErrorV3::InvalidRange));
    }

    #[test]
    fn different_values_produce_different_value_commitments() {
        let p1 = prove_range(10, 0, 100, &blinding()).unwrap();
        let p2 = prove_range(20, 0, 100, &blinding()).unwrap();
        assert_ne!(p1.value_commitment, p2.value_commitment);
    }
}
