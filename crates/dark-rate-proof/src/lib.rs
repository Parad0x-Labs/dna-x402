//! dark-rate-proof — ZK rate-limit enforcement without revealing usage count
//!
//! An agent proves it has made ≤ N API calls in window [start, end] without
//! disclosing the exact count. The verifier sees only the commitment and the
//! "within_limit: true/false" flag; the raw count is hidden.
//!
//! Protocol (stub):
//!   1. Prover hashes (usage_count, blinding) → usage_commitment
//!   2. Prover hashes (limit, blinding)       → limit_commitment
//!   3. Prover sets within_limit = (usage_count <= limit)
//!   4. Verifier checks both commitments match and flag is consistent
//!
//!   In production, step 3 is a range-proof gadget (Bulletproofs / Groth16).
//!   Here the raw values are passed to `verify_within_limit` so tests can
//!   confirm the commitment scheme is consistent.
//!
//! IS_STUB = true  — no real range proof; raw values passed during verification.
//! MAINNET_READY = false — always false in this constructor.

use sha2::{Sha256, Digest};

pub const IS_STUB: bool = true;
pub const MAINNET_READY: bool = false;

// Domain tags.
const DOMAIN_PROOF_ID:       &[u8] = b"dark-rate-proof-id-v1";
const DOMAIN_USAGE_COMMIT:   &[u8] = b"dark-rate-usage-commit-v1";
const DOMAIN_LIMIT_COMMIT:   &[u8] = b"dark-rate-limit-commit-v1";
const DOMAIN_SCOPE_HASH:     &[u8] = b"dark-rate-scope-hash-v1";

// ── Errors ────────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Clone)]
pub enum RateError {
    MainnetNotReady,
    WindowZeroLength,
    WindowStartAfterEnd,
    ZeroLimit,
    NullBlinding,
    EmptyScope,
}

impl core::fmt::Display for RateError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{:?}", self)
    }
}

// ── Types ─────────────────────────────────────────────────────────────────────

/// A rate-limit proof. Posts usage and limit commitments, plus the boolean flag.
#[derive(Debug, Clone, PartialEq)]
pub struct RateProof {
    /// H(DOMAIN_PROOF_ID || usage_commitment || limit_commitment || window_bytes || scope_hash)
    pub proof_id:          [u8; 32],
    /// H(DOMAIN_USAGE_COMMIT || usage_count_le8 || blinding)
    pub usage_commitment:  [u8; 32],
    /// H(DOMAIN_LIMIT_COMMIT || limit_le8 || blinding)
    pub limit_commitment:  [u8; 32],
    /// True iff usage_count <= limit at proof creation time.
    pub within_limit:      bool,
    pub window_start:      u64,
    pub window_end:        u64,
    /// Domain scope (e.g. an API endpoint hash) so proofs from different scopes
    /// cannot be mixed.
    pub program_scope:     [u8; 32],
    pub is_stub:           bool,
    pub mainnet_ready:     bool,
}

/// Public-key style limit credential: "this scope allows max N calls per window".
#[derive(Debug, Clone, PartialEq)]
pub struct RateLimit {
    pub scope_hash:   [u8; 32],
    pub max_calls:    u64,
    pub window_secs:  u64,
}

// ── Hash helpers ──────────────────────────────────────────────────────────────

pub fn compute_usage_commitment(usage_count: u64, blinding: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(DOMAIN_USAGE_COMMIT);
    h.update(usage_count.to_le_bytes());
    h.update(blinding);
    h.finalize().into()
}

pub fn compute_limit_commitment(limit: u64, blinding: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(DOMAIN_LIMIT_COMMIT);
    h.update(limit.to_le_bytes());
    h.update(blinding);
    h.finalize().into()
}

pub fn compute_scope_hash(scope: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(DOMAIN_SCOPE_HASH);
    h.update(scope.as_bytes());
    h.finalize().into()
}

fn compute_proof_id(
    usage_commitment: &[u8; 32],
    limit_commitment: &[u8; 32],
    window_start:     u64,
    window_end:       u64,
    scope_hash:       &[u8; 32],
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(DOMAIN_PROOF_ID);
    h.update(usage_commitment);
    h.update(limit_commitment);
    h.update(window_start.to_le_bytes());
    h.update(window_end.to_le_bytes());
    h.update(scope_hash);
    h.finalize().into()
}

// ── Proof creation ────────────────────────────────────────────────────────────

