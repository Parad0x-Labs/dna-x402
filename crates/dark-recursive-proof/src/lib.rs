use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Constants ──────────────────────────────────────────────────────────────

pub const MAX_RECURSIVE_DEPTH: u8 = 8;

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecursiveProof {
    pub proof_id: [u8; 32],
    pub levels: Vec<[u8; 32]>,
    pub depth: u8,
    pub final_hash: [u8; 32],
    pub is_stub: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum RecursiveError {
    ZeroInput,
    DepthZero,
    MaxDepthExceeded,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

fn hex(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn compute_input_hash(input_bytes: &[u8]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"rec-input-v1");
    d.extend_from_slice(input_bytes);
    sha256(&d)
}

fn compute_level(i: u8, prev: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"rec-level-v1");
    d.push(i);
    d.extend_from_slice(prev);
    sha256(&d)
}

fn compute_final_hash(last_level: &[u8; 32], depth: u8) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"rec-final-v1");
    d.extend_from_slice(last_level);
    d.push(depth);
    sha256(&d)
}

fn compute_proof_id(final_hash: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"rec-proof-v1");
    d.extend_from_slice(final_hash);
    sha256(&d)
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn create_recursive_proof(
    input_bytes: &[u8],
    depth: u8,
) -> Result<RecursiveProof, RecursiveError> {
    if input_bytes.is_empty() {
        return Err(RecursiveError::ZeroInput);
    }
    if depth == 0 {
        return Err(RecursiveError::DepthZero);
    }
    if depth > MAX_RECURSIVE_DEPTH {
        return Err(RecursiveError::MaxDepthExceeded);
    }

    let input_hash = compute_input_hash(input_bytes);
    let mut levels = Vec::new();

    // level[0] = SHA256("rec-level-v1" || [0] || input_hash)
    let level0 = compute_level(0, &input_hash);
    levels.push(level0);

    // level[i] = SHA256("rec-level-v1" || [i] || level[i-1])
    for i in 1..depth {
        let prev = levels[(i - 1) as usize];
        let level = compute_level(i, &prev);
        levels.push(level);
    }

    let last_level = levels[(depth - 1) as usize];
    let final_hash = compute_final_hash(&last_level, depth);
    let proof_id = compute_proof_id(&final_hash);

    Ok(RecursiveProof {
        proof_id,
        levels,
        depth,
        final_hash,
        is_stub: true,
        mainnet_ready: false,
    })
}

pub fn verify_recursive(proof: &RecursiveProof, input_bytes: &[u8]) -> bool {
    if input_bytes.is_empty() || proof.depth == 0 {
        return false;
    }
    if proof.levels.len() != proof.depth as usize {
        return false;
    }

    let input_hash = compute_input_hash(input_bytes);
    let level0 = compute_level(0, &input_hash);
    if level0 != proof.levels[0] {
        return false;
    }

    for i in 1..proof.depth {
        let expected = compute_level(i, &proof.levels[(i - 1) as usize]);
        if expected != proof.levels[i as usize] {
            return false;
        }
    }

    let last_level = proof.levels[(proof.depth - 1) as usize];
    let final_hash = compute_final_hash(&last_level, proof.depth);
    if final_hash != proof.final_hash {
        return false;
    }

    let proof_id = compute_proof_id(&final_hash);
    proof_id == proof.proof_id
}

