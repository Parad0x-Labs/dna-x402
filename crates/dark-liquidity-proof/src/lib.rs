use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiquidityProof {
    pub pool_id: [u8; 32],
    pub reserve_commitment: [u8; 32],
    pub minimum_liquidity: u64,
    pub proof_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum LiquidityError {
    InsufficientLiquidity { actual: u64, required: u64 },
    BlindingZero,
    ZeroMinimum,
}

fn compute_reserve_commitment(actual_reserve: u64, blinding: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"reserve-v1");
    hasher.update(actual_reserve.to_le_bytes());
    hasher.update(blinding);
    hasher.finalize().into()
}

fn compute_proof_hash(
    pool_id: &[u8; 32],
    reserve_commitment: &[u8; 32],
    minimum_liquidity: u64,
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"liq-proof-v1");
    hasher.update(pool_id);
    hasher.update(reserve_commitment);
    hasher.update(minimum_liquidity.to_le_bytes());
    hasher.finalize().into()
}

pub fn prove_liquidity(
    pool_id: [u8; 32],
    actual_reserve: u64,
    blinding: &[u8; 32],
    minimum_liquidity: u64,
) -> Result<LiquidityProof, LiquidityError> {
    if blinding == &[0u8; 32] {
        return Err(LiquidityError::BlindingZero);
    }
    if minimum_liquidity == 0 {
        return Err(LiquidityError::ZeroMinimum);
    }
    if actual_reserve < minimum_liquidity {
        return Err(LiquidityError::InsufficientLiquidity {
            actual: actual_reserve,
            required: minimum_liquidity,
        });
    }

    let reserve_commitment = compute_reserve_commitment(actual_reserve, blinding);
    let proof_hash = compute_proof_hash(&pool_id, &reserve_commitment, minimum_liquidity);

    Ok(LiquidityProof {
        pool_id,
        reserve_commitment,
        minimum_liquidity,
        proof_hash,
        mainnet_ready: false,
    })
}

pub fn verify_liquidity(proof: &LiquidityProof, actual_reserve: u64, blinding: &[u8; 32]) -> bool {
    let recomputed = compute_reserve_commitment(actual_reserve, blinding);
    if recomputed != proof.reserve_commitment {
        return false;
    }
    actual_reserve >= proof.minimum_liquidity
}

