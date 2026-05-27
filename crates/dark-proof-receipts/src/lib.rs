use dark_proof_core::{ProofClaim, ProofError, ProofSystem, ProofVerifier};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum StatementKind {
    ReceiptRedeem,
    SessionNetSettlement,
    ModelOutputBound,
    NullifierNotReused,
    ApiMeterBurn,
    PredictionCommitReveal,
}

impl StatementKind {
    pub fn domain_byte(&self) -> u8 {
        match self {
            Self::ReceiptRedeem => 0x10,
            Self::SessionNetSettlement => 0x11,
            Self::ModelOutputBound => 0x12,
            Self::NullifierNotReused => 0x13,
            Self::ApiMeterBurn => 0x14,
            Self::PredictionCommitReveal => 0x15,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProofReceipt {
    pub claim_hash: [u8; 32],
    pub verifier_backend: ProofSystem,
    pub verified_at_slot: u64,
    pub public_inputs_hash: [u8; 32],
    pub receipt_hash: [u8; 32],
    pub nullifier_hash: [u8; 32],
    pub statement_kind: StatementKind,
}

impl ProofReceipt {
    pub fn receipt_id(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(b"dark_null_v1_proof_receipt");
        h.update([self.statement_kind.domain_byte()]);
        h.update(self.claim_hash);
        h.update(self.receipt_hash);
        h.update(self.nullifier_hash);
        h.finalize().into()
    }

    pub fn bind_to_claim(&self, claim: &ProofClaim) -> bool {
        claim.claim_hash() == self.claim_hash
    }
}

/// Create a proof receipt after successful verification
pub fn mint_proof_receipt(
    verifier: &impl ProofVerifier,
    claim: &ProofClaim,
    proof: &[u8],
    public_inputs: &[u8],
    receipt_hash: [u8; 32],
    nullifier_hash: [u8; 32],
    statement_kind: StatementKind,
    current_slot: u64,
) -> Result<ProofReceipt, ProofError> {
    let result = verifier.verify(claim, proof, public_inputs)?;
    if !result.accepted {
        return Err(ProofError::InvalidProof(
            result.reason.unwrap_or_else(|| "proof not accepted".into()),
        ));
    }
    let mut pih = Sha256::new();
    pih.update(public_inputs);
    let public_inputs_hash: [u8; 32] = pih.finalize().into();
    Ok(ProofReceipt {
        claim_hash: result.claim_hash,
        verifier_backend: claim.system.clone(),
        verified_at_slot: current_slot,
        public_inputs_hash,
        receipt_hash,
        nullifier_hash,
        statement_kind,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use dark_proof_core::{build_mock_proof, MockProofVerifier, ProofSystem, RejectAllVerifier};

    fn make_claim() -> ProofClaim {
        ProofClaim {
            system: ProofSystem::Mock,
            circuit_id: [0xAAu8; 32],
            public_inputs_hash: [0xBBu8; 32],
            proof_bytes_hash: [0xCCu8; 32],
            verifier_key_hash: [0xDDu8; 32],
            domain: b"dark_receipts_test".to_vec(),
        }
    }

    fn make_receipt(statement_kind: StatementKind) -> ProofReceipt {
        ProofReceipt {
            claim_hash: [0x01u8; 32],
            verifier_backend: ProofSystem::Mock,
            verified_at_slot: 42,
            public_inputs_hash: [0x02u8; 32],
            receipt_hash: [0x03u8; 32],
            nullifier_hash: [0x04u8; 32],
            statement_kind,
        }
    }

    #[test]
    fn test_receipt_id_deterministic() {
        let r = make_receipt(StatementKind::ReceiptRedeem);
        assert_eq!(r.receipt_id(), r.receipt_id());
    }

    #[test]
    fn test_statement_kind_domain_separation() {
        let r1 = make_receipt(StatementKind::ReceiptRedeem);
        let r2 = make_receipt(StatementKind::SessionNetSettlement);
        assert_ne!(r1.receipt_id(), r2.receipt_id());
    }

    #[test]
    fn test_mint_receipt_with_mock_verifier() {
        let verifier = MockProofVerifier;
        let claim = make_claim();
        let public_inputs = b"test_public_inputs";
        let proof = build_mock_proof(&claim.circuit_id, public_inputs);
        let receipt = mint_proof_receipt(
            &verifier,
            &claim,
            &proof,
            public_inputs,
            [0x10u8; 32],
            [0x20u8; 32],
            StatementKind::ReceiptRedeem,
            999,
        )
        .unwrap();
        assert_eq!(receipt.verified_at_slot, 999);
        assert_eq!(receipt.verifier_backend, ProofSystem::Mock);
        assert_eq!(receipt.statement_kind, StatementKind::ReceiptRedeem);
    }

    #[test]
    fn test_mint_receipt_rejects_reject_all_verifier() {
        let verifier = RejectAllVerifier;
        let claim = make_claim();
        let err = mint_proof_receipt(
            &verifier,
            &claim,
            b"any_proof",
            b"any_inputs",
            [0u8; 32],
            [0u8; 32],
            StatementKind::ApiMeterBurn,
            1,
        )
        .unwrap_err();
        assert!(matches!(err, ProofError::InvalidProof(_)));
    }

    #[test]
    fn test_mint_receipt_rejects_tampered_proof() {
        let verifier = MockProofVerifier;
        let claim = make_claim();
        let public_inputs = b"legit_inputs";
        let mut proof = build_mock_proof(&claim.circuit_id, public_inputs);
        proof[0] ^= 0xFF;
        let err = mint_proof_receipt(
            &verifier,
            &claim,
            &proof,
            public_inputs,
            [0u8; 32],
            [0u8; 32],
            StatementKind::NullifierNotReused,
            1,
        )
        .unwrap_err();
        assert!(matches!(err, ProofError::InvalidProof(_)));
    }

    #[test]
    fn test_receipt_binds_to_claim() {
        let verifier = MockProofVerifier;
        let claim = make_claim();
        let public_inputs = b"bind_test_inputs";
        let proof = build_mock_proof(&claim.circuit_id, public_inputs);
        let receipt = mint_proof_receipt(
            &verifier,
            &claim,
            &proof,
            public_inputs,
            [0x30u8; 32],
            [0x40u8; 32],
            StatementKind::ModelOutputBound,
            100,
        )
        .unwrap();
        assert!(receipt.bind_to_claim(&claim));
    }

    #[test]
    fn test_receipt_does_not_bind_to_wrong_claim() {
        let verifier = MockProofVerifier;
        let claim = make_claim();
        let public_inputs = b"bind_test_inputs";
        let proof = build_mock_proof(&claim.circuit_id, public_inputs);
        let receipt = mint_proof_receipt(
            &verifier,
            &claim,
            &proof,
            public_inputs,
            [0x30u8; 32],
            [0x40u8; 32],
            StatementKind::ModelOutputBound,
            100,
        )
        .unwrap();
        // Modify circuit_id to make a different claim
        let mut wrong_claim = claim.clone();
        wrong_claim.circuit_id = [0xFFu8; 32];
        assert!(!receipt.bind_to_claim(&wrong_claim));
    }

    #[test]
    fn test_receipt_id_changes_on_nullifier_tamper() {
        let mut r1 = make_receipt(StatementKind::PredictionCommitReveal);
        let r2 = {
            let mut r = r1.clone();
            r.nullifier_hash = [0xFFu8; 32];
            r
        };
        r1.nullifier_hash = [0x00u8; 32];
        assert_ne!(r1.receipt_id(), r2.receipt_id());
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_receipt_id_nonzero() {
        let r = make_receipt(StatementKind::ReceiptRedeem);
        assert_ne!(r.receipt_id(), [0u8; 32]);
    }

    #[test]
    fn test_receipt_id_changes_on_receipt_hash_tamper() {
        let mut r1 = make_receipt(StatementKind::ApiMeterBurn);
        let mut r2 = r1.clone();
        r1.receipt_hash = [0xAAu8; 32];
        r2.receipt_hash = [0xBBu8; 32];
        assert_ne!(r1.receipt_id(), r2.receipt_id());
    }

    #[test]
    fn test_statement_kind_domain_bytes_unique() {
        let kinds = [
            StatementKind::ReceiptRedeem,
            StatementKind::SessionNetSettlement,
            StatementKind::ModelOutputBound,
            StatementKind::NullifierNotReused,
            StatementKind::ApiMeterBurn,
            StatementKind::PredictionCommitReveal,
        ];
        let bytes: Vec<u8> = kinds.iter().map(|k| k.domain_byte()).collect();
        let unique: std::collections::HashSet<u8> = bytes.iter().copied().collect();
        assert_eq!(bytes.len(), unique.len());
    }

    #[test]
    fn test_verified_at_slot_stored() {
        let verifier = MockProofVerifier;
        let claim = make_claim();
        let public_inputs = b"slot_test";
        let proof = build_mock_proof(&claim.circuit_id, public_inputs);
        let receipt = mint_proof_receipt(
            &verifier,
            &claim,
            &proof,
            public_inputs,
            [0xAAu8; 32],
            [0xBBu8; 32],
            StatementKind::ApiMeterBurn,
            12345,
        )
        .unwrap();
        assert_eq!(receipt.verified_at_slot, 12345);
    }

    #[test]
    fn test_mint_receipt_stores_receipt_hash() {
        let verifier = MockProofVerifier;
        let claim = make_claim();
        let public_inputs = b"rh_test";
        let proof = build_mock_proof(&claim.circuit_id, public_inputs);
        let rh = [0xEEu8; 32];
        let receipt = mint_proof_receipt(
            &verifier,
            &claim,
            &proof,
            public_inputs,
            rh,
            [0u8; 32],
            StatementKind::NullifierNotReused,
            1,
        )
        .unwrap();
        assert_eq!(receipt.receipt_hash, rh);
    }

    #[test]
    fn test_mint_receipt_stores_nullifier_hash() {
        let verifier = MockProofVerifier;
        let claim = make_claim();
        let public_inputs = b"nh_test";
        let proof = build_mock_proof(&claim.circuit_id, public_inputs);
        let nh = [0xFFu8; 32];
        let receipt = mint_proof_receipt(
            &verifier,
            &claim,
            &proof,
            public_inputs,
            [0u8; 32],
            nh,
            StatementKind::ReceiptRedeem,
            1,
        )
        .unwrap();
        assert_eq!(receipt.nullifier_hash, nh);
    }

    #[test]
    fn test_receipt_id_changes_on_claim_hash_tamper() {
        let mut r1 = make_receipt(StatementKind::SessionNetSettlement);
        let mut r2 = r1.clone();
        r1.claim_hash = [0x11u8; 32];
        r2.claim_hash = [0x22u8; 32];
        assert_ne!(r1.receipt_id(), r2.receipt_id());
    }

    #[test]
    fn test_mint_receipt_public_inputs_hash_set() {
        let verifier = MockProofVerifier;
        let claim = make_claim();
        let public_inputs = b"pih_check_inputs";
        let proof = build_mock_proof(&claim.circuit_id, public_inputs);
        let receipt = mint_proof_receipt(
            &verifier,
            &claim,
            &proof,
            public_inputs,
            [0u8; 32],
            [0u8; 32],
            StatementKind::ModelOutputBound,
            77,
        )
        .unwrap();
        // public_inputs_hash must be SHA256(public_inputs), non-zero
        assert_ne!(receipt.public_inputs_hash, [0u8; 32]);
    }
}
