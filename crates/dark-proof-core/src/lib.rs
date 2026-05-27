use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ProofSystem {
    Mock,
    Groth16Bn254,
    Risc0Receipt,
    BonsolExecution,
    ZkCompressionValidity,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProofClaim {
    pub system: ProofSystem,
    pub circuit_id: [u8; 32],
    pub public_inputs_hash: [u8; 32],
    pub proof_bytes_hash: [u8; 32],
    pub verifier_key_hash: [u8; 32],
    pub domain: Vec<u8>,
}

impl ProofClaim {
    pub fn claim_hash(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(b"dark_null_v1_claim");
        match self.system {
            ProofSystem::Mock => h.update([0u8]),
            ProofSystem::Groth16Bn254 => h.update([1u8]),
            ProofSystem::Risc0Receipt => h.update([2u8]),
            ProofSystem::BonsolExecution => h.update([3u8]),
            ProofSystem::ZkCompressionValidity => h.update([4u8]),
        }
        h.update(self.circuit_id);
        h.update(self.public_inputs_hash);
        h.update(self.proof_bytes_hash);
        h.update(self.verifier_key_hash);
        h.update(&self.domain);
        h.finalize().into()
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProofVerificationResult {
    pub accepted: bool,
    pub claim_hash: [u8; 32],
    pub backend: ProofSystem,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProofError {
    InvalidProof(String),
    BackendBlocked(String),
    Tampered,
    UnknownSystem,
}

pub trait ProofVerifier {
    fn verify(
        &self,
        claim: &ProofClaim,
        proof: &[u8],
        public_inputs: &[u8],
    ) -> Result<ProofVerificationResult, ProofError>;
}

/// MockProofVerifier: accepts only proof == SHA256("MOCK_VALID" || public_inputs || circuit_id)
pub struct MockProofVerifier;

impl ProofVerifier for MockProofVerifier {
    fn verify(
        &self,
        claim: &ProofClaim,
        proof: &[u8],
        public_inputs: &[u8],
    ) -> Result<ProofVerificationResult, ProofError> {
        let mut h = Sha256::new();
        h.update(b"MOCK_VALID");
        h.update(public_inputs);
        h.update(claim.circuit_id);
        let expected: [u8; 32] = h.finalize().into();
        if proof == expected.as_ref() {
            Ok(ProofVerificationResult {
                accepted: true,
                claim_hash: claim.claim_hash(),
                backend: ProofSystem::Mock,
                reason: None,
            })
        } else {
            Err(ProofError::InvalidProof(
                "mock proof bytes do not match MOCK_VALID formula".into(),
            ))
        }
    }
}

/// RejectAllVerifier: fail-closed default
pub struct RejectAllVerifier;

impl ProofVerifier for RejectAllVerifier {
    fn verify(
        &self,
        claim: &ProofClaim,
        _proof: &[u8],
        _public_inputs: &[u8],
    ) -> Result<ProofVerificationResult, ProofError> {
        Ok(ProofVerificationResult {
            accepted: false,
            claim_hash: claim.claim_hash(),
            backend: ProofSystem::Mock,
            reason: Some("RejectAllVerifier: fail-closed default — no backend wired".into()),
        })
    }
}

/// Groth16VerifierStub: typed interface, always Blocked
pub struct Groth16VerifierStub;
impl ProofVerifier for Groth16VerifierStub {
    fn verify(
        &self,
        _claim: &ProofClaim,
        _proof: &[u8],
        _public_inputs: &[u8],
    ) -> Result<ProofVerificationResult, ProofError> {
        Err(ProofError::BackendBlocked(
            "Groth16Bn254: backend not wired — requires groth16-solana crate and verification key"
                .into(),
        ))
    }
}

/// Risc0VerifierStub
pub struct Risc0VerifierStub;
impl ProofVerifier for Risc0VerifierStub {
    fn verify(
        &self,
        _claim: &ProofClaim,
        _proof: &[u8],
        _public_inputs: &[u8],
    ) -> Result<ProofVerificationResult, ProofError> {
        Err(ProofError::BackendBlocked(
            "Risc0Receipt: backend not wired — requires risc0-verifier and RISC Zero toolchain"
                .into(),
        ))
    }
}

/// BonsolVerifierStub
pub struct BonsolVerifierStub;
impl ProofVerifier for BonsolVerifierStub {
    fn verify(
        &self,
        _claim: &ProofClaim,
        _proof: &[u8],
        _public_inputs: &[u8],
    ) -> Result<ProofVerificationResult, ProofError> {
        Err(ProofError::BackendBlocked("BonsolExecution: backend not wired — requires Bonsol CLI and on-chain verifier program".into()))
    }
}

/// Helper: build the expected mock proof for a given circuit_id + public_inputs
pub fn build_mock_proof(circuit_id: &[u8; 32], public_inputs: &[u8]) -> Vec<u8> {
    let mut h = Sha256::new();
    h.update(b"MOCK_VALID");
    h.update(public_inputs);
    h.update(circuit_id);
    h.finalize().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_claim(system: ProofSystem) -> ProofClaim {
        ProofClaim {
            system,
            circuit_id: [1u8; 32],
            public_inputs_hash: [2u8; 32],
            proof_bytes_hash: [3u8; 32],
            verifier_key_hash: [4u8; 32],
            domain: b"test_domain".to_vec(),
        }
    }

    #[test]
    fn test_reject_all_returns_not_accepted() {
        let verifier = RejectAllVerifier;
        let claim = make_claim(ProofSystem::Mock);
        let result = verifier
            .verify(&claim, b"any_proof", b"any_inputs")
            .unwrap();
        assert!(!result.accepted);
        assert!(result.reason.is_some());
    }

    #[test]
    fn test_mock_accepts_valid_proof() {
        let verifier = MockProofVerifier;
        let claim = make_claim(ProofSystem::Mock);
        let proof = build_mock_proof(&claim.circuit_id, b"public_inputs");
        let result = verifier.verify(&claim, &proof, b"public_inputs").unwrap();
        assert!(result.accepted);
        assert!(result.reason.is_none());
    }

    #[test]
    fn test_mock_rejects_tampered_proof() {
        let verifier = MockProofVerifier;
        let claim = make_claim(ProofSystem::Mock);
        let mut proof = build_mock_proof(&claim.circuit_id, b"public_inputs");
        proof[0] ^= 0xFF; // tamper
        let err = verifier
            .verify(&claim, &proof, b"public_inputs")
            .unwrap_err();
        assert!(matches!(err, ProofError::InvalidProof(_)));
    }

    #[test]
    fn test_mock_rejects_empty_proof() {
        let verifier = MockProofVerifier;
        let claim = make_claim(ProofSystem::Mock);
        let err = verifier.verify(&claim, b"", b"public_inputs").unwrap_err();
        assert!(matches!(err, ProofError::InvalidProof(_)));
    }

    #[test]
    fn test_claim_hash_changes_on_public_input_tamper() {
        let claim_a = make_claim(ProofSystem::Mock);
        let mut claim_b = claim_a.clone();
        claim_b.public_inputs_hash = [0xABu8; 32];
        assert_ne!(claim_a.claim_hash(), claim_b.claim_hash());
    }

    #[test]
    fn test_claim_hash_domain_separation() {
        let claim_mock = make_claim(ProofSystem::Mock);
        let claim_groth = make_claim(ProofSystem::Groth16Bn254);
        assert_ne!(claim_mock.claim_hash(), claim_groth.claim_hash());
    }

    #[test]
    fn test_groth16_stub_returns_blocked() {
        let verifier = Groth16VerifierStub;
        let claim = make_claim(ProofSystem::Groth16Bn254);
        let err = verifier.verify(&claim, b"proof", b"inputs").unwrap_err();
        assert!(matches!(err, ProofError::BackendBlocked(_)));
    }

    #[test]
    fn test_risc0_stub_returns_blocked() {
        let verifier = Risc0VerifierStub;
        let claim = make_claim(ProofSystem::Risc0Receipt);
        let err = verifier.verify(&claim, b"proof", b"inputs").unwrap_err();
        assert!(matches!(err, ProofError::BackendBlocked(_)));
    }

    #[test]
    fn test_bonsol_stub_returns_blocked() {
        let verifier = BonsolVerifierStub;
        let claim = make_claim(ProofSystem::BonsolExecution);
        let err = verifier.verify(&claim, b"proof", b"inputs").unwrap_err();
        assert!(matches!(err, ProofError::BackendBlocked(_)));
    }

    #[test]
    fn test_build_mock_proof_matches_verifier() {
        let verifier = MockProofVerifier;
        let claim = make_claim(ProofSystem::Mock);
        let public_inputs = b"hello_dark_null";
        let proof = build_mock_proof(&claim.circuit_id, public_inputs);
        let result = verifier.verify(&claim, &proof, public_inputs).unwrap();
        assert!(result.accepted);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_claim_hash_nonzero() {
        let claim = make_claim(ProofSystem::Mock);
        assert_ne!(claim.claim_hash(), [0u8; 32]);
    }

    #[test]
    fn test_claim_hash_circuit_id_sensitive() {
        let mut claim_a = make_claim(ProofSystem::Mock);
        let mut claim_b = make_claim(ProofSystem::Mock);
        claim_a.circuit_id = [0x11u8; 32];
        claim_b.circuit_id = [0x22u8; 32];
        assert_ne!(claim_a.claim_hash(), claim_b.claim_hash());
    }

    #[test]
    fn test_build_mock_proof_nonempty() {
        let circuit_id = [0xABu8; 32];
        let proof = build_mock_proof(&circuit_id, b"inputs");
        assert!(!proof.is_empty());
        assert_eq!(proof.len(), 32);
    }

    #[test]
    fn test_reject_all_has_reason_string() {
        let verifier = RejectAllVerifier;
        let claim = make_claim(ProofSystem::Mock);
        let result = verifier.verify(&claim, b"x", b"y").unwrap();
        assert!(!result.accepted);
        let reason = result.reason.unwrap();
        assert!(!reason.is_empty());
    }

    #[test]
    fn test_proof_system_equality() {
        assert_eq!(ProofSystem::Mock, ProofSystem::Mock);
        assert_ne!(ProofSystem::Mock, ProofSystem::Groth16Bn254);
    }

    #[test]
    fn test_claim_hash_domain_changes() {
        let mut claim_a = make_claim(ProofSystem::Mock);
        let mut claim_b = make_claim(ProofSystem::Mock);
        claim_a.domain = b"domain_alpha".to_vec();
        claim_b.domain = b"domain_beta".to_vec();
        assert_ne!(claim_a.claim_hash(), claim_b.claim_hash());
    }
}
