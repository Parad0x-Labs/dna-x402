use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

/// Specifies the difficulty (leading zero bits) required for a valid proof.
#[derive(Debug, Clone, PartialEq)]
pub struct WorkStatement {
    /// Number of leading zero bits required in work_hash.
    pub difficulty: u8,
    pub mainnet_ready: bool,
}

/// A computational proof-of-work.
/// work_hash = SHA256("pow-v1" || secret || nonce.to_le_bytes())
#[derive(Debug, Clone, PartialEq)]
pub struct WorkProof {
    pub nonce: u64,
    pub work_hash: [u8; 32],
    pub satisfies_difficulty: bool,
    pub iterations: u64,
    pub mainnet_ready: bool,
}

/// Errors produced by the proof-of-work API.
#[derive(Debug, PartialEq)]
pub enum WorkError {
    ZeroSecret,
    DifficultyTooHigh,
}

// ── Internal helpers ───────────────────────────────────────────────────────

fn is_zero_secret(secret: &[u8; 32]) -> bool {
    secret.iter().all(|&b| b == 0)
}

fn compute_work_hash(secret: &[u8; 32], nonce: u64) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"pow-v1");
    h.update(secret.as_slice());
    h.update(&nonce.to_le_bytes());
    h.finalize().into()
}

/// Count the number of leading zero bits in a 32-byte hash.
fn leading_zero_bits(hash: &[u8; 32]) -> u8 {
    let mut count = 0u8;
    for &byte in hash.iter() {
        if byte == 0 {
            count += 8;
        } else {
            count += byte.leading_zeros() as u8;
            break;
        }
    }
    count
}

