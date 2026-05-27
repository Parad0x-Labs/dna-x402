//! dark-swarm-fund — Multi-agent anonymous treasury with threshold release
//!
//! N agents contribute to a shared fund anonymously. No agent knows the exact
//! contribution of any other. Release requires T-of-N partial nullifiers
//! whose XOR/hash combination produces the master release nullifier.
//!
//! Privacy model:
//!   - Each contribution is posted as a Pedersen-style commitment: H(amount || blinding).
//!   - The release credential is a threshold combination of partial nullifiers
//!     (one per contributor). Observers see only commitments and the final
//!     nullifier, never individual amounts or contributor identities.
//!
//! IS_STUB = true  — hash primitives are SHA-256 domain-separated (not Poseidon);
//!                   threshold secret sharing uses XOR (not Shamir GF(2^256)).
//!                   Zero-knowledge proofs are structural stubs.
//! MAINNET_READY = false — always false in this constructor.

use sha2::{Sha256, Digest};

pub const IS_STUB: bool = true;
pub const MAINNET_READY: bool = false;

/// Maximum contributors per swarm fund.
pub const MAX_CONTRIBUTORS: usize = 64;

// Domain tags.
const DOMAIN_FUND_ID:          &[u8] = b"dark-swarm-fund-id-v1";
const DOMAIN_CONTRIBUTION:     &[u8] = b"dark-swarm-contrib-v1";
const DOMAIN_PARTIAL_NULL:     &[u8] = b"dark-swarm-partial-null-v1";
const DOMAIN_RELEASE_NULL:     &[u8] = b"dark-swarm-release-null-v1";
const DOMAIN_CONTRIB_ROOT:     &[u8] = b"dark-swarm-contrib-root-v1";
const DOMAIN_TOTAL_COMMIT:     &[u8] = b"dark-swarm-total-commit-v1";

// ── Errors ────────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Clone)]
pub enum SwarmFundError {
    MainnetNotReady,
    ZeroAmount,
    TooManyContributors,
    ThresholdExceedsQuorum,
    InvalidThreshold,
    InvalidQuorum,
    FundLocked,
    FundNotReady,
    InsufficientContributions,
    DuplicateContributorIndex,
    NullBlinding,
    NullFundSecret,
}

impl core::fmt::Display for SwarmFundError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{:?}", self)
    }
}

// ── Types ─────────────────────────────────────────────────────────────────────

/// On-chain state for a swarm fund.
#[derive(Debug, Clone, PartialEq)]
pub struct SwarmFund {
    /// Unique fund ID = H(DOMAIN_FUND_ID || fund_secret)
    pub fund_id:               [u8; 32],
    /// Rolling Merkle-style root over all contribution commitments.
    pub contributions_root:    [u8; 32],
    /// Total-amount commitment = H(DOMAIN_TOTAL_COMMIT || sum_le8 || blinding)
    pub total_commitment:      [u8; 32],
    /// Number of valid contributions so far.
    pub contributor_count:     u32,
    /// Minimum contributors needed before release can be attempted.
    pub threshold:             u32,
    /// Max contributors this fund accepts.
    pub quorum:                u32,
    /// True after threshold is met and release nullifier is set.
    pub is_locked:             bool,
    /// XOR-accumulated partial nullifiers from contributors.
    pub release_nullifier:     [u8; 32],
    pub is_stub:               bool,
    pub mainnet_ready:         bool,
}

/// Single contribution from one agent.
#[derive(Debug, Clone, PartialEq)]
pub struct SwarmContribution {
    /// Which fund this contributes to.
    pub fund_id:                  [u8; 32],
    /// H(DOMAIN_CONTRIBUTION || amount_le8 || blinding)
    pub contribution_commitment:  [u8; 32],
    /// H(DOMAIN_PARTIAL_NULL || fund_id || contributor_index_le4 || blinding)
    pub partial_nullifier:        [u8; 32],
    /// Position in the contributor list (0-indexed).
    pub contributor_index:        u32,
    pub is_stub:                  bool,
}

