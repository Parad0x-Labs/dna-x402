use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReputationScore {
    pub score_id: [u8; 32],
    pub subject_hash: [u8; 32],
    pub score_commitment: [u8; 32],
    pub threshold_hash: [u8; 32],
    pub passes_threshold: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScoreProof {
    pub proof_id: [u8; 32],
    pub score_id: [u8; 32],
    pub attestation_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ScoreError {
    ZeroSubjectSecret,
    ZeroAttesterSecret,
    ScoreBelowThreshold { score: u32, threshold: u32 },
}

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts { h.update(p); }
    h.finalize().into()
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

fn compute_subject_hash(subject_secret: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"rep-subject-v1", subject_secret])
}

fn compute_attester_hash(attester_secret: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"rep-attester-v1", attester_secret])
}

fn compute_score_commitment(score: u32, blinding: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"rep-score-v1", &score.to_le_bytes(), blinding])
}

fn compute_threshold_hash(threshold: u32) -> [u8; 32] {
    sha256_multi(&[b"rep-threshold-v1", &threshold.to_le_bytes()])
}

fn compute_score_id(
    subject_hash: &[u8; 32],
    score_commitment: &[u8; 32],
    threshold_hash: &[u8; 32],
) -> [u8; 32] {
    sha256_multi(&[b"rep-id-v1", subject_hash, score_commitment, threshold_hash])
}

fn compute_attestation_hash(
    score_id: &[u8; 32],
    attester_hash: &[u8; 32],
    passes: bool,
) -> [u8; 32] {
    sha256_multi(&[b"rep-attest-v1", score_id, attester_hash, &[passes as u8]])
}

fn compute_proof_id(attestation_hash: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"rep-proof-v1", attestation_hash])
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Compute a privacy-preserving reputation score with threshold check.
///
/// Errors: ZeroSubjectSecret
pub fn compute_score(
    subject_secret: &[u8; 32],
    score: u32,
    threshold: u32,
    blinding: &[u8; 32],
) -> Result<ReputationScore, ScoreError> {
    if *subject_secret == [0u8; 32] {
        return Err(ScoreError::ZeroSubjectSecret);
    }
    let subject_hash = compute_subject_hash(subject_secret);
    let score_commitment = compute_score_commitment(score, blinding);
    let threshold_hash = compute_threshold_hash(threshold);
    let score_id = compute_score_id(&subject_hash, &score_commitment, &threshold_hash);
    let passes_threshold = score >= threshold;
    Ok(ReputationScore {
        score_id,
        subject_hash,
        score_commitment,
        threshold_hash,
        passes_threshold,
        mainnet_ready: false,
    })
}

/// Attest to a reputation score. Fails if score does not pass threshold.
///
/// Errors: ZeroAttesterSecret, ScoreBelowThreshold
pub fn attest_score(
    score: &ReputationScore,
    attester_secret: &[u8; 32],
    // We need the original score+threshold to produce the error with values.
    // For the public API we infer from passes_threshold flag.
) -> Result<ScoreProof, ScoreError> {
    if *attester_secret == [0u8; 32] {
        return Err(ScoreError::ZeroAttesterSecret);
    }
    if !score.passes_threshold {
        // We expose 0 for score/threshold since they're hidden — caller checks passes_threshold
        return Err(ScoreError::ScoreBelowThreshold { score: 0, threshold: 0 });
    }
    let attester_hash = compute_attester_hash(attester_secret);
    let attestation_hash = compute_attestation_hash(&score.score_id, &attester_hash, score.passes_threshold);
    let proof_id = compute_proof_id(&attestation_hash);
    Ok(ScoreProof {
        proof_id,
        score_id: score.score_id,
        attestation_hash,
        mainnet_ready: false,
    })
}

/// Verify a score proof (trivial: proof_id must be non-zero).
pub fn verify_score_proof(_score: &ReputationScore, proof: &ScoreProof) -> bool {
    proof.proof_id != [0u8; 32]
}

/// Public JSON record: score_id, threshold_hash, passes_threshold, mainnet_ready.
/// Does NOT expose subject_hash or score value.
pub fn score_public_record(score: &ReputationScore) -> String {
    let score_id_hex: String = score.score_id.iter().map(|b| format!("{:02x}", b)).collect();
    let threshold_hex: String = score.threshold_hash.iter().map(|b| format!("{:02x}", b)).collect();
    serde_json::json!({
        "score_id": score_id_hex,
        "threshold_hash": threshold_hex,
        "passes_threshold": score.passes_threshold,
        "mainnet_ready": score.mainnet_ready,
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn subject_secret() -> [u8; 32] { let mut s = [0u8; 32]; s[0] = 0xF1; s }
    fn attester_secret() -> [u8; 32] { let mut s = [0u8; 32]; s[0] = 0xF2; s }
    fn blinding() -> [u8; 32] { let mut b = [0u8; 32]; b[0] = 0xB1; b }

    #[test]
    fn test_score_above_threshold_attest_succeeds() {
        let score = compute_score(&subject_secret(), 750, 700, &blinding()).unwrap();
        assert!(score.passes_threshold);
        assert!(!score.mainnet_ready);

        let proof = attest_score(&score, &attester_secret()).unwrap();
        assert!(!proof.mainnet_ready);
        assert!(verify_score_proof(&score, &proof));
    }

    #[test]
    fn test_below_threshold_rejected() {
        let score = compute_score(&subject_secret(), 500, 700, &blinding()).unwrap();
        assert!(!score.passes_threshold);

        let err = attest_score(&score, &attester_secret()).unwrap_err();
        assert!(matches!(err, ScoreError::ScoreBelowThreshold { .. }));
    }

    #[test]
    fn test_zero_subject_rejected() {
        let err = compute_score(&[0u8; 32], 800, 700, &blinding()).unwrap_err();
        assert_eq!(err, ScoreError::ZeroSubjectSecret);
    }

    #[test]
    fn test_zero_attester_rejected() {
        let score = compute_score(&subject_secret(), 800, 700, &blinding()).unwrap();
        let err = attest_score(&score, &[0u8; 32]).unwrap_err();
        assert_eq!(err, ScoreError::ZeroAttesterSecret);
    }

    #[test]
    fn test_score_id_deterministic() {
        let s1 = compute_score(&subject_secret(), 900, 800, &blinding()).unwrap();
        let s2 = compute_score(&subject_secret(), 900, 800, &blinding()).unwrap();
        assert_eq!(s1.score_id, s2.score_id);

        // Different score → different score_id
        let s3 = compute_score(&subject_secret(), 850, 800, &blinding()).unwrap();
        assert_ne!(s1.score_id, s3.score_id);
    }

    #[test]
    fn test_public_record_hides_subject_and_score() {
        let score = compute_score(&subject_secret(), 750, 700, &blinding()).unwrap();
        let record = score_public_record(&score);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();

        let subject_hex: String = score.subject_hash.iter().map(|b| format!("{:02x}", b)).collect();
        let score_commit_hex: String = score.score_commitment.iter().map(|b| format!("{:02x}", b)).collect();

        assert!(!record.contains(&subject_hex), "subject_hash must not appear");
        assert!(!record.contains(&score_commit_hex), "score_commitment must not appear");
        assert!(v.get("subject_hash").is_none());
        assert!(v.get("score_commitment").is_none());
        assert_eq!(v["mainnet_ready"], false);
        assert!(v["score_id"].is_string());
    }
}