pub fn proof_public_record(proof: &LiquidityProof) -> String {
    let pool_hex: String = proof.pool_id.iter().map(|b| format!("{:02x}", b)).collect();
    let rc_hex: String = proof
        .reserve_commitment
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    let ph_hex: String = proof
        .proof_hash
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    serde_json::json!({
        "pool_id": pool_hex,
        "reserve_commitment": rc_hex,
        "minimum_liquidity": proof.minimum_liquidity,
        "proof_hash": ph_hex,
        "mainnet_ready": proof.mainnet_ready,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool_id() -> [u8; 32] {
        let mut id = [0u8; 32];
        id[0] = 0x42;
        id
    }

    fn blinding() -> [u8; 32] {
        let mut b = [0u8; 32];
        b[0] = 0x11;
        b[1] = 0x22;
        b
    }

    #[test]
    fn test_sufficient_liquidity_proves_and_verifies() {
        let proof = prove_liquidity(pool_id(), 1_000_000, &blinding(), 500_000).unwrap();
        assert_eq!(proof.minimum_liquidity, 500_000);
        assert!(!proof.mainnet_ready);
        assert!(verify_liquidity(&proof, 1_000_000, &blinding()));
    }

    #[test]
    fn test_insufficient_liquidity_rejected() {
        let err = prove_liquidity(pool_id(), 100, &blinding(), 200).unwrap_err();
        assert_eq!(
            err,
            LiquidityError::InsufficientLiquidity {
                actual: 100,
                required: 200
            }
        );
    }

    #[test]
    fn test_wrong_blinding_fails_verify() {
        let proof = prove_liquidity(pool_id(), 1_000_000, &blinding(), 500_000).unwrap();
        let mut bad_blinding = blinding();
        bad_blinding[0] ^= 0xFF;
        assert!(!verify_liquidity(&proof, 1_000_000, &bad_blinding));
    }

    #[test]
    fn test_zero_minimum_rejected() {
        let err = prove_liquidity(pool_id(), 1_000_000, &blinding(), 0).unwrap_err();
        assert_eq!(err, LiquidityError::ZeroMinimum);
    }

    #[test]
    fn test_public_record_hides_actual_reserve() {
        let proof = prove_liquidity(pool_id(), 9_999_999, &blinding(), 1).unwrap();
        let json_str = proof_public_record(&proof);
        // actual_reserve must NOT appear in output
        assert!(!json_str.contains("9999999"));
        assert!(!json_str.contains("actual"));
        let v: serde_json::Value = serde_json::from_str(&json_str).unwrap();
        assert!(v["pool_id"].is_string());
        assert!(v["reserve_commitment"].is_string());
        assert!(v["proof_hash"].is_string());
        assert_eq!(v["mainnet_ready"], false);
        assert!(!v["mainnet_ready"].as_bool().unwrap());
    }

    #[test]
    fn test_proof_hash_deterministic() {
        let p1 = prove_liquidity(pool_id(), 1_000_000, &blinding(), 500_000).unwrap();
        let p2 = prove_liquidity(pool_id(), 1_000_000, &blinding(), 500_000).unwrap();
        assert_eq!(p1.proof_hash, p2.proof_hash);
        assert_eq!(p1.reserve_commitment, p2.reserve_commitment);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_pool_id_stored() {
        let id = pool_id();
        let p = prove_liquidity(id, 1_000_000, &blinding(), 500_000).unwrap();
        assert_eq!(p.pool_id, id);
    }

    #[test]
    fn test_reserve_commitment_nonzero() {
        let p = prove_liquidity(pool_id(), 1_000_000, &blinding(), 500_000).unwrap();
        assert_ne!(p.reserve_commitment, [0u8; 32]);
    }

    #[test]
    fn test_reserve_commitment_blinding_sensitive() {
        let mut b2 = blinding();
        b2[0] ^= 0xFF;
        let p1 = prove_liquidity(pool_id(), 1_000_000, &blinding(), 500_000).unwrap();
        let p2 = prove_liquidity(pool_id(), 1_000_000, &b2, 500_000).unwrap();
        assert_ne!(p1.reserve_commitment, p2.reserve_commitment);
    }

    #[test]
    fn test_proof_hash_nonzero() {
        let p = prove_liquidity(pool_id(), 1_000_000, &blinding(), 500_000).unwrap();
        assert_ne!(p.proof_hash, [0u8; 32]);
    }

    #[test]
    fn test_mainnet_ready_always_false() {
        let p = prove_liquidity(pool_id(), 1_000_000, &blinding(), 500_000).unwrap();
        assert!(!p.mainnet_ready);
    }

    #[test]
    fn test_blinding_zero_rejected() {
        let err = prove_liquidity(pool_id(), 1_000_000, &[0u8; 32], 500_000).unwrap_err();
        assert_eq!(err, LiquidityError::BlindingZero);
    }

    #[test]
    fn test_exact_minimum_liquidity_ok() {
        // actual_reserve == minimum_liquidity: check is `<`, so == is allowed
        let p = prove_liquidity(pool_id(), 500_000, &blinding(), 500_000);
        assert!(
            p.is_ok(),
            "actual_reserve == minimum_liquidity must succeed"
        );
    }

    #[test]
    fn test_verify_wrong_reserve_fails() {
        let proof = prove_liquidity(pool_id(), 1_000_000, &blinding(), 500_000).unwrap();
        assert!(!verify_liquidity(&proof, 999_999, &blinding()));
    }

    #[test]
    fn test_proof_hash_pool_sensitive() {
        let mut id2 = pool_id();
        id2[0] ^= 0xFF;
        let p1 = prove_liquidity(pool_id(), 1_000_000, &blinding(), 500_000).unwrap();
        let p2 = prove_liquidity(id2, 1_000_000, &blinding(), 500_000).unwrap();
        assert_ne!(p1.proof_hash, p2.proof_hash);
    }

    #[test]
    fn test_public_record_has_correct_keys() {
        let proof = prove_liquidity(pool_id(), 1_000_000, &blinding(), 500_000).unwrap();
        let record = proof_public_record(&proof);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["pool_id"].is_string());
        assert!(v["reserve_commitment"].is_string());
        assert!(v["proof_hash"].is_string());
        assert_eq!(v["mainnet_ready"], false);
        assert!(v.get("actual_reserve").is_none());
    }
}