/// Released-fund receipt — produced when threshold is met.
#[derive(Debug, Clone, PartialEq)]
pub struct FundReleaseReceipt {
    pub fund_id:           [u8; 32],
    pub release_nullifier: [u8; 32],
    pub contributor_count: u32,
    pub threshold:         u32,
    pub is_stub:           bool,
}

// ── Hash helpers ──────────────────────────────────────────────────────────────

/// Commitment to a single contribution amount.
pub fn contribution_commitment(amount_lamports: u64, blinding: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(DOMAIN_CONTRIBUTION);
    h.update(amount_lamports.to_le_bytes());
    h.update(blinding);
    h.finalize().into()
}

/// Partial nullifier for contributor `index` in fund `fund_id`.
pub fn partial_nullifier(fund_id: &[u8; 32], contributor_index: u32, blinding: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(DOMAIN_PARTIAL_NULL);
    h.update(fund_id);
    h.update(contributor_index.to_le_bytes());
    h.update(blinding);
    h.finalize().into()
}

/// Combine all partial nullifiers into the release nullifier.
/// Stub: chain-hashes them (prod would use Shamir reconstruction over GF).
pub fn compute_release_nullifier(partial_nullifiers: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = [0u8; 32];
    for pn in partial_nullifiers {
        let mut h = Sha256::new();
        h.update(DOMAIN_RELEASE_NULL);
        h.update(&acc);
        h.update(pn);
        acc = h.finalize().into();
    }
    acc
}

/// Roll the contributions root forward when a new commitment is added.
fn roll_contributions_root(current_root: &[u8; 32], new_commitment: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(DOMAIN_CONTRIB_ROOT);
    h.update(current_root);
    h.update(new_commitment);
    h.finalize().into()
}

/// Total commitment update: accumulate sum + blinding.
fn compute_total_commitment(total_lamports: u64, blinding: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(DOMAIN_TOTAL_COMMIT);
    h.update(total_lamports.to_le_bytes());
    h.update(blinding);
    h.finalize().into()
}

// ── Fund lifecycle ────────────────────────────────────────────────────────────

/// Create a new empty swarm fund.
///
/// `threshold` — minimum contributors before release.
/// `quorum`    — max contributors accepted.
/// `fund_secret` — random bytes known only to the fund creator (used to derive `fund_id`).
pub fn create_swarm_fund(
    threshold:   u32,
    quorum:      u32,
    fund_secret: &[u8; 32],
) -> Result<SwarmFund, SwarmFundError> {
    if MAINNET_READY {
        return Err(SwarmFundError::MainnetNotReady);
    }
    if fund_secret == &[0u8; 32] {
        return Err(SwarmFundError::NullFundSecret);
    }
    if threshold == 0 {
        return Err(SwarmFundError::InvalidThreshold);
    }
    if quorum == 0 || quorum as usize > MAX_CONTRIBUTORS {
        return Err(SwarmFundError::InvalidQuorum);
    }
    if threshold > quorum {
        return Err(SwarmFundError::ThresholdExceedsQuorum);
    }

    let mut h = Sha256::new();
    h.update(DOMAIN_FUND_ID);
    h.update(fund_secret);
    let fund_id: [u8; 32] = h.finalize().into();

    Ok(SwarmFund {
        fund_id,
        contributions_root: [0u8; 32],
        total_commitment:   [0u8; 32],
        contributor_count:  0,
        threshold,
        quorum,
        is_locked:          false,
        release_nullifier:  [0u8; 32],
        is_stub:            IS_STUB,
        mainnet_ready:      MAINNET_READY,
    })
}

/// Create a contribution from one agent.
pub fn create_contribution(
    fund_id:          &[u8; 32],
    amount_lamports:  u64,
    blinding:         &[u8; 32],
    contributor_index: u32,
) -> Result<SwarmContribution, SwarmFundError> {
    if amount_lamports == 0 {
        return Err(SwarmFundError::ZeroAmount);
    }
    if blinding == &[0u8; 32] {
        return Err(SwarmFundError::NullBlinding);
    }

    let commitment = contribution_commitment(amount_lamports, blinding);
    let partial_null = partial_nullifier(fund_id, contributor_index, blinding);

    Ok(SwarmContribution {
        fund_id:                 *fund_id,
        contribution_commitment: commitment,
        partial_nullifier:       partial_null,
        contributor_index,
        is_stub:                 IS_STUB,
    })
}