/// Create a rate-limit proof.
///
/// `usage_count` — how many calls the agent made in [window_start, window_end].
/// `limit`       — the allowed maximum.
/// `blinding`    — random bytes, kept private; binds the commitment to the caller.
/// `scope`       — human-readable scope string (API endpoint, program ID, etc.).
pub fn create_rate_proof(
    usage_count:  u64,
    limit:        u64,
    blinding:     &[u8; 32],
    scope:        &str,
    window_start: u64,
    window_end:   u64,
) -> Result<RateProof, RateError> {
    if MAINNET_READY {
        return Err(RateError::MainnetNotReady);
    }
    if limit == 0 {
        return Err(RateError::ZeroLimit);
    }
    if scope.is_empty() {
        return Err(RateError::EmptyScope);
    }
    if window_start >= window_end {
        return Err(RateError::WindowStartAfterEnd);
    }
    if blinding == &[0u8; 32] {
        return Err(RateError::NullBlinding);
    }

    let usage_commitment = compute_usage_commitment(usage_count, blinding);
    let limit_commitment = compute_limit_commitment(limit, blinding);
    let scope_hash       = compute_scope_hash(scope);
    let within_limit     = usage_count <= limit;

    let proof_id = compute_proof_id(
        &usage_commitment,
        &limit_commitment,
        window_start,
        window_end,
        &scope_hash,
    );

    Ok(RateProof {
        proof_id,
        usage_commitment,
        limit_commitment,
        within_limit,
        window_start,
        window_end,
        program_scope: scope_hash,
        is_stub:        IS_STUB,
        mainnet_ready:  MAINNET_READY,
    })
}

// ── Proof verification ────────────────────────────────────────────────────────

/// Verify that `proof` is consistent with the supplied (usage, limit, blinding).
///
/// Stub: re-derives commitments from raw values and checks they match.
/// In production, a ZK range proof replaces this raw-value check so the
/// verifier never learns usage_count or limit.
pub fn verify_within_limit(
    proof:        &RateProof,
    usage_count:  u64,
    limit:        u64,
    blinding:     &[u8; 32],
) -> bool {
    let expected_usage = compute_usage_commitment(usage_count, blinding);
    let expected_limit = compute_limit_commitment(limit, blinding);

    if expected_usage != proof.usage_commitment {
        return false;
    }
    if expected_limit != proof.limit_commitment {
        return false;
    }
    // The flag must match the actual comparison.
    if proof.within_limit != (usage_count <= limit) {
        return false;
    }
    true
}

/// Check that a proof covers a given time window.
pub fn verify_window(proof: &RateProof, start: u64, end: u64) -> bool {
    proof.window_start == start && proof.window_end == end
}

/// Check that a proof is for the expected scope.
pub fn verify_scope(proof: &RateProof, scope: &str) -> bool {
    proof.program_scope == compute_scope_hash(scope)
}

/// Full verification: commitments + flag + window + scope.
pub fn verify_proof_full(
    proof:        &RateProof,
    usage_count:  u64,
    limit:        u64,
    blinding:     &[u8; 32],
    scope:        &str,
    window_start: u64,
    window_end:   u64,
) -> bool {
    verify_within_limit(proof, usage_count, limit, blinding)
        && verify_window(proof, window_start, window_end)
        && verify_scope(proof, scope)
}

