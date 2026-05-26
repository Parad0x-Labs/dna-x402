use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Private domain-hashing helper
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
// ChaffJobKind
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ChaffJobKind {
    CloseExpiredAccount,
    RefreshFeeHeatmap,
    RotateEpoch,
    CompactReceiptRoot,
    UpdatePuzzle,
    CleanSession,
}

impl ChaffJobKind {
    /// Base reward in lamports for this job kind.
    pub fn base_reward(&self) -> u64 {
        match self {
            Self::CloseExpiredAccount => 10_000, // rent reclaim
            Self::RefreshFeeHeatmap => 5_000,
            Self::RotateEpoch => 8_000,
            Self::CompactReceiptRoot => 12_000,
            Self::UpdatePuzzle => 6_000,
            Self::CleanSession => 7_000,
        }
    }

    /// Privacy cover score contribution (0.0 to 1.0).
    pub fn cover_score(&self) -> f32 {
        match self {
            Self::CloseExpiredAccount => 0.8,
            Self::RefreshFeeHeatmap => 0.6,
            Self::RotateEpoch => 0.9,
            Self::CompactReceiptRoot => 0.7,
            Self::UpdatePuzzle => 0.5,
            Self::CleanSession => 0.75,
        }
    }
}

// ---------------------------------------------------------------------------
// UsefulChaffJob
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct UsefulChaffJob {
    pub kind: ChaffJobKind,
    /// Hash of the account/state being maintained. [0;32] is invalid.
    pub maintenance_target_hash: [u8; 32],
    /// Expected reward in lamports.
    pub expected_reward_lamports: u64,
    /// Privacy cover score from 0.0 to 1.0.
    pub privacy_cover_score: f32,
    /// Hash binding the expected output of this job.
    pub job_hash: [u8; 32],
}