pub fn recursive_public_record(proof: &RecursiveProof) -> String {
    serde_json::json!({
        "proof_id":    hex(&proof.proof_id),
        "final_hash":  hex(&proof.final_hash),
        "depth":       proof.depth,
        "is_stub":     proof.is_stub,
        "mainnet_ready": proof.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // Test 1: create + verify depth=3
    #[test]
    fn test_create_and_verify_depth3() {
        let proof = create_recursive_proof(b"input-data", 3).unwrap();
        assert_eq!(proof.depth, 3);
        assert_eq!(proof.levels.len(), 3);
        assert!(proof.is_stub);
        assert!(!proof.mainnet_ready);
        assert!(verify_recursive(&proof, b"input-data"));
        // Wrong input fails verification
        assert!(!verify_recursive(&proof, b"wrong-input"));
    }

    // Test 2: proof is deterministic for same input+depth
    #[test]
    fn test_deterministic() {
        let p1 = create_recursive_proof(b"same-input", 4).unwrap();
        let p2 = create_recursive_proof(b"same-input", 4).unwrap();
        assert_eq!(p1.proof_id, p2.proof_id);
        assert_eq!(p1.final_hash, p2.final_hash);
    }

    // Test 3: different depth → different proof
    #[test]
    fn test_depth_sensitivity() {
        let p3 = create_recursive_proof(b"input", 3).unwrap();
        let p4 = create_recursive_proof(b"input", 4).unwrap();
        assert_ne!(p3.proof_id, p4.proof_id);
        assert_ne!(p3.final_hash, p4.final_hash);
    }

    // Test 4: different input → different proof
    #[test]
    fn test_input_sensitivity() {
        let pa = create_recursive_proof(b"input-A", 3).unwrap();
        let pb = create_recursive_proof(b"input-B", 3).unwrap();
        assert_ne!(pa.proof_id, pb.proof_id);
    }

    // Test 5: depth zero rejected
    #[test]
    fn test_depth_zero_rejected() {
        let err = create_recursive_proof(b"data", 0).unwrap_err();
        assert_eq!(err, RecursiveError::DepthZero);
    }

    // Test 6: max depth exceeded (depth=9)
    #[test]
    fn test_max_depth_exceeded() {
        let err = create_recursive_proof(b"data", 9).unwrap_err();
        assert_eq!(err, RecursiveError::MaxDepthExceeded);
        // depth=8 (MAX) is accepted
        let ok = create_recursive_proof(b"data", MAX_RECURSIVE_DEPTH);
        assert!(ok.is_ok());
    }

    // Extended tests -----------------------------------------------------------

    // Test 7: mainnet_ready always false
    #[test]
    fn test_mainnet_ready_false() {
        let p = create_recursive_proof(b"mainnet-check", 2).unwrap();
        assert!(!p.mainnet_ready);
    }

    // Test 8: zero input rejected
    #[test]
    fn test_zero_input_rejected() {
        let err = create_recursive_proof(b"", 3).unwrap_err();
        assert_eq!(err, RecursiveError::ZeroInput);
    }

    // Test 9: levels contain correct count
    #[test]
    fn test_levels_count_matches_depth() {
        for d in 1..=MAX_RECURSIVE_DEPTH {
            let p = create_recursive_proof(b"count-check", d).unwrap();
            assert_eq!(p.levels.len(), d as usize, "depth {} levels mismatch", d);
        }
    }

    // Test 10: each level is distinct (no collisions with correct hash chaining)
    #[test]
    fn test_levels_all_distinct() {
        let p = create_recursive_proof(b"distinct-levels", MAX_RECURSIVE_DEPTH).unwrap();
        let unique: std::collections::HashSet<[u8; 32]> = p.levels.iter().copied().collect();
        assert_eq!(unique.len(), p.levels.len(), "all levels must be distinct");
    }

    // Test 11: proof_id is a function of final_hash only — same final_hash → same proof_id
    #[test]
    fn test_proof_id_derived_from_final_hash() {
        let p = create_recursive_proof(b"id-check", 3).unwrap();
        // Re-derive proof_id manually
        let expected_id = compute_proof_id(&p.final_hash);
        assert_eq!(p.proof_id, expected_id);
    }

    // Test 12: verify fails when level is tampered
    #[test]
    fn test_verify_fails_tampered_level() {
        let mut p = create_recursive_proof(b"tamper", 3).unwrap();
        p.levels[1][0] ^= 0xFF;
        assert!(!verify_recursive(&p, b"tamper"));
    }

    // Test 13: verify fails when depth doesn't match levels count
    #[test]
    fn test_verify_fails_levels_count_mismatch() {
        let mut p = create_recursive_proof(b"levels-mismatch", 3).unwrap();
        p.levels.push([0u8; 32]); // add an extra bogus level
        assert!(!verify_recursive(&p, b"levels-mismatch"));
    }

    // Test 14: final_hash is sensitive to depth
    #[test]
    fn test_final_hash_sensitive_to_depth() {
        let p3 = create_recursive_proof(b"same", 3).unwrap();
        let p4 = create_recursive_proof(b"same", 4).unwrap();
        assert_ne!(p3.final_hash, p4.final_hash);
    }

    // Test 15: public record JSON includes proof_id and depth, excludes levels
    #[test]
    fn test_public_record_fields() {
        let p = create_recursive_proof(b"record", 2).unwrap();
        let json = recursive_public_record(&p);
        assert!(json.contains("proof_id"));
        assert!(json.contains("final_hash"));
        assert!(json.contains("depth"));
        // levels are NOT included in the public record (they expose intermediate state)
        assert!(!json.contains("levels"));
    }

    // Test 16: all depths 1..=8 produce valid verify roundtrip
    #[test]
    fn test_all_valid_depths_verify() {
        for d in 1..=MAX_RECURSIVE_DEPTH {
            let p = create_recursive_proof(b"all-depths", d).unwrap();
            assert!(
                verify_recursive(&p, b"all-depths"),
                "depth {} failed verification",
                d
            );
        }
    }
}