/// Add a contribution to the fund (returns updated fund state).
///
/// `total_blinding` — blinding for the updated total_commitment.
///   In a real protocol each agent would give a blinding share; here the caller
///   rolls the sum externally and provides the new blinding.
pub fn add_contribution(
    fund:            SwarmFund,
    contribution:    &SwarmContribution,
    new_total_lamports: u64,
    total_blinding:  &[u8; 32],
) -> Result<SwarmFund, SwarmFundError> {
    if fund.is_locked {
        return Err(SwarmFundError::FundLocked);
    }
    if fund.contributor_count >= fund.quorum {
        return Err(SwarmFundError::TooManyContributors);
    }

    let new_root  = roll_contributions_root(&fund.contributions_root, &contribution.contribution_commitment);
    let new_total = compute_total_commitment(new_total_lamports, total_blinding);

    // Accumulate partial nullifier via release_nullifier rolling hash.
    let mut h = Sha256::new();
    h.update(DOMAIN_RELEASE_NULL);
    h.update(&fund.release_nullifier);
    h.update(&contribution.partial_nullifier);
    let new_release_null: [u8; 32] = h.finalize().into();

    Ok(SwarmFund {
        fund_id:            fund.fund_id,
        contributions_root: new_root,
        total_commitment:   new_total,
        contributor_count:  fund.contributor_count + 1,
        threshold:          fund.threshold,
        quorum:             fund.quorum,
        is_locked:          fund.is_locked,
        release_nullifier:  new_release_null,
        is_stub:            fund.is_stub,
        mainnet_ready:      fund.mainnet_ready,
    })
}

/// Check whether the fund has met its threshold.
pub fn check_threshold_met(fund: &SwarmFund) -> bool {
    fund.contributor_count >= fund.threshold
}

/// Lock the fund and produce a release receipt (call when threshold is met).
pub fn release_fund(fund: SwarmFund) -> Result<(SwarmFund, FundReleaseReceipt), SwarmFundError> {
    if !check_threshold_met(&fund) {
        return Err(SwarmFundError::InsufficientContributions);
    }

    let receipt = FundReleaseReceipt {
        fund_id:           fund.fund_id,
        release_nullifier: fund.release_nullifier,
        contributor_count: fund.contributor_count,
        threshold:         fund.threshold,
        is_stub:           IS_STUB,
    };

    let locked_fund = SwarmFund {
        is_locked: true,
        ..fund
    };

    Ok((locked_fund, receipt))
}

