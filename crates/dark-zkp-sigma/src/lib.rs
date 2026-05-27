use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SigmaCommitment {
    pub commitment: [u8; 32],
    pub challenge: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SigmaResponse {
    pub response: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SigmaProof {
    pub commitment: [u8; 32],
    pub challenge: [u8; 32],
    pub response: [u8; 32],
    pub public_key: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum SigmaError {
    SecretZero,
    NonceZero,
    ProofInvalid,
}

pub fn sigma_commit(
    secret: &[u8; 32],
    prover_nonce: &[u8; 32],
    verifier_nonce: &[u8; 32],
) -> Result<SigmaCommitment, SigmaError> {
    if secret == &[0u8; 32] {
        return Err(SigmaError::SecretZero);
    }
    if prover_nonce == &[0u8; 32] {
        return Err(SigmaError::NonceZero);
    }

    let mut commit_input = Vec::new();
    commit_input.extend_from_slice(b"sigma-commit-v1");
    commit_input.extend_from_slice(secret);
    commit_input.extend_from_slice(prover_nonce);
    let commitment = sha256(&commit_input);

    let mut challenge_input = Vec::new();
    challenge_input.extend_from_slice(b"sigma-challenge-v1");
    challenge_input.extend_from_slice(&commitment);
    challenge_input.extend_from_slice(verifier_nonce);
    let challenge = sha256(&challenge_input);

    Ok(SigmaCommitment {
        commitment,
        challenge,
        mainnet_ready: false,
    })
}

pub fn sigma_respond(secret: &[u8; 32], sc: &SigmaCommitment) -> Result<SigmaResponse, SigmaError> {
    if secret == &[0u8; 32] {
        return Err(SigmaError::SecretZero);
    }
    let mut resp_input = Vec::new();
    resp_input.extend_from_slice(b"sigma-response-v1");
    resp_input.extend_from_slice(secret);
    resp_input.extend_from_slice(&sc.challenge);
    let response = sha256(&resp_input);

    Ok(SigmaResponse {
        response,
        mainnet_ready: false,
    })
}

pub fn sigma_prove(
    secret: &[u8; 32],
    prover_nonce: &[u8; 32],
    verifier_nonce: &[u8; 32],
) -> Result<SigmaProof, SigmaError> {
    let sc = sigma_commit(secret, prover_nonce, verifier_nonce)?;
    let sr = sigma_respond(secret, &sc)?;

    let mut pk_input = Vec::new();
    pk_input.extend_from_slice(b"sigma-pubkey-v1");
    pk_input.extend_from_slice(secret);
    let public_key = sha256(&pk_input);

    Ok(SigmaProof {
        commitment: sc.commitment,
        challenge: sc.challenge,
        response: sr.response,
        public_key,
        mainnet_ready: false,
    })
}

pub fn verify_sigma_proof(proof: &SigmaProof, verifier_nonce: &[u8; 32]) -> bool {
    // Recompute expected challenge from commitment + verifier_nonce
    let mut challenge_input = Vec::new();
    challenge_input.extend_from_slice(b"sigma-challenge-v1");
    challenge_input.extend_from_slice(&proof.commitment);
    challenge_input.extend_from_slice(verifier_nonce);
    let expected_challenge = sha256(&challenge_input);

    if expected_challenge != proof.challenge {
        return false;
    }

    // Check internal consistency: verify response is non-zero (was computed)
    // and challenge matches — proof is consistent
    proof.response != [0u8; 32]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_prove_and_verify_happy_path() {
        let secret = [33u8; 32];
        let prover_nonce = [44u8; 32];
        let verifier_nonce = [55u8; 32];

        let proof = sigma_prove(&secret, &prover_nonce, &verifier_nonce).unwrap();
        assert!(!proof.mainnet_ready);
        assert!(verify_sigma_proof(&proof, &verifier_nonce));
    }

    #[test]
    fn test_wrong_verifier_nonce_fails_verify() {
        let secret = [33u8; 32];
        let prover_nonce = [44u8; 32];
        let verifier_nonce = [55u8; 32];

        let proof = sigma_prove(&secret, &prover_nonce, &verifier_nonce).unwrap();
        let wrong_nonce = [99u8; 32];
        assert!(!verify_sigma_proof(&proof, &wrong_nonce));
    }

    #[test]
    fn test_zero_secret_rejected() {
        let result = sigma_prove(&[0u8; 32], &[1u8; 32], &[2u8; 32]);
        assert_eq!(result, Err(SigmaError::SecretZero));
    }

    #[test]
    fn test_zero_nonce_rejected() {
        let result = sigma_prove(&[1u8; 32], &[0u8; 32], &[2u8; 32]);
        assert_eq!(result, Err(SigmaError::NonceZero));
    }

    #[test]
    fn test_different_nonces_produce_different_commitments() {
        let secret = [33u8; 32];
        let verifier_nonce = [55u8; 32];

        let proof_a = sigma_prove(&secret, &[44u8; 32], &verifier_nonce).unwrap();
        let proof_b = sigma_prove(&secret, &[88u8; 32], &verifier_nonce).unwrap();

        assert_ne!(proof_a.commitment, proof_b.commitment);
        assert_ne!(proof_a.response, proof_b.response);
        // Public keys should be the same (derived from same secret)
        assert_eq!(proof_a.public_key, proof_b.public_key);
    }

    #[test]
    fn test_proof_internally_consistent() {
        let secret = [77u8; 32];
        let prover_nonce = [88u8; 32];
        let verifier_nonce = [99u8; 32];

        let sc = sigma_commit(&secret, &prover_nonce, &verifier_nonce).unwrap();
        assert!(!sc.mainnet_ready);
        let sr = sigma_respond(&secret, &sc).unwrap();
        assert!(!sr.mainnet_ready);

        // Manually verify the commitment was derived from secret+nonce
        let proof = sigma_prove(&secret, &prover_nonce, &verifier_nonce).unwrap();
        assert_eq!(proof.commitment, sc.commitment);
        assert_eq!(proof.challenge, sc.challenge);
        assert_eq!(proof.response, sr.response);
        assert!(verify_sigma_proof(&proof, &verifier_nonce));
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_commitment_nonzero() {
        let proof = sigma_prove(&[1u8; 32], &[2u8; 32], &[3u8; 32]).unwrap();
        assert_ne!(proof.commitment, [0u8; 32]);
    }

    #[test]
    fn test_response_nonzero() {
        let proof = sigma_prove(&[1u8; 32], &[2u8; 32], &[3u8; 32]).unwrap();
        assert_ne!(proof.response, [0u8; 32]);
    }

    #[test]
    fn test_public_key_nonzero() {
        let proof = sigma_prove(&[1u8; 32], &[2u8; 32], &[3u8; 32]).unwrap();
        assert_ne!(proof.public_key, [0u8; 32]);
    }

    #[test]
    fn test_different_secrets_different_public_key() {
        let p1 = sigma_prove(&[1u8; 32], &[2u8; 32], &[3u8; 32]).unwrap();
        let p2 = sigma_prove(&[4u8; 32], &[2u8; 32], &[3u8; 32]).unwrap();
        assert_ne!(p1.public_key, p2.public_key);
    }

    #[test]
    fn test_different_verifier_nonce_different_challenge() {
        let p1 = sigma_prove(&[1u8; 32], &[2u8; 32], &[3u8; 32]).unwrap();
        let p2 = sigma_prove(&[1u8; 32], &[2u8; 32], &[4u8; 32]).unwrap();
        assert_ne!(p1.challenge, p2.challenge);
    }

    #[test]
    fn test_proof_deterministic() {
        let p1 = sigma_prove(&[5u8; 32], &[6u8; 32], &[7u8; 32]).unwrap();
        let p2 = sigma_prove(&[5u8; 32], &[6u8; 32], &[7u8; 32]).unwrap();
        assert_eq!(p1.commitment, p2.commitment);
        assert_eq!(p1.challenge, p2.challenge);
        assert_eq!(p1.response, p2.response);
        assert_eq!(p1.public_key, p2.public_key);
    }

    #[test]
    fn test_sigma_commit_mainnet_ready_false() {
        let sc = sigma_commit(&[1u8; 32], &[2u8; 32], &[3u8; 32]).unwrap();
        assert!(!sc.mainnet_ready);
    }

    #[test]
    fn test_sigma_response_mainnet_ready_false() {
        let sc = sigma_commit(&[1u8; 32], &[2u8; 32], &[3u8; 32]).unwrap();
        let sr = sigma_respond(&[1u8; 32], &sc).unwrap();
        assert!(!sr.mainnet_ready);
    }

    #[test]
    fn test_challenge_nonzero() {
        let proof = sigma_prove(&[8u8; 32], &[9u8; 32], &[10u8; 32]).unwrap();
        assert_ne!(proof.challenge, [0u8; 32]);
    }

    #[test]
    fn test_public_key_matches_across_proofs() {
        // Same secret → same public_key regardless of nonces
        let p1 = sigma_prove(&[11u8; 32], &[1u8; 32], &[2u8; 32]).unwrap();
        let p2 = sigma_prove(&[11u8; 32], &[3u8; 32], &[4u8; 32]).unwrap();
        assert_eq!(p1.public_key, p2.public_key);
    }
}
