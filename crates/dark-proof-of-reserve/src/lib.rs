use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReserveProof {
    pub proof_id: [u8; 32],
    pub reserve_commitment: [u8; 32],
    pub liability_commitment: [u8; 32],
    pub surplus_hash: [u8; 32],
    pub is_solvent: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum ReserveError {
    ZeroBlinding,
    ReservesInsufficient { reserves: u64, liabilities: u64 },
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn compute_reserve_commitment(reserves: u64, blinding: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"por-reserve-v1", &reserves.to_le_bytes(), blinding])
}

fn compute_liability_commitment(liabilities: u64, blinding: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"por-liab-v1", &liabilities.to_le_bytes(), blinding])
}

fn compute_surplus_hash(surplus: u64) -> [u8; 32] {
    sha256_multi(&[b"por-surplus-v1", &surplus.to_le_bytes()])
}

fn compute_proof_id(
    reserve_commitment: &[u8; 32],
    liability_commitment: &[u8; 32],
    surplus_hash: &[u8; 32],
) -> [u8; 32] {
    sha256_multi(&[
        b"por-proof-v1",
        reserve_commitment,
        liability_commitment,
        surplus_hash,
    ])
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn prove_reserve(
    reserves: u64,
    liabilities: u64,
    reserve_blinding: &[u8; 32],
    liability_blinding: &[u8; 32],
) -> Result<ReserveProof, ReserveError> {
    if reserve_blinding == &[0u8; 32] || liability_blinding == &[0u8; 32] {
        return Err(ReserveError::ZeroBlinding);
    }
    if reserves < liabilities {
        return Err(ReserveError::ReservesInsufficient {
            reserves,
            liabilities,
        });
    }
    let surplus = reserves - liabilities;
    let reserve_commitment = compute_reserve_commitment(reserves, reserve_blinding);
    let liability_commitment = compute_liability_commitment(liabilities, liability_blinding);
    let surplus_hash = compute_surplus_hash(surplus);
    let proof_id = compute_proof_id(&reserve_commitment, &liability_commitment, &surplus_hash);
    Ok(ReserveProof {
        proof_id,
        reserve_commitment,
        liability_commitment,
        surplus_hash,
        is_solvent: true,
        mainnet_ready: false,
    })
}

pub fn verify_reserve(proof: &ReserveProof) -> bool {
    proof.is_solvent
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_proof() -> ReserveProof {
        prove_reserve(1_000_000, 800_000, &[0x01u8; 32], &[0x02u8; 32]).unwrap()
    }

    fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        for p in parts {
            h.update(p);
        }
        h.finalize().into()
    }

    #[test]
    fn prove_reserve_solvent_and_mainnet_ready_false() {
        let proof = make_proof();
        assert!(proof.is_solvent);
        assert!(!proof.mainnet_ready);
        // Verify reserve_commitment formula
        let expected_rc = sha256_multi(&[
            b"por-reserve-v1",
            &1_000_000u64.to_le_bytes(),
            &[0x01u8; 32],
        ]);
        assert_eq!(proof.reserve_commitment, expected_rc);
    }

    #[test]
    fn verify_returns_true() {
        let proof = make_proof();
        assert!(verify_reserve(&proof));
    }

    #[test]
    fn reserves_less_than_liabilities_rejected() {
        let err = prove_reserve(500_000, 800_000, &[0x01u8; 32], &[0x02u8; 32]).unwrap_err();
        match err {
            ReserveError::ReservesInsufficient {
                reserves,
                liabilities,
            } => {
                assert_eq!(reserves, 500_000);
                assert_eq!(liabilities, 800_000);
            }
            _ => panic!("Expected ReservesInsufficient"),
        }
    }

    #[test]
    fn zero_blinding_rejected() {
        // Zero reserve blinding
        let err = prove_reserve(1_000, 500, &[0u8; 32], &[0x02u8; 32]).unwrap_err();
        assert_eq!(err, ReserveError::ZeroBlinding);
        // Zero liability blinding
        let err2 = prove_reserve(1_000, 500, &[0x01u8; 32], &[0u8; 32]).unwrap_err();
        assert_eq!(err2, ReserveError::ZeroBlinding);
    }

    #[test]
    fn surplus_hash_reflects_correct_surplus() {
        let proof = make_proof();
        let surplus = 1_000_000u64 - 800_000u64; // 200_000
        let expected = sha256_multi(&[b"por-surplus-v1", &surplus.to_le_bytes()]);
        assert_eq!(proof.surplus_hash, expected);
    }

    #[test]
    fn proof_id_is_deterministic() {
        let proof1 = make_proof();
        let proof2 = make_proof();
        assert_eq!(proof1.proof_id, proof2.proof_id);
        assert_ne!(proof1.proof_id, [0u8; 32]);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_proof_id_nonzero() {
        assert_ne!(make_proof().proof_id, [0u8; 32]);
    }

    #[test]
    fn test_reserve_commitment_nonzero() {
        assert_ne!(make_proof().reserve_commitment, [0u8; 32]);
    }

    #[test]
    fn test_liability_commitment_nonzero() {
        assert_ne!(make_proof().liability_commitment, [0u8; 32]);
    }

    #[test]
    fn test_surplus_hash_nonzero() {
        assert_ne!(make_proof().surplus_hash, [0u8; 32]);
    }

    #[test]
    fn test_is_solvent_true() {
        assert!(make_proof().is_solvent);
    }

    #[test]
    fn test_equal_reserves_liabilities_ok() {
        // reserves == liabilities → surplus = 0, still solvent
        let proof = prove_reserve(500_000, 500_000, &[0x01u8; 32], &[0x02u8; 32]).unwrap();
        assert!(proof.is_solvent);
        assert!(!proof.mainnet_ready);
    }

    #[test]
    fn test_proof_id_reserve_sensitive() {
        let p1 = prove_reserve(1_000_000, 800_000, &[0x01u8; 32], &[0x02u8; 32]).unwrap();
        let p2 = prove_reserve(1_200_000, 800_000, &[0x01u8; 32], &[0x02u8; 32]).unwrap();
        assert_ne!(p1.proof_id, p2.proof_id);
    }

    #[test]
    fn test_verify_reserve_false_when_is_solvent_false() {
        let mut proof = make_proof();
        proof.is_solvent = false;
        assert!(!verify_reserve(&proof));
    }

    #[test]
    fn test_liability_zero_ok() {
        let proof = prove_reserve(500_000, 0, &[0x01u8; 32], &[0x02u8; 32]).unwrap();
        assert!(proof.is_solvent);
    }

    #[test]
    fn test_proof_id_blinding_sensitive() {
        let p1 = prove_reserve(1_000_000, 800_000, &[0x01u8; 32], &[0x02u8; 32]).unwrap();
        let p2 = prove_reserve(1_000_000, 800_000, &[0x03u8; 32], &[0x04u8; 32]).unwrap();
        assert_ne!(p1.proof_id, p2.proof_id);
    }
}