fn hex_encode(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

// ── Public API ─────────────────────────────────────────────────────────────

/// Create a work statement with the given difficulty.
/// Returns DifficultyTooHigh if difficulty > 20.
pub fn create_statement(difficulty: u8) -> Result<WorkStatement, WorkError> {
    if difficulty > 20 {
        return Err(WorkError::DifficultyTooHigh);
    }
    Ok(WorkStatement {
        difficulty,
        mainnet_ready: false,
    })
}

/// Attempt to find a nonce satisfying the statement's difficulty.
/// - Returns ZeroSecret if secret is all-zero.
/// - Tries nonce = 0..max_iterations.
/// - If a valid nonce is found, returns WorkProof with satisfies_difficulty = true.
/// - If max_iterations exhausted, returns the last attempt with satisfies_difficulty = false.
pub fn solve_proof(
    statement: &WorkStatement,
    secret: &[u8; 32],
    max_iterations: u64,
) -> Result<WorkProof, WorkError> {
    if is_zero_secret(secret) {
        return Err(WorkError::ZeroSecret);
    }

    let mut last_hash = [0u8; 32];
    let mut last_nonce = 0u64;

    for nonce in 0..max_iterations {
        let hash = compute_work_hash(secret, nonce);
        last_hash = hash;
        last_nonce = nonce;

        if leading_zero_bits(&hash) >= statement.difficulty {
            return Ok(WorkProof {
                nonce,
                work_hash: hash,
                satisfies_difficulty: true,
                iterations: nonce + 1,
                mainnet_ready: false,
            });
        }
    }

    // Exhausted — return last attempt
    Ok(WorkProof {
        nonce: last_nonce,
        work_hash: last_hash,
        satisfies_difficulty: false,
        iterations: max_iterations,
        mainnet_ready: false,
    })
}

/// Verify a work proof against a statement and secret.
/// Recomputes work_hash; checks it matches proof.work_hash and satisfies difficulty.
pub fn verify_work(statement: &WorkStatement, proof: &WorkProof, secret: &[u8; 32]) -> bool {
    let expected_hash = compute_work_hash(secret, proof.nonce);
    if expected_hash != proof.work_hash {
        return false;
    }
    leading_zero_bits(&expected_hash) >= statement.difficulty
}

/// Return a JSON public record. Does NOT include the secret.
pub fn work_public_record(proof: &WorkProof) -> String {
    serde_json::json!({
        "nonce": proof.nonce,
        "work_hash": hex_encode(&proof.work_hash),
        "satisfies_difficulty": proof.satisfies_difficulty,
        "iterations": proof.iterations,
        "mainnet_ready": proof.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn secret() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0x42;
        s[1] = 0xDE;
        s[2] = 0xAD;
        s
    }

    // 1. difficulty=0 solves immediately (every hash has >= 0 leading zero bits).
    #[test]
    fn test_difficulty_zero_solves_immediately() {
        let stmt = create_statement(0).unwrap();
        let proof = solve_proof(&stmt, &secret(), 1).unwrap();
        assert!(proof.satisfies_difficulty);
        assert_eq!(proof.iterations, 1);
        assert!(!proof.mainnet_ready);
    }

    // 2. difficulty=1: solver finds a hash with at least 1 leading zero bit.
    #[test]
    fn test_difficulty_one_solves() {
        let stmt = create_statement(1).unwrap();
        // Allow up to 512 iterations — statistically near-certain to find one.
        let proof = solve_proof(&stmt, &secret(), 512).unwrap();
        assert!(
            proof.satisfies_difficulty,
            "should find difficulty=1 within 512 iterations"
        );
        assert!(leading_zero_bits(&proof.work_hash) >= 1);
    }

    // 3. verify_work passes on a valid proof.
    #[test]
    fn test_verify_work_passes() {
        let stmt = create_statement(1).unwrap();
        let proof = solve_proof(&stmt, &secret(), 512).unwrap();
        assert!(proof.satisfies_difficulty);
        assert!(verify_work(&stmt, &proof, &secret()));
    }

    // 4. Zero secret is rejected.
    #[test]
    fn test_zero_secret_rejected() {
        let stmt = create_statement(0).unwrap();
        let zero = [0u8; 32];
        let result = solve_proof(&stmt, &zero, 10);
        assert_eq!(result, Err(WorkError::ZeroSecret));
    }

    // 5. difficulty > 20 is rejected.
    #[test]
    fn test_difficulty_too_high_rejected() {
        let result = create_statement(21);
        assert_eq!(result, Err(WorkError::DifficultyTooHigh));
        // Boundary: 20 must succeed.
        let ok = create_statement(20);
        assert!(ok.is_ok());
    }

    // 6. Public record does not contain the secret.
    #[test]
    fn test_public_record_hides_secret() {
        let stmt = create_statement(0).unwrap();
        let sec = secret();
        let proof = solve_proof(&stmt, &sec, 1).unwrap();
        let record = work_public_record(&proof);

        // Secret as hex must not appear
        let secret_hex = hex_encode(&sec);
        assert!(
            !record.contains(&secret_hex),
            "public record must not expose the secret"
        );
        // Expected fields must be present
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v.get("nonce").is_some());
        assert!(v.get("work_hash").is_some());
        assert!(v.get("satisfies_difficulty").is_some());
        assert!(v.get("iterations").is_some());
        assert!(v.get("mainnet_ready").is_some());
        assert!(!proof.mainnet_ready);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_work_hash_nonzero() {
        let stmt = create_statement(0).unwrap();
        let proof = solve_proof(&stmt, &secret(), 1).unwrap();
        assert_ne!(proof.work_hash, [0u8; 32]);
    }

    #[test]
    fn test_statement_mainnet_ready_false() {
        let stmt = create_statement(0).unwrap();
        assert!(!stmt.mainnet_ready);
    }

    #[test]
    fn test_verify_fails_on_tampered_hash() {
        let stmt = create_statement(0).unwrap();
        let mut proof = solve_proof(&stmt, &secret(), 1).unwrap();
        proof.work_hash[0] ^= 0xFF;
        assert!(!verify_work(&stmt, &proof, &secret()));
    }

    #[test]
    fn test_max_iterations_exhausted_returns_unsatisfied() {
        // difficulty=20 won't be satisfied in 1 iteration with overwhelming probability
        let stmt = create_statement(20).unwrap();
        let proof = solve_proof(&stmt, &secret(), 1).unwrap();
        // We can't guarantee satisfies_difficulty is false (could get lucky),
        // but iterations must equal max_iterations when not satisfied
        if !proof.satisfies_difficulty {
            assert_eq!(proof.iterations, 1);
        }
    }

    #[test]
    fn test_different_secrets_different_work_hash() {
        let stmt = create_statement(0).unwrap();
        let mut sec2 = secret();
        sec2[0] ^= 0xFF;
        let p1 = solve_proof(&stmt, &secret(), 1).unwrap();
        let p2 = solve_proof(&stmt, &sec2, 1).unwrap();
        assert_ne!(p1.work_hash, p2.work_hash);
    }

    #[test]
    fn test_iterations_count_correct() {
        let stmt = create_statement(0).unwrap();
        let proof = solve_proof(&stmt, &secret(), 5).unwrap();
        // difficulty 0 solved at nonce=0, iterations=1
        assert_eq!(proof.iterations, 1);
        assert_eq!(proof.nonce, 0);
    }

    #[test]
    fn test_difficulty_20_boundary_ok() {
        assert!(create_statement(20).is_ok());
        assert_eq!(
            create_statement(21).unwrap_err(),
            WorkError::DifficultyTooHigh
        );
    }

    #[test]
    fn test_work_mainnet_ready_false() {
        let stmt = create_statement(0).unwrap();
        let proof = solve_proof(&stmt, &secret(), 1).unwrap();
        assert!(!proof.mainnet_ready);
    }

    #[test]
    fn test_difficulty_zero_always_satisfies() {
        let stmt = create_statement(0).unwrap();
        let proof = solve_proof(&stmt, &secret(), 1).unwrap();
        assert!(proof.satisfies_difficulty);
        assert!(verify_work(&stmt, &proof, &secret()));
    }

    #[test]
    fn test_verify_fails_wrong_secret() {
        let stmt = create_statement(0).unwrap();
        let proof = solve_proof(&stmt, &secret(), 1).unwrap();
        let mut wrong_sec = secret();
        wrong_sec[0] ^= 0x01;
        assert!(!verify_work(&stmt, &proof, &wrong_sec));
    }
}
