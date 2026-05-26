use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

pub const MAX_ROUNDS: u32 = 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VdfProof {
    pub proof_id: [u8; 32],
    pub input_hash: [u8; 32],
    pub output_hash: [u8; 32],
    pub delay_rounds: u32,
    pub verified: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum VdfError {
    ZeroInput,
    ZeroRounds,
    TooManyRounds,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256_bytes(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

pub fn compute_input_hash(input: &[u8]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"vdf2-input-v1");
    d.extend_from_slice(input);
    sha256_bytes(&d)
}

pub fn compute_output_hash(input_hash: &[u8; 32], delay_rounds: u32) -> [u8; 32] {
    let mut state = *input_hash;
    for i in 0u32..delay_rounds {
        let mut d = Vec::new();
        d.extend_from_slice(b"vdf2-iter-v1");
        d.extend_from_slice(&state);
        d.extend_from_slice(&i.to_le_bytes());
        state = sha256_bytes(&d);
    }
    state
}

pub fn compute_proof_id(
    input_hash: &[u8; 32],
    output_hash: &[u8; 32],
    delay_rounds: u32,
) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"vdf2-proof-v1");
    d.extend_from_slice(input_hash);
    d.extend_from_slice(output_hash);
    d.extend_from_slice(&delay_rounds.to_le_bytes());
    sha256_bytes(&d)
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn compute_vdf(input: &[u8], delay_rounds: u32) -> Result<VdfProof, VdfError> {
    if input.is_empty() {
        return Err(VdfError::ZeroInput);
    }
    if delay_rounds == 0 {
        return Err(VdfError::ZeroRounds);
    }
    if delay_rounds > MAX_ROUNDS {
        return Err(VdfError::TooManyRounds);
    }
    let input_hash = compute_input_hash(input);
    let output_hash = compute_output_hash(&input_hash, delay_rounds);
    let proof_id = compute_proof_id(&input_hash, &output_hash, delay_rounds);
    Ok(VdfProof {
        proof_id,
        input_hash,
        output_hash,
        delay_rounds,
        verified: false,
        mainnet_ready: false,
    })
}

pub fn verify_vdf(proof: &VdfProof, input: &[u8]) -> bool {
    let input_hash = compute_input_hash(input);
    if input_hash != proof.input_hash {
        return false;
    }
    let output_hash = compute_output_hash(&input_hash, proof.delay_rounds);
    if output_hash != proof.output_hash {
        return false;
    }
    let proof_id = compute_proof_id(&input_hash, &output_hash, proof.delay_rounds);
    proof_id == proof.proof_id
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // Test 1: compute_vdf with 5 rounds + mainnet_ready=false
    #[test]
    fn test_compute_vdf_5_rounds() {
        let proof = compute_vdf(b"seed-input", 5).unwrap();
        assert!(!proof.mainnet_ready);
        assert!(!proof.verified);
        assert_eq!(proof.delay_rounds, 5);
        assert_ne!(proof.input_hash, [0u8; 32]);
        assert_ne!(proof.output_hash, [0u8; 32]);
        assert_ne!(proof.proof_id, [0u8; 32]);

        let expected_input = compute_input_hash(b"seed-input");
        let expected_output = compute_output_hash(&expected_input, 5);
        let expected_pid = compute_proof_id(&expected_input, &expected_output, 5);
        assert_eq!(proof.input_hash, expected_input);
        assert_eq!(proof.output_hash, expected_output);
        assert_eq!(proof.proof_id, expected_pid);
    }

    // Test 2: verify returns true
    #[test]
    fn test_verify_returns_true() {
        let proof = compute_vdf(b"verify-me", 10).unwrap();
        assert!(verify_vdf(&proof, b"verify-me"));
    }

    // Test 3: different rounds → different output
    #[test]
    fn test_different_rounds_different_output() {
        let proof5 = compute_vdf(b"same-input", 5).unwrap();
        let proof10 = compute_vdf(b"same-input", 10).unwrap();
        assert_ne!(proof5.output_hash, proof10.output_hash);
        assert_ne!(proof5.proof_id, proof10.proof_id);
    }

    // Test 4: zero_rounds rejected
    #[test]
    fn test_zero_rounds_rejected() {
        let err = compute_vdf(b"input", 0).unwrap_err();
        assert_eq!(err, VdfError::ZeroRounds);
    }

    // Test 5: too_many_rounds rejected
    #[test]
    fn test_too_many_rounds_rejected() {
        let err = compute_vdf(b"input", MAX_ROUNDS + 1).unwrap_err();
        assert_eq!(err, VdfError::TooManyRounds);
    }

    // Test 6: proof_id is deterministic
    #[test]
    fn test_proof_id_deterministic() {
        let p1 = compute_vdf(b"deterministic", 7).unwrap();
        let p2 = compute_vdf(b"deterministic", 7).unwrap();
        assert_eq!(p1.proof_id, p2.proof_id);
        assert_eq!(p1.output_hash, p2.output_hash);
    }
}
