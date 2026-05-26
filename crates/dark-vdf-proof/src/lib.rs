use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VdfChallenge {
    pub challenge_hash: [u8; 32],
    pub difficulty: u32,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VdfOutput {
    pub output_hash: [u8; 32],
    pub proof_hash: [u8; 32],
    pub iterations: u32,
    pub verified: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VdfError {
    ZeroChallenge,
    DifficultyZero,
    VerificationFailed,
}

// ── Internal helpers ──────────────────────────────────────────────────────────

fn hash_challenge(input_bytes: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"vdf-challenge-v1");
    h.update(input_bytes);
    h.finalize().into()
}

fn hash_iter(state: &[u8; 32], i: u32) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"vdf-iter-v1");
    h.update(state);
    h.update(i.to_le_bytes());
    h.finalize().into()
}

fn hash_proof(challenge_hash: &[u8; 32], output_hash: &[u8; 32], difficulty: u32) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"vdf-proof-v1");
    h.update(challenge_hash);
    h.update(output_hash);
    h.update(difficulty.to_le_bytes());
    h.finalize().into()
}

fn run_vdf_iterations(start: &[u8; 32], difficulty: u32) -> [u8; 32] {
    let mut state = *start;
    for i in 0..difficulty {
        state = hash_iter(&state, i);
    }
    state
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Create a VDF challenge from raw input bytes.
///
/// Returns `Err(VdfError::ZeroChallenge)` if `input_bytes` is empty.
/// Returns `Err(VdfError::DifficultyZero)` if `difficulty` is 0.
pub fn create_challenge(input_bytes: &[u8], difficulty: u32) -> Result<VdfChallenge, VdfError> {
    if input_bytes.is_empty() {
        return Err(VdfError::ZeroChallenge);
    }
    if difficulty == 0 {
        return Err(VdfError::DifficultyZero);
    }
    Ok(VdfChallenge {
        challenge_hash: hash_challenge(input_bytes),
        difficulty,
        mainnet_ready: false,
    })
}

/// Run the VDF computation for the given challenge and return a `VdfOutput`.
///
/// `mainnet_ready` is always `false`.
pub fn compute_vdf(challenge: &VdfChallenge) -> VdfOutput {
    let output_hash = run_vdf_iterations(&challenge.challenge_hash, challenge.difficulty);
    let proof_hash = hash_proof(&challenge.challenge_hash, &output_hash, challenge.difficulty);
    VdfOutput {
        output_hash,
        proof_hash,
        iterations: challenge.difficulty,
        verified: true,
        mainnet_ready: false,
    }
}

/// Verify a `VdfOutput` against its `VdfChallenge`.
///
/// Recomputes `output_hash` and `proof_hash`; returns `true` only when both match.
pub fn verify_vdf(challenge: &VdfChallenge, output: &VdfOutput) -> bool {
    let expected_output = run_vdf_iterations(&challenge.challenge_hash, challenge.difficulty);
    if expected_output != output.output_hash {
        return false;
    }
    let expected_proof = hash_proof(&challenge.challenge_hash, &expected_output, challenge.difficulty);
    expected_proof == output.proof_hash
}

/// Serialize a `VdfOutput` to a JSON string suitable for public records.
///
/// Fields: `output_hash` (hex), `proof_hash` (hex), `iterations`, `verified`, `mainnet_ready`.
pub fn vdf_public_record(output: &VdfOutput) -> String {
    let record = serde_json::json!({
        "output_hash": hex_encode(&output.output_hash),
        "proof_hash":  hex_encode(&output.proof_hash),
        "iterations":  output.iterations,
        "verified":    output.verified,
        "mainnet_ready": output.mainnet_ready,
    });
    record.to_string()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vdf_compute_verify_roundtrip() {
        let challenge = create_challenge(b"test-input", 3).expect("challenge creation failed");
        let output = compute_vdf(&challenge);
        assert!(verify_vdf(&challenge, &output), "verify_vdf should return true for a fresh output");
    }

    #[test]
    fn test_output_deterministic() {
        let c1 = create_challenge(b"same-input", 5).unwrap();
        let c2 = create_challenge(b"same-input", 5).unwrap();
        let o1 = compute_vdf(&c1);
        let o2 = compute_vdf(&c2);
        assert_eq!(o1.output_hash, o2.output_hash, "same challenge must produce the same output_hash");
    }

    #[test]
    fn test_higher_difficulty_different_hash() {
        let c2 = create_challenge(b"input-abc", 2).unwrap();
        let c3 = create_challenge(b"input-abc", 3).unwrap();
        let o2 = compute_vdf(&c2);
        let o3 = compute_vdf(&c3);
        assert_ne!(
            o2.output_hash, o3.output_hash,
            "difficulty=2 and difficulty=3 must yield different output hashes"
        );
    }

    #[test]
    fn test_zero_challenge_rejected() {
        let result = create_challenge(b"", 4);
        assert_eq!(result, Err(VdfError::ZeroChallenge));
    }

    #[test]
    fn test_difficulty_zero_rejected() {
        let result = create_challenge(b"valid-input", 0);
        assert_eq!(result, Err(VdfError::DifficultyZero));
    }

    #[test]
    fn test_public_record_hides_nothing_sensitive() {
        let challenge = create_challenge(b"public-record-test", 2).unwrap();
        let output = compute_vdf(&challenge);
        let record = vdf_public_record(&output);
        let parsed: serde_json::Value = serde_json::from_str(&record).expect("must be valid JSON");

        // Required fields present
        assert!(parsed.get("output_hash").is_some(), "output_hash must be present");
        assert!(parsed.get("proof_hash").is_some(), "proof_hash must be present");
        assert!(parsed.get("iterations").is_some(), "iterations must be present");
        assert!(parsed.get("verified").is_some(), "verified must be present");
        assert!(parsed.get("mainnet_ready").is_some(), "mainnet_ready must be present");

        // mainnet_ready must always be false
        assert_eq!(
            parsed["mainnet_ready"].as_bool().unwrap(),
            false,
            "mainnet_ready must be false"
        );

        // output_hash and proof_hash must be 64-char hex strings (32 bytes)
        let oh = parsed["output_hash"].as_str().unwrap();
        let ph = parsed["proof_hash"].as_str().unwrap();
        assert_eq!(oh.len(), 64, "output_hash hex must be 64 chars");
        assert_eq!(ph.len(), 64, "proof_hash hex must be 64 chars");
    }
}