/// Create a rate limit credential for a scope.
pub fn create_rate_limit(scope: &str, max_calls: u64, window_secs: u64) -> RateLimit {
    RateLimit {
        scope_hash:  compute_scope_hash(scope),
        max_calls,
        window_secs,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const SCOPE: &str = "api/v1/dark-agent/spend";
    fn blinding() -> [u8; 32] { [0x42u8; 32] }

    fn make_proof(usage: u64, limit: u64) -> RateProof {
        create_rate_proof(usage, limit, &blinding(), SCOPE, 1_000, 2_000).unwrap()
    }

    // ── Create proof ─────────────────────────────────────────────────────────

    #[test]
    fn test_create_proof_within_limit() {
        let p = make_proof(5, 10);
        assert!(p.within_limit);
        assert_eq!(p.is_stub, true);
        assert_eq!(p.mainnet_ready, false);
    }

    #[test]
    fn test_create_proof_at_limit() {
        let p = make_proof(10, 10);
        assert!(p.within_limit);
    }

    #[test]
    fn test_create_proof_over_limit() {
        let p = make_proof(11, 10);
        assert!(!p.within_limit);
    }

    #[test]
    fn test_zero_limit_rejected() {
        let err = create_rate_proof(0, 0, &blinding(), SCOPE, 1_000, 2_000).unwrap_err();
        assert_eq!(err, RateError::ZeroLimit);
    }

    #[test]
    fn test_null_blinding_rejected() {
        let err = create_rate_proof(5, 10, &[0u8; 32], SCOPE, 1_000, 2_000).unwrap_err();
        assert_eq!(err, RateError::NullBlinding);
    }

    #[test]
    fn test_empty_scope_rejected() {
        let err = create_rate_proof(5, 10, &blinding(), "", 1_000, 2_000).unwrap_err();
        assert_eq!(err, RateError::EmptyScope);
    }

    #[test]
    fn test_window_start_after_end_rejected() {
        let err = create_rate_proof(5, 10, &blinding(), SCOPE, 2_000, 1_000).unwrap_err();
        assert_eq!(err, RateError::WindowStartAfterEnd);
    }

    #[test]
    fn test_equal_start_end_rejected() {
        let err = create_rate_proof(5, 10, &blinding(), SCOPE, 1_000, 1_000).unwrap_err();
        assert_eq!(err, RateError::WindowStartAfterEnd);
    }

    // ── Commitment properties ─────────────────────────────────────────────────

    #[test]
    fn test_usage_commitment_deterministic() {
        let c1 = compute_usage_commitment(7, &blinding());
        let c2 = compute_usage_commitment(7, &blinding());
        assert_eq!(c1, c2);
    }

    #[test]
    fn test_usage_commitment_sensitive_to_count() {
        let c1 = compute_usage_commitment(7, &blinding());
        let c2 = compute_usage_commitment(8, &blinding());
        assert_ne!(c1, c2);
    }

    #[test]
    fn test_usage_commitment_sensitive_to_blinding() {
        let c1 = compute_usage_commitment(7, &[0x01u8; 32]);
        let c2 = compute_usage_commitment(7, &[0x02u8; 32]);
        assert_ne!(c1, c2);
    }

    #[test]
    fn test_limit_commitment_independent_of_usage_commitment() {
        let uc = compute_usage_commitment(10, &blinding());
        let lc = compute_limit_commitment(10, &blinding());
        assert_ne!(uc, lc, "domain separation must separate usage from limit");
    }

    // ── Proof ID uniqueness ───────────────────────────────────────────────────

    #[test]
    fn test_different_windows_different_proof_ids() {
        let p1 = create_rate_proof(5, 10, &blinding(), SCOPE, 1_000, 2_000).unwrap();
        let p2 = create_rate_proof(5, 10, &blinding(), SCOPE, 1_001, 2_000).unwrap();
        assert_ne!(p1.proof_id, p2.proof_id);
    }

    #[test]
    fn test_different_scopes_different_proof_ids() {
        let p1 = create_rate_proof(5, 10, &blinding(), "scope-a", 1_000, 2_000).unwrap();
        let p2 = create_rate_proof(5, 10, &blinding(), "scope-b", 1_000, 2_000).unwrap();
        assert_ne!(p1.proof_id, p2.proof_id);
    }

    // ── Verification ──────────────────────────────────────────────────────────

    #[test]
    fn test_verify_within_limit_happy_path() {
        let p = make_proof(5, 10);
        assert!(verify_within_limit(&p, 5, 10, &blinding()));
    }

    #[test]
    fn test_verify_wrong_usage_fails() {
        let p = make_proof(5, 10);
        assert!(!verify_within_limit(&p, 6, 10, &blinding()));
    }

    #[test]
    fn test_verify_wrong_limit_fails() {
        let p = make_proof(5, 10);
        assert!(!verify_within_limit(&p, 5, 11, &blinding()));
    }

    #[test]
    fn test_verify_wrong_blinding_fails() {
        let p = make_proof(5, 10);
        assert!(!verify_within_limit(&p, 5, 10, &[0x99u8; 32]));
    }

    #[test]
    fn test_verify_window_correct() {
        let p = make_proof(5, 10);
        assert!( verify_window(&p, 1_000, 2_000));
        assert!(!verify_window(&p, 1_000, 3_000));
    }

    #[test]
    fn test_verify_scope_correct() {
        let p = make_proof(5, 10);
        assert!( verify_scope(&p, SCOPE));
        assert!(!verify_scope(&p, "other/scope"));
    }

    #[test]
    fn test_verify_proof_full_roundtrip() {
        let p = make_proof(7, 20);
        assert!(verify_proof_full(&p, 7, 20, &blinding(), SCOPE, 1_000, 2_000));
    }

    #[test]
    fn test_verify_proof_full_wrong_usage() {
        let p = make_proof(7, 20);
        assert!(!verify_proof_full(&p, 8, 20, &blinding(), SCOPE, 1_000, 2_000));
    }

    // ── Rate limit credential ─────────────────────────────────────────────────

    #[test]
    fn test_create_rate_limit() {
        let rl = create_rate_limit(SCOPE, 100, 3600);
        assert_eq!(rl.max_calls, 100);
        assert_eq!(rl.window_secs, 3600);
        assert_eq!(rl.scope_hash, compute_scope_hash(SCOPE));
    }

    #[test]
    fn test_scope_hash_deterministic() {
        let h1 = compute_scope_hash("test-scope");
        let h2 = compute_scope_hash("test-scope");
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_scope_hash_different_scopes() {
        let h1 = compute_scope_hash("scope-a");
        let h2 = compute_scope_hash("scope-b");
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_mainnet_ready_always_false() {
        let p = make_proof(1, 10);
        assert_eq!(p.mainnet_ready, false);
    }

    // ── Proof flag correctness ────────────────────────────────────────────────

    #[test]
    fn test_within_limit_flag_zero_usage() {
        let p = make_proof(0, 10);
        assert!(p.within_limit);
    }

    #[test]
    fn test_within_limit_large_usage_over_limit() {
        let p = make_proof(u64::MAX, 1_000);
        assert!(!p.within_limit);
    }

    #[test]
    fn test_within_limit_exactly_at_limit() {
        let p = make_proof(42, 42);
        assert!(p.within_limit);
        assert!(verify_within_limit(&p, 42, 42, &blinding()));
    }
}