impl UsefulChaffJob {
    pub fn new(kind: ChaffJobKind, maintenance_target_hash: [u8; 32]) -> Self {
        let expected_reward = kind.base_reward();
        let cover = kind.cover_score();
        let job_hash = sha256_domain(
            b"dark_null_v1_chaff_job",
            &[
                &[kind.base_reward().to_le_bytes()[0]], // simplified
                maintenance_target_hash.as_ref(),
            ],
        );
        Self {
            kind,
            maintenance_target_hash,
            expected_reward_lamports: expected_reward,
            privacy_cover_score: cover,
            job_hash,
        }
    }
}

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ChaffReward {
    pub lamports: u64,
    pub coupon_hash: Option<[u8; 32]>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ChaffCoverScore(pub f32);

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ChaffMarket {
    pub jobs: Vec<UsefulChaffJob>,
}

// ---------------------------------------------------------------------------
// ChaffError
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChaffError {
    ZeroMaintenanceTarget,
    ZeroReward,
    EmptyMarket,
    RewardMismatch { expected: u64, claimed: u64 },
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/// Check whether a job is valid (non-zero maintenance target, non-zero reward).
pub fn job_is_valid(job: &UsefulChaffJob) -> Result<(), ChaffError> {
    if job.maintenance_target_hash == [0u8; 32] {
        return Err(ChaffError::ZeroMaintenanceTarget);
    }
    if job.expected_reward_lamports == 0 {
        return Err(ChaffError::ZeroReward);
    }
    Ok(())
}

/// Select the job with the highest `expected_reward_lamports`.
/// Filters invalid jobs first. Returns `Err(EmptyMarket)` if no valid jobs remain.
pub fn best_job(market: &ChaffMarket) -> Result<&UsefulChaffJob, ChaffError> {
    if market.jobs.is_empty() {
        return Err(ChaffError::EmptyMarket);
    }
    let best = market
        .jobs
        .iter()
        .filter(|j| job_is_valid(j).is_ok())
        .max_by_key(|j| j.expected_reward_lamports);
    best.ok_or(ChaffError::EmptyMarket)
}

/// Compute the privacy cover score for a job.
pub fn compute_cover_score(job: &UsefulChaffJob) -> ChaffCoverScore {
    ChaffCoverScore(job.privacy_cover_score)
}

/// Verify that a claimed reward matches the job's expected reward.
pub fn verify_reward_claim(
    job: &UsefulChaffJob,
    claimed_reward_lamports: u64,
) -> Result<(), ChaffError> {
    if claimed_reward_lamports != job.expected_reward_lamports {
        return Err(ChaffError::RewardMismatch {
            expected: job.expected_reward_lamports,
            claimed: claimed_reward_lamports,
        });
    }
    Ok(())
}

/// Estimate the rent reclaimed by a `CloseExpiredAccount` job (always > 0 for valid jobs).
///
/// For `CloseExpiredAccount`: returns `expected_reward_lamports` (that IS the rent reclaim).
/// For all other kinds: returns 0.
pub fn estimate_rent_reclaimed(job: &UsefulChaffJob) -> u64 {
    match job.kind {
        ChaffJobKind::CloseExpiredAccount => job.expected_reward_lamports,
        _ => 0,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_job(kind: ChaffJobKind) -> UsefulChaffJob {
        UsefulChaffJob::new(kind, [0xABu8; 32])
    }

    // 1. Job with maintenance_target_hash=[0;32] is rejected.
    #[test]
    fn test_zero_maintenance_target_rejected() {
        let mut job = make_job(ChaffJobKind::CloseExpiredAccount);
        job.maintenance_target_hash = [0u8; 32];
        let result = job_is_valid(&job);
        assert!(matches!(result, Err(ChaffError::ZeroMaintenanceTarget)));
    }

    // 2. best_job returns the highest-reward job.
    #[test]
    fn test_best_job_returns_highest_reward() {
        let market = ChaffMarket {
            jobs: vec![
                make_job(ChaffJobKind::CompactReceiptRoot), // 12_000
                make_job(ChaffJobKind::CleanSession),       // 7_000
            ],
        };
        let best = best_job(&market).expect("should find a best job");
        assert_eq!(best.kind, ChaffJobKind::CompactReceiptRoot);
        assert_eq!(best.expected_reward_lamports, 12_000);
    }

    // 3. estimate_rent_reclaimed > 0 for CloseExpiredAccount.
    #[test]
    fn test_rent_reclaimed_positive_for_close() {
        let job = make_job(ChaffJobKind::CloseExpiredAccount);
        assert!(estimate_rent_reclaimed(&job) > 0);
    }

    // 4. estimate_rent_reclaimed == 0 for non-CloseExpiredAccount.
    #[test]
    fn test_rent_reclaimed_zero_for_non_close() {
        let job = make_job(ChaffJobKind::RefreshFeeHeatmap);
        assert_eq!(estimate_rent_reclaimed(&job), 0);
    }

    // 5. RotateEpoch has the highest cover score (0.9).
    #[test]
    fn test_cover_score_computed() {
        let job = make_job(ChaffJobKind::RotateEpoch);
        let score = compute_cover_score(&job);
        // Use approximate equality for f32.
        assert!((score.0 - 0.9).abs() < 1e-6);
    }

    // 6. Claimed reward matching expected reward is Ok.
    #[test]
    fn test_reward_claim_verified() {
        let job = make_job(ChaffJobKind::CompactReceiptRoot);
        assert!(verify_reward_claim(&job, 12_000).is_ok());
    }

    // 7. Claimed reward differing from expected is Err(RewardMismatch).
    #[test]
    fn test_reward_cannot_be_faked() {
        let job = make_job(ChaffJobKind::CompactReceiptRoot);
        let result = verify_reward_claim(&job, 99_999);
        assert!(matches!(
            result,
            Err(ChaffError::RewardMismatch {
                expected: 12_000,
                claimed: 99_999
            })
        ));
    }

    // 8. Two jobs with same kind but different maintenance_target_hash have different job_hash.
    #[test]
    fn test_job_hash_binds_target() {
        let job_a = UsefulChaffJob::new(ChaffJobKind::RotateEpoch, [0xAAu8; 32]);
        let job_b = UsefulChaffJob::new(ChaffJobKind::RotateEpoch, [0xBBu8; 32]);
        assert_ne!(job_a.job_hash, job_b.job_hash);
    }

    // 9. best_job on an empty ChaffMarket returns Err(EmptyMarket).
    #[test]
    fn test_empty_market_rejected() {
        let market = ChaffMarket { jobs: vec![] };
        let result = best_job(&market);
        assert!(matches!(result, Err(ChaffError::EmptyMarket)));
    }

    // Bonus: best_job on a market where ALL jobs are invalid (zero target) → EmptyMarket.
    #[test]
    fn test_best_job_all_invalid_returns_empty_market() {
        let mut job = make_job(ChaffJobKind::UpdatePuzzle);
        job.maintenance_target_hash = [0u8; 32]; // invalid
        let market = ChaffMarket { jobs: vec![job] };
        let result = best_job(&market);
        assert!(matches!(result, Err(ChaffError::EmptyMarket)));
    }
}
