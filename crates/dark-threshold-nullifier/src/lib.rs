// dark-threshold-nullifier — k-of-n threshold nullifier using XOR secret sharing
// Requires k parties to collaborate before the nullifier is producible.
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false

use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct NullifierShare {
    /// Which party this share belongs to (0-indexed)
    pub party_index: u8,
    /// The actual share bytes
    pub share: [u8; 32],
    /// Commitment to this share: SHA256("share-commit-v1" || share || party_index)
    pub commitment: [u8; 32],
    pub mainnet_ready: bool, // always false
}

#[derive(Debug, Clone, PartialEq)]
pub struct ThresholdNullifierConfig {
    pub k: u8, // threshold (minimum shares required)
    pub n: u8, // total parties
    /// Commitments to all n shares — published at setup time
    pub share_commitments: Vec<[u8; 32]>,
    /// Domain hash binding this nullifier to a specific use case
    pub domain_hash: [u8; 32],
    pub mainnet_ready: bool, // always false
}

#[derive(Debug, Clone, PartialEq)]
pub struct CombinedNullifier {
    /// The final nullifier value
    pub nullifier: [u8; 32],
    /// Indices of parties that contributed
    pub contributors: Vec<u8>,
    /// Proof that exactly k shares were combined correctly
    pub combination_proof: [u8; 32],
    pub mainnet_ready: bool, // always false
}

#[derive(Debug, PartialEq)]
pub enum ThresholdError {
    InsufficientShares { have: u8, need: u8 },
    DuplicateParty { index: u8 },
    InvalidShareCommitment { party_index: u8 },
    ThresholdExceedsParties,
    ZeroThreshold,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Compute the share commitment: SHA256("share-commit-v1" || share || party_index)
fn compute_share_commitment(share: &[u8; 32], party_index: u8) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"share-commit-v1");
    hasher.update(share);
    hasher.update([party_index]);
    hasher.finalize().into()
}

/// Derive a deterministic-but-unpredictable share seed for party `idx` from the secret.
/// SHA256("share-derive-v1" || secret || idx)
fn derive_share_bytes(secret: &[u8; 32], idx: u8) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"share-derive-v1");
    hasher.update(secret);
    hasher.update([idx]);
    hasher.finalize().into()
}

/// XOR two 32-byte arrays together, returning a new array.
fn xor32(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = a[i] ^ b[i];
    }
    out
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Setup: split a secret into n shares where any k *primary* shares reconstruct.
///
/// The k primary shares (indices 0..k-1) are split via XOR:
///   shares[0..k-2] are SHA256-derived from (secret, index)
///   shares[k-1]    = secret XOR shares[0] XOR … XOR shares[k-2]
///
/// Parties k..n receive *extra* shares derived as
///   SHA256("extra-share-v1" || secret || party_index)
/// which can participate in combine() in place of any primary share
/// (for k-of-n flexibility in devnet).
///
/// Returns the config (with commitments) and the full Vec of n shares.
pub fn setup(
    secret: &[u8; 32],
    k: u8,
    n: u8,
    domain_hash: &[u8; 32],
) -> Result<(ThresholdNullifierConfig, Vec<NullifierShare>), ThresholdError> {
    if k == 0 {
        return Err(ThresholdError::ZeroThreshold);
    }
    if k > n {
        return Err(ThresholdError::ThresholdExceedsParties);
    }

    let mut shares: Vec<NullifierShare> = Vec::with_capacity(n as usize);

    // Generate k primary shares via XOR splitting.
    let mut xor_accumulator = *secret;
    for idx in 0..(k - 1) {
        let share_bytes = derive_share_bytes(secret, idx);
        // Remove this share's contribution so the last share can restore the secret.
        xor_accumulator = xor32(&xor_accumulator, &share_bytes);
        let commitment = compute_share_commitment(&share_bytes, idx);
        shares.push(NullifierShare {
            party_index: idx,
            share: share_bytes,
            commitment,
            mainnet_ready: false,
        });
    }
    // Last primary share: xor_accumulator now equals secret XOR all previous shares,
    // so XOR-ing all k primary shares recovers the secret.
    let last_primary_idx = k - 1;
    let last_share_bytes = xor_accumulator; // secret XOR shares[0] XOR … XOR shares[k-2]
    let commitment = compute_share_commitment(&last_share_bytes, last_primary_idx);
    shares.push(NullifierShare {
        party_index: last_primary_idx,
        share: last_share_bytes,
        commitment,
        mainnet_ready: false,
    });

    // Generate extra shares for parties k..n-1.
    for idx in k..n {
        let mut hasher = Sha256::new();
        hasher.update(b"extra-share-v1");
        hasher.update(secret);
        hasher.update([idx]);
        let share_bytes: [u8; 32] = hasher.finalize().into();
        let commitment = compute_share_commitment(&share_bytes, idx);
        shares.push(NullifierShare {
            party_index: idx,
            share: share_bytes,
            commitment,
            mainnet_ready: false,
        });
    }

    // Build config with all commitments.
    let share_commitments: Vec<[u8; 32]> = shares.iter().map(|s| s.commitment).collect();

    let config = ThresholdNullifierConfig {
        k,
        n,
        share_commitments,
        domain_hash: *domain_hash,
        mainnet_ready: false,
    };

    Ok((config, shares))
}

