use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Private domain-separated SHA-256 helper
// ---------------------------------------------------------------------------

fn sha256_domain(domain: &[u8], inputs: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(domain);
    for input in inputs {
        h.update(input);
    }
    h.finalize().into()
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A committed roadmap feature.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RoadmapCommit {
    /// Derived hash of the full commit (call [`RoadmapCommit::derive_commit_hash`]).
    pub commit_hash: [u8; 32],
    /// `SHA256("dark_null_v1_feature" || docs_hash || tests_hash)`
    pub feature_hash: [u8; 32],
    /// `SHA256("dark_null_v1_claim" || public_claim_text_bytes)`
    pub claim_hash: [u8; 32],
    pub target_epoch: u64,
    /// Slot after which a reveal is considered stale.
    pub reveal_deadline: u64,
    pub commit_slot: u64,
}

impl RoadmapCommit {
    pub fn derive_commit_hash(&self) -> [u8; 32] {
        sha256_domain(
            b"dark_null_v1_roadmap_commit",
            &[
                self.feature_hash.as_ref(),
                self.claim_hash.as_ref(),
                &self.target_epoch.to_le_bytes(),
                &self.reveal_deadline.to_le_bytes(),
                &self.commit_slot.to_le_bytes(),
            ],
        )
    }
}

/// A reveal proving the feature was built as committed.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RoadmapReveal {
    pub commit_hash: [u8; 32],
    /// Hash of actual documentation.
    pub docs_hash: [u8; 32],
    /// Hash of actual test file(s).
    pub tests_hash: [u8; 32],
    /// Actual public claim text bytes.
    pub claim_preimage: Vec<u8>,
    pub reveal_slot: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum RevealStatus {
    Verified,
    Stale { deadline: u64, revealed_at: u64 },
    InvalidFeatureHash,
    InvalidClaimHash,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimHash(pub [u8; 32]);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeatureEvidenceHash(pub [u8; 32]);

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/// Hash the feature evidence from docs and tests.
///
/// `feature_hash = SHA256("dark_null_v1_feature" || docs_hash || tests_hash)`
pub fn feature_hash_from(docs_hash: &[u8; 32], tests_hash: &[u8; 32]) -> FeatureEvidenceHash {
    FeatureEvidenceHash(sha256_domain(
        b"dark_null_v1_feature",
        &[docs_hash.as_ref(), tests_hash.as_ref()],
    ))
}

/// Hash the public claim text.
///
/// `claim_hash = SHA256("dark_null_v1_claim" || claim_text_bytes)`
pub fn claim_hash_from(claim_text: &[u8]) -> ClaimHash {
    ClaimHash(sha256_domain(b"dark_null_v1_claim", &[claim_text]))
}

/// Create a new roadmap commit.
///
/// The returned [`RoadmapCommit`] has `commit_hash` set to the value of
/// [`RoadmapCommit::derive_commit_hash`].
pub fn commit_feature(
    docs_hash: [u8; 32],
    tests_hash: [u8; 32],
    claim_text: &[u8],
    target_epoch: u64,
    reveal_deadline: u64,
    commit_slot: u64,
) -> RoadmapCommit {
    let feature_hash = feature_hash_from(&docs_hash, &tests_hash).0;
    let claim_hash = claim_hash_from(claim_text).0;

    // Build a partial struct so we can derive the commit_hash from it.
    let partial = RoadmapCommit {
        commit_hash: [0u8; 32], // placeholder
        feature_hash,
        claim_hash,
        target_epoch,
        reveal_deadline,
        commit_slot,
    };
    let commit_hash = partial.derive_commit_hash();

    RoadmapCommit {
        commit_hash,
        ..partial
    }
}

/// Attempt to reveal and verify a commit.
///
/// Returns:
/// - [`RevealStatus::Stale`] if `reveal_slot > commit.reveal_deadline`
/// - [`RevealStatus::InvalidFeatureHash`] if the recomputed feature hash does not match
/// - [`RevealStatus::InvalidClaimHash`] if the recomputed claim hash does not match
/// - [`RevealStatus::Verified`] otherwise
pub fn reveal_commit(
    commit: &RoadmapCommit,
    reveal: &RoadmapReveal,
    _current_slot: u64,
) -> RevealStatus {
    if reveal.reveal_slot > commit.reveal_deadline {
        return RevealStatus::Stale {
            deadline: commit.reveal_deadline,
            revealed_at: reveal.reveal_slot,
        };
    }

    let expected_feature = feature_hash_from(&reveal.docs_hash, &reveal.tests_hash).0;
    if expected_feature != commit.feature_hash {
        return RevealStatus::InvalidFeatureHash;
    }

    let expected_claim = claim_hash_from(&reveal.claim_preimage).0;
    if expected_claim != commit.claim_hash {
        return RevealStatus::InvalidClaimHash;
    }

    RevealStatus::Verified
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_commit(docs: [u8; 32], tests: [u8; 32], claim: &[u8]) -> RoadmapCommit {
        commit_feature(docs, tests, claim, 100, 9999, 1000)
    }

    fn make_reveal(
        commit: &RoadmapCommit,
        docs: [u8; 32],
        tests: [u8; 32],
        claim: &[u8],
    ) -> RoadmapReveal {
        RoadmapReveal {
            commit_hash: commit.commit_hash,
            docs_hash: docs,
            tests_hash: tests,
            claim_preimage: claim.to_vec(),
            reveal_slot: 5000,
        }
    }

    const DOCS_A: [u8; 32] = [0xAAu8; 32];
    const DOCS_B: [u8; 32] = [0xBBu8; 32];
    const TESTS_A: [u8; 32] = [0xCCu8; 32];
    const TESTS_B: [u8; 32] = [0xDDu8; 32];
    const CLAIM: &[u8] = b"feature: dark null payments v1";

    // 1. Correct preimages → Verified.
    #[test]
    fn test_valid_reveal_verified() {
        let commit = make_commit(DOCS_A, TESTS_A, CLAIM);
        let reveal = make_reveal(&commit, DOCS_A, TESTS_A, CLAIM);
        assert_eq!(
            reveal_commit(&commit, &reveal, 5000),
            RevealStatus::Verified
        );
    }

    // 2. Wrong docs_hash → InvalidFeatureHash.
    #[test]
    fn test_wrong_docs_hash_rejected() {
        let commit = make_commit(DOCS_A, TESTS_A, CLAIM);
        let reveal = make_reveal(&commit, DOCS_B, TESTS_A, CLAIM);
        assert_eq!(
            reveal_commit(&commit, &reveal, 5000),
            RevealStatus::InvalidFeatureHash
        );
    }

    // 3. Wrong tests_hash → InvalidFeatureHash.
    #[test]
    fn test_wrong_tests_hash_rejected() {
        let commit = make_commit(DOCS_A, TESTS_A, CLAIM);
        let reveal = make_reveal(&commit, DOCS_A, TESTS_B, CLAIM);
        assert_eq!(
            reveal_commit(&commit, &reveal, 5000),
            RevealStatus::InvalidFeatureHash
        );
    }

    // 4. Wrong claim_preimage → InvalidClaimHash.
    #[test]
    fn test_wrong_claim_rejected() {
        let commit = make_commit(DOCS_A, TESTS_A, CLAIM);
        let reveal = make_reveal(&commit, DOCS_A, TESTS_A, b"different claim");
        assert_eq!(
            reveal_commit(&commit, &reveal, 5000),
            RevealStatus::InvalidClaimHash
        );
    }

    // 5. reveal_slot=10000 > reveal_deadline=9999 → Stale.
    #[test]
    fn test_late_reveal_marked_stale() {
        let commit = make_commit(DOCS_A, TESTS_A, CLAIM);
        let mut reveal = make_reveal(&commit, DOCS_A, TESTS_A, CLAIM);
        reveal.reveal_slot = 10000;
        assert_eq!(
            reveal_commit(&commit, &reveal, 10000),
            RevealStatus::Stale {
                deadline: 9999,
                revealed_at: 10000,
            }
        );
    }

    // 6. Same inputs to commit_feature → same commit_hash (deterministic).
    #[test]
    fn test_commit_hash_deterministic() {
        let c1 = commit_feature(DOCS_A, TESTS_A, CLAIM, 100, 9999, 1000);
        let c2 = commit_feature(DOCS_A, TESTS_A, CLAIM, 100, 9999, 1000);
        assert_eq!(c1.commit_hash, c2.commit_hash);
    }

    // 7. feature_hash_from binds both docs and tests independently.
    #[test]
    fn test_feature_hash_binds_both_docs_and_tests() {
        // Different docs → different hash.
        assert_ne!(
            feature_hash_from(&DOCS_A, &TESTS_A),
            feature_hash_from(&DOCS_B, &TESTS_A)
        );
        // Different tests → different hash.
        assert_ne!(
            feature_hash_from(&DOCS_A, &TESTS_A),
            feature_hash_from(&DOCS_A, &TESTS_B)
        );
    }

    // 8. claim_hash_from binds public wording and is deterministic.
    #[test]
    fn test_claim_hash_binds_public_wording() {
        let h1 = claim_hash_from(b"feature A");
        let h2 = claim_hash_from(b"feature B");
        assert_ne!(h1, h2);

        // Determinism check.
        let h1_again = claim_hash_from(b"feature A");
        assert_eq!(h1, h1_again);
    }

    // 9. Different reveal_deadline → different commit_hash.
    #[test]
    fn test_commit_hash_changes_with_deadline() {
        let c1 = commit_feature(DOCS_A, TESTS_A, CLAIM, 100, 9999, 1000);
        let c2 = commit_feature(DOCS_A, TESTS_A, CLAIM, 100, 8888, 1000);
        assert_ne!(c1.commit_hash, c2.commit_hash);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_commit_hash_nonzero() {
        let c = make_commit(DOCS_A, TESTS_A, CLAIM);
        assert_ne!(c.commit_hash, [0u8; 32]);
    }

    #[test]
    fn test_reveal_at_exact_deadline_verified() {
        // reveal_slot == reveal_deadline (9999) — strictly > check, so == is NOT Stale
        let commit = make_commit(DOCS_A, TESTS_A, CLAIM);
        let mut reveal = make_reveal(&commit, DOCS_A, TESTS_A, CLAIM);
        reveal.reveal_slot = 9999;
        assert_eq!(
            reveal_commit(&commit, &reveal, 9999),
            RevealStatus::Verified
        );
    }

    #[test]
    fn test_feature_hash_nonzero() {
        let fh = feature_hash_from(&DOCS_A, &TESTS_A);
        assert_ne!(fh.0, [0u8; 32]);
    }

    #[test]
    fn test_claim_hash_nonzero() {
        let ch = claim_hash_from(CLAIM);
        assert_ne!(ch.0, [0u8; 32]);
    }

    #[test]
    fn test_commit_hash_changes_with_target_epoch() {
        let c1 = commit_feature(DOCS_A, TESTS_A, CLAIM, 100, 9999, 1000);
        let c2 = commit_feature(DOCS_A, TESTS_A, CLAIM, 200, 9999, 1000);
        assert_ne!(c1.commit_hash, c2.commit_hash);
    }

    #[test]
    fn test_derive_commit_hash_matches_stored() {
        let c = make_commit(DOCS_A, TESTS_A, CLAIM);
        assert_eq!(c.derive_commit_hash(), c.commit_hash);
    }

    #[test]
    fn test_commit_hash_changes_with_commit_slot() {
        let c1 = commit_feature(DOCS_A, TESTS_A, CLAIM, 100, 9999, 1000);
        let c2 = commit_feature(DOCS_A, TESTS_A, CLAIM, 100, 9999, 2000);
        assert_ne!(c1.commit_hash, c2.commit_hash);
    }
}