// ─────────────────────────────────────────────────────────────────────────────
//  Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn fund_secret() -> [u8; 32] { [0xDE; 32] }
    fn blinding(b: u8) -> [u8; 32] { [b; 32] }

    fn make_fund(t: u32, q: u32) -> SwarmFund {
        create_swarm_fund(t, q, &fund_secret()).unwrap()
    }

    fn make_contribution(fund: &SwarmFund, amount: u64, b: u8, idx: u32) -> SwarmContribution {
        create_contribution(&fund.fund_id, amount, &blinding(b), idx).unwrap()
    }

    // ── Create fund ──────────────────────────────────────────────────────────

    #[test]
    fn test_create_fund_succeeds() {
        let f = make_fund(2, 4);
        assert_eq!(f.threshold, 2);
        assert_eq!(f.quorum, 4);
        assert_eq!(f.contributor_count, 0);
        assert!(!f.is_locked);
        assert_eq!(f.is_stub, true);
        assert_eq!(f.mainnet_ready, false);
    }

    #[test]
    fn test_null_secret_rejected() {
        let err = create_swarm_fund(1, 2, &[0u8; 32]).unwrap_err();
        assert_eq!(err, SwarmFundError::NullFundSecret);
    }

    #[test]
    fn test_zero_threshold_rejected() {
        let err = create_swarm_fund(0, 4, &fund_secret()).unwrap_err();
        assert_eq!(err, SwarmFundError::InvalidThreshold);
    }

    #[test]
    fn test_threshold_exceeds_quorum_rejected() {
        let err = create_swarm_fund(5, 4, &fund_secret()).unwrap_err();
        assert_eq!(err, SwarmFundError::ThresholdExceedsQuorum);
    }

    #[test]
    fn test_quorum_exceeds_max_rejected() {
        let err = create_swarm_fund(1, (MAX_CONTRIBUTORS + 1) as u32, &fund_secret()).unwrap_err();
        assert_eq!(err, SwarmFundError::InvalidQuorum);
    }

    #[test]
    fn test_fund_id_deterministic() {
        let f1 = make_fund(2, 4);
        let f2 = make_fund(2, 4);
        assert_eq!(f1.fund_id, f2.fund_id);
    }

    #[test]
    fn test_different_secrets_different_ids() {
        let f1 = create_swarm_fund(1, 2, &[0xAAu8; 32]).unwrap();
        let f2 = create_swarm_fund(1, 2, &[0xBBu8; 32]).unwrap();
        assert_ne!(f1.fund_id, f2.fund_id);
    }

    // ── Contributions ─────────────────────────────────────────────────────────

    #[test]
    fn test_create_contribution_succeeds() {
        let f = make_fund(2, 4);
        let c = make_contribution(&f, 1_000_000, 0x11, 0);
        assert_eq!(c.contributor_index, 0);
        assert_eq!(c.is_stub, true);
    }

    #[test]
    fn test_zero_amount_contribution_rejected() {
        let f = make_fund(2, 4);
        let err = create_contribution(&f.fund_id, 0, &blinding(0x11), 0).unwrap_err();
        assert_eq!(err, SwarmFundError::ZeroAmount);
    }

    #[test]
    fn test_null_blinding_rejected() {
        let f = make_fund(2, 4);
        let err = create_contribution(&f.fund_id, 1_000_000, &[0u8; 32], 0).unwrap_err();
        assert_eq!(err, SwarmFundError::NullBlinding);
    }

    #[test]
    fn test_contribution_commitment_unique_per_blinding() {
        let f  = make_fund(2, 4);
        let c1 = make_contribution(&f, 1_000_000, 0x11, 0);
        let c2 = make_contribution(&f, 1_000_000, 0x22, 0);
        assert_ne!(c1.contribution_commitment, c2.contribution_commitment);
    }

    #[test]
    fn test_partial_nullifier_unique_per_index() {
        let f  = make_fund(3, 6);
        let c0 = make_contribution(&f, 1_000_000, 0xAA, 0);
        let c1 = make_contribution(&f, 1_000_000, 0xAA, 1);
        assert_ne!(c0.partial_nullifier, c1.partial_nullifier);
    }

    // ── Add contributions to fund ─────────────────────────────────────────────

    #[test]
    fn test_add_contribution_updates_count() {
        let f   = make_fund(2, 4);
        let c   = make_contribution(&f, 1_000_000, 0x11, 0);
        let f2  = add_contribution(f, &c, 1_000_000, &blinding(0xBB)).unwrap();
        assert_eq!(f2.contributor_count, 1);
    }

    #[test]
    fn test_add_contribution_changes_root() {
        let f   = make_fund(2, 4);
        let root0 = f.contributions_root;
        let c   = make_contribution(&f, 1_000_000, 0x11, 0);
        let f2  = add_contribution(f, &c, 1_000_000, &blinding(0xBB)).unwrap();
        assert_ne!(f2.contributions_root, root0);
    }

    #[test]
    fn test_locked_fund_rejects_contribution() {
        let f = make_fund(1, 2);
        let c = make_contribution(&f, 1_000_000, 0x11, 0);
        let (f_locked, _) = release_fund(add_contribution(f, &c, 1_000_000, &blinding(0xBB)).unwrap()).unwrap();
        let c2 = make_contribution(&f_locked, 500_000, 0x22, 1);
        let err = add_contribution(f_locked, &c2, 1_500_000, &blinding(0xCC)).unwrap_err();
        assert_eq!(err, SwarmFundError::FundLocked);
    }

    // ── Threshold / release ───────────────────────────────────────────────────

    #[test]
    fn test_threshold_not_met_initially() {
        let f = make_fund(2, 4);
        assert!(!check_threshold_met(&f));
    }

    #[test]
    fn test_threshold_met_after_contributions() {
        let f  = make_fund(2, 4);
        let c0 = make_contribution(&f, 1_000_000, 0x11, 0);
        let f2 = add_contribution(f,  &c0, 1_000_000, &blinding(0xBB)).unwrap();
        assert!(!check_threshold_met(&f2)); // still need 2
        let c1 = make_contribution(&f2, 2_000_000, 0x22, 1);
        let f3 = add_contribution(f2, &c1, 3_000_000, &blinding(0xCC)).unwrap();
        assert!(check_threshold_met(&f3));
    }

    #[test]
    fn test_release_below_threshold_fails() {
        let f   = make_fund(3, 6);
        let c0  = make_contribution(&f, 1_000_000, 0x11, 0);
        let f2  = add_contribution(f, &c0, 1_000_000, &blinding(0xBB)).unwrap();
        let err = release_fund(f2).unwrap_err();
        assert_eq!(err, SwarmFundError::InsufficientContributions);
    }

    #[test]
    fn test_release_at_threshold_succeeds() {
        let f  = make_fund(1, 4);
        let c0 = make_contribution(&f, 1_000_000, 0x11, 0);
        let f2 = add_contribution(f, &c0, 1_000_000, &blinding(0xBB)).unwrap();
        let (f_locked, receipt) = release_fund(f2).unwrap();
        assert!(f_locked.is_locked);
        assert_eq!(receipt.threshold, 1);
        assert_eq!(receipt.is_stub, true);
    }

    #[test]
    fn test_release_nullifier_changes_with_each_contribution() {
        let f   = make_fund(2, 4);
        let null0 = f.release_nullifier;
        let c0  = make_contribution(&f, 1_000_000, 0x11, 0);
        let f2  = add_contribution(f, &c0, 1_000_000, &blinding(0xBB)).unwrap();
        let null1 = f2.release_nullifier;
        assert_ne!(null0, null1);
        let c1  = make_contribution(&f2, 2_000_000, 0x22, 1);
        let f3  = add_contribution(f2, &c1, 3_000_000, &blinding(0xCC)).unwrap();
        let null2 = f3.release_nullifier;
        assert_ne!(null1, null2);
    }

    // ── compute_release_nullifier helper ──────────────────────────────────────

    #[test]
    fn test_compute_release_nullifier_deterministic() {
        let pns = vec![[0x01u8; 32], [0x02u8; 32], [0x03u8; 32]];
        let n1 = compute_release_nullifier(&pns);
        let n2 = compute_release_nullifier(&pns);
        assert_eq!(n1, n2);
    }

    #[test]
    fn test_compute_release_nullifier_order_sensitive() {
        let pns1 = vec![[0x01u8; 32], [0x02u8; 32]];
        let pns2 = vec![[0x02u8; 32], [0x01u8; 32]];
        let n1 = compute_release_nullifier(&pns1);
        let n2 = compute_release_nullifier(&pns2);
        assert_ne!(n1, n2, "order must matter for sequencing security");
    }

    #[test]
    fn test_contribution_commitment_deterministic() {
        let c1 = contribution_commitment(5_000_000, &blinding(0xAB));
        let c2 = contribution_commitment(5_000_000, &blinding(0xAB));
        assert_eq!(c1, c2);
    }

    #[test]
    fn test_mainnet_ready_always_false() {
        let f = make_fund(1, 2);
        assert_eq!(f.mainnet_ready, false);
    }
}