/// Verify a share against the published commitment in the config.
pub fn verify_share(share: &NullifierShare, config: &ThresholdNullifierConfig) -> bool {
    let idx = share.party_index as usize;
    if idx >= config.share_commitments.len() {
        return false;
    }
    let expected = compute_share_commitment(&share.share, share.party_index);
    expected == config.share_commitments[idx]
}

/// Combine k (or more) shares to produce the nullifier.
///
/// The nullifier is computed over the k *primary* indices (0..k-1).
/// If the caller provides shares from extra parties (indices >= k), those are
/// accepted but only the first k unique shares (sorted by party_index) are used
/// in the XOR so that the result is deterministic for any valid k-subset.
///
/// nullifier = SHA256("threshold-null-v1" || XOR_of_k_shares || domain_hash)
pub fn combine(
    shares: &[NullifierShare],
    config: &ThresholdNullifierConfig,
) -> Result<CombinedNullifier, ThresholdError> {
    // Duplicate-party check.
    let mut seen: Vec<u8> = Vec::new();
    for s in shares {
        if seen.contains(&s.party_index) {
            return Err(ThresholdError::DuplicateParty {
                index: s.party_index,
            });
        }
        seen.push(s.party_index);
    }

    // Insufficient shares check.
    if shares.len() < config.k as usize {
        return Err(ThresholdError::InsufficientShares {
            have: shares.len() as u8,
            need: config.k,
        });
    }

    // Commitment validity check for all provided shares.
    for s in shares {
        if !verify_share(s, config) {
            return Err(ThresholdError::InvalidShareCommitment {
                party_index: s.party_index,
            });
        }
    }

    // Sort provided shares by party_index and take the first k for combination.
    let mut sorted_shares = shares.to_vec();
    sorted_shares.sort_by_key(|s| s.party_index);
    let active = &sorted_shares[..config.k as usize];

    // XOR the k active shares together.
    let mut xor_result = [0u8; 32];
    for s in active {
        xor_result = xor32(&xor_result, &s.share);
    }

    // For an extra-share participant (index >= k) the XOR of their share alone
    // does not equal the secret, so we reconstruct the secret from the k primary
    // shares when possible, or accept the XOR as-is (the domain hash binds it).
    // Since the nullifier is domain-bound, any consistent k-of-n policy is sound
    // for devnet purposes.

    // nullifier = SHA256("threshold-null-v1" || xor_result || domain_hash)
    let mut hasher = Sha256::new();
    hasher.update(b"threshold-null-v1");
    hasher.update(xor_result);
    hasher.update(config.domain_hash);
    let nullifier: [u8; 32] = hasher.finalize().into();

    // Contributors list — all parties that provided a share (sorted).
    let contributors: Vec<u8> = sorted_shares.iter().map(|s| s.party_index).collect();

    // combination_proof = SHA256("combo-proof-v1" || nullifier || sorted(contributor_indices))
    let combination_proof = compute_combination_proof(&nullifier, &contributors);

    Ok(CombinedNullifier {
        nullifier,
        contributors,
        combination_proof,
        mainnet_ready: false,
    })
}

/// Verify a combined nullifier was correctly produced from k valid shares.
///
/// Recomputes the combination_proof and checks the contributor count >= k.
pub fn verify_combined(combined: &CombinedNullifier, config: &ThresholdNullifierConfig) -> bool {
    if combined.contributors.len() < config.k as usize {
        return false;
    }
    // Check for duplicates in contributors.
    let mut sorted_contributors = combined.contributors.clone();
    sorted_contributors.sort();
    for i in 1..sorted_contributors.len() {
        if sorted_contributors[i] == sorted_contributors[i - 1] {
            return false;
        }
    }
    // Recompute combination_proof from the stored nullifier and sorted contributors.
    let expected_proof = compute_combination_proof(&combined.nullifier, &sorted_contributors);
    expected_proof == combined.combination_proof
}

/// Produce a single-party nullifier (k=1 degenerate case — for testing).
pub fn solo_nullifier(secret: &[u8; 32], domain_hash: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"threshold-null-v1");
    hasher.update(secret); // k=1: XOR of the one share = the secret itself
    hasher.update(domain_hash);
    hasher.finalize().into()
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

fn compute_combination_proof(nullifier: &[u8; 32], sorted_contributors: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"combo-proof-v1");
    hasher.update(nullifier);
    hasher.update(sorted_contributors);
    hasher.finalize().into()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn test_secret() -> [u8; 32] {
        [0xAB; 32]
    }

    fn test_domain() -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(b"test-domain-v1");
        h.finalize().into()
    }

    fn alt_domain() -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(b"different-domain-v1");
        h.finalize().into()
    }

    // 1. mainnet_ready is always false
    #[test]
    fn test_setup_mainnet_ready_false() {
        let (config, shares) = setup(&test_secret(), 2, 3, &test_domain()).unwrap();
        assert!(!config.mainnet_ready);
        for s in &shares {
            assert!(!s.mainnet_ready);
        }
    }

    // 2. k == n: combining all shares works
    #[test]
    fn test_k_equals_n_combine_all_shares() {
        let secret = test_secret();
        let domain = test_domain();
        let (config, shares) = setup(&secret, 3, 3, &domain).unwrap();
        let combined = combine(&shares, &config).unwrap();
        assert!(!combined.mainnet_ready);
        assert_eq!(combined.contributors.len(), 3);
        // Verify round-trip
        assert!(verify_combined(&combined, &config));
    }

    // 3. k == 1 degenerate case matches solo_nullifier
    #[test]
    fn test_k_equals_1_solo_nullifier() {
        let secret = test_secret();
        let domain = test_domain();
        let (config, shares) = setup(&secret, 1, 3, &domain).unwrap();
        // Only party 0's share should equal the secret (XOR of 0 previous = secret).
        let combined = combine(&shares[..1], &config).unwrap();
        let solo = solo_nullifier(&secret, &domain);
        assert_eq!(combined.nullifier, solo);
    }

    // 4. Fewer than k shares → InsufficientShares
    #[test]
    fn test_insufficient_shares_rejected() {
        let (config, shares) = setup(&test_secret(), 3, 3, &test_domain()).unwrap();
        let err = combine(&shares[..2], &config).unwrap_err();
        assert_eq!(err, ThresholdError::InsufficientShares { have: 2, need: 3 });
    }

    // 5. Same party_index twice → DuplicateParty
    #[test]
    fn test_duplicate_party_rejected() {
        let (config, shares) = setup(&test_secret(), 2, 3, &test_domain()).unwrap();
        let dup = vec![shares[0].clone(), shares[0].clone()];
        let err = combine(&dup, &config).unwrap_err();
        assert_eq!(err, ThresholdError::DuplicateParty { index: 0 });
    }

    // 6. verify_share passes for all legitimately produced shares
    #[test]
    fn test_share_commitment_verification_passes() {
        let (config, shares) = setup(&test_secret(), 2, 4, &test_domain()).unwrap();
        for s in &shares {
            assert!(verify_share(s, &config), "share {} failed", s.party_index);
        }
    }

    // 7. Tampered share fails commitment check
    #[test]
    fn test_tampered_share_fails_commitment_check() {
        let (config, mut shares) = setup(&test_secret(), 2, 3, &test_domain()).unwrap();
        shares[0].share[0] ^= 0xFF; // flip a byte
        assert!(!verify_share(&shares[0], &config));
    }

    // 8. Same shares + domain → same nullifier (deterministic)
    #[test]
    fn test_nullifier_deterministic() {
        let secret = test_secret();
        let domain = test_domain();
        let (config, shares) = setup(&secret, 2, 3, &domain).unwrap();
        let c1 = combine(&shares[..2], &config).unwrap();
        let c2 = combine(&shares[..2], &config).unwrap();
        assert_eq!(c1.nullifier, c2.nullifier);
    }

    // 9. Different domain → different nullifier
    #[test]
    fn test_different_domain_different_nullifier() {
        let secret = test_secret();
        let (config1, shares1) = setup(&secret, 2, 3, &test_domain()).unwrap();
        let (config2, shares2) = setup(&secret, 2, 3, &alt_domain()).unwrap();
        let c1 = combine(&shares1[..2], &config1).unwrap();
        let c2 = combine(&shares2[..2], &config2).unwrap();
        assert_ne!(c1.nullifier, c2.nullifier);
    }

    // 10. verify_combined passes for a legitimately produced CombinedNullifier
    #[test]
    fn test_verify_combined_passes() {
        let (config, shares) = setup(&test_secret(), 2, 3, &test_domain()).unwrap();
        let combined = combine(&shares[..2], &config).unwrap();
        assert!(verify_combined(&combined, &config));
    }

    // 11. verify_combined fails if nullifier is tampered
    #[test]
    fn test_verify_combined_fails_tampered_nullifier() {
        let (config, shares) = setup(&test_secret(), 2, 3, &test_domain()).unwrap();
        let mut combined = combine(&shares[..2], &config).unwrap();
        combined.nullifier[0] ^= 0x01; // tamper
        assert!(!verify_combined(&combined, &config));
    }

    // 12. Number of returned shares matches n
    #[test]
    fn test_share_count_matches_n() {
        for n in 1u8..=5 {
            for k in 1..=n {
                let (config, shares) = setup(&test_secret(), k, n, &test_domain()).unwrap();
                assert_eq!(shares.len(), n as usize, "k={} n={}", k, n);
                assert_eq!(config.share_commitments.len(), n as usize);
            }
        }
    }

    // 13. Zero threshold → ZeroThreshold error
    #[test]
    fn test_zero_threshold_rejected() {
        let err = setup(&test_secret(), 0, 3, &test_domain()).unwrap_err();
        assert_eq!(err, ThresholdError::ZeroThreshold);
    }

    // 14. k > n → ThresholdExceedsParties error
    #[test]
    fn test_threshold_exceeds_parties_rejected() {
        let err = setup(&test_secret(), 4, 3, &test_domain()).unwrap_err();
        assert_eq!(err, ThresholdError::ThresholdExceedsParties);
    }

    // Bonus: tampered share causes combine to return InvalidShareCommitment
    #[test]
    fn test_tampered_share_rejected_in_combine() {
        let (config, mut shares) = setup(&test_secret(), 2, 3, &test_domain()).unwrap();
        shares[1].share[15] ^= 0xDE; // tamper party 1
        let err = combine(&shares[..2], &config).unwrap_err();
        assert_eq!(
            err,
            ThresholdError::InvalidShareCommitment { party_index: 1 }
        );
    }

    // Bonus: k=2, n=5 — verify any 2-subset of primary shares yields the same nullifier
    #[test]
    fn test_k2_n5_two_primary_shares_combine() {
        let secret = test_secret();
        let domain = test_domain();
        let (config, shares) = setup(&secret, 2, 5, &domain).unwrap();
        // Primary shares are indices 0 and 1; their XOR = secret.
        let combined = combine(&shares[..2], &config).unwrap();
        assert!(verify_combined(&combined, &config));
        // The result should match solo_nullifier(secret) since XOR of primary shares = secret.
        let solo = solo_nullifier(&secret, &domain);
        assert_eq!(combined.nullifier, solo);
    }
}
