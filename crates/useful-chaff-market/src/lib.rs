use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ChaffJobKind {
    CloseExpired,
    CompactRoot,
    RefreshHeatmap,
    RotateEpoch,
    FillShapePool,
    HealShard,
    SettleAbandonedSession,
}

impl ChaffJobKind {
    pub fn kind_byte(&self) -> u8 {
        match self {
            ChaffJobKind::CloseExpired => 0,
            ChaffJobKind::CompactRoot => 1,
            ChaffJobKind::RefreshHeatmap => 2,
            ChaffJobKind::RotateEpoch => 3,
            ChaffJobKind::FillShapePool => 4,
            ChaffJobKind::HealShard => 5,
            ChaffJobKind::SettleAbandonedSession => 6,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChaffMarketJob {
    pub job_hash: [u8; 32],
    pub kind: ChaffJobKind,
    pub maintenance_value_lamports: u64,
    pub privacy_cover_score: f64,
    pub reward_lamports: u64,
    pub required_shape_class_hash: [u8; 32],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChaffReceipt {
    pub job_hash: [u8; 32],
    pub shape_class_hash: [u8; 32],
    pub maintenance_done: bool,
    pub receipt_hash: [u8; 32],
}

#[derive(Debug, PartialEq)]
pub enum ChaffError {
    UselessChaff,
    RewardExceedsCap,
    WrongShape,
}

pub fn create_chaff_job(
    kind: ChaffJobKind,
    maintenance_value: u64,
    privacy_score: f64,
    shape_class_hash: [u8; 32],
) -> Result<ChaffMarketJob, ChaffError> {
    if maintenance_value == 0 {
        return Err(ChaffError::UselessChaff);
    }

    let mut h = Sha256::new();
    h.update(b"chaff_market_job_v1");
    h.update([kind.kind_byte()]);
    h.update(maintenance_value.to_le_bytes());
    let job_hash: [u8; 32] = h.finalize().into();

    let reward_lamports = (maintenance_value as f64 * privacy_score) as u64;

    Ok(ChaffMarketJob {
        job_hash,
        kind,
        maintenance_value_lamports: maintenance_value,
        privacy_cover_score: privacy_score,
        reward_lamports,
        required_shape_class_hash: shape_class_hash,
    })
}

pub fn execute_job_mock(
    job: &ChaffMarketJob,
    submitted_shape_hash: [u8; 32],
) -> Result<ChaffReceipt, ChaffError> {
    if submitted_shape_hash != job.required_shape_class_hash {
        return Err(ChaffError::WrongShape);
    }

    let mut h = Sha256::new();
    h.update(b"chaff_receipt_v1");
    h.update(job.job_hash);
    h.update(submitted_shape_hash);
    let receipt_hash: [u8; 32] = h.finalize().into();

    Ok(ChaffReceipt {
        job_hash: job.job_hash,
        shape_class_hash: submitted_shape_hash,
        maintenance_done: true,
        receipt_hash,
    })
}

pub fn rank_jobs(jobs: &[ChaffMarketJob]) -> Vec<usize> {
    let mut indices: Vec<usize> = (0..jobs.len()).collect();
    indices.sort_by(|&a, &b| {
        let score_a = jobs[a].reward_lamports + (jobs[a].privacy_cover_score * 1000.0) as u64;
        let score_b = jobs[b].reward_lamports + (jobs[b].privacy_cover_score * 1000.0) as u64;
        score_b.cmp(&score_a)
    });
    indices
}

pub fn reject_useless_chaff(maintenance_value: u64) -> Result<(), ChaffError> {
    if maintenance_value == 0 {
        return Err(ChaffError::UselessChaff);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shape() -> [u8; 32] {
        [0xC1u8; 32]
    }

    #[test]
    fn test_useless_chaff_rejected() {
        let result = create_chaff_job(ChaffJobKind::CompactRoot, 0, 0.8, shape());
        assert!(matches!(result, Err(ChaffError::UselessChaff)));
    }

    #[test]
    fn test_highest_combined_score_ranked_first() {
        let j1 = create_chaff_job(ChaffJobKind::CompactRoot, 1000, 0.5, shape()).unwrap();
        let j2 = create_chaff_job(ChaffJobKind::HealShard, 5000, 0.9, shape()).unwrap();
        let jobs = vec![j1, j2];
        let ranked = rank_jobs(&jobs);
        assert_eq!(ranked[0], 1); // j2 has higher score
    }

    #[test]
    fn test_wrong_shape_rejected_in_execute() {
        let job = create_chaff_job(ChaffJobKind::CompactRoot, 1000, 0.5, shape()).unwrap();
        let wrong = [0xFFu8; 32];
        assert!(matches!(
            execute_job_mock(&job, wrong),
            Err(ChaffError::WrongShape)
        ));
    }

    #[test]
    fn test_maintenance_receipt_generated() {
        let job = create_chaff_job(ChaffJobKind::FillShapePool, 2000, 0.7, shape()).unwrap();
        let receipt = execute_job_mock(&job, shape()).unwrap();
        assert!(receipt.maintenance_done);
        assert_eq!(receipt.job_hash, job.job_hash);
    }

    #[test]
    fn test_reward_scales_with_maintenance_value() {
        let j1 = create_chaff_job(ChaffJobKind::CompactRoot, 1000, 0.5, shape()).unwrap();
        let j2 = create_chaff_job(ChaffJobKind::CompactRoot, 4000, 0.5, shape()).unwrap();
        assert!(j2.reward_lamports > j1.reward_lamports);
    }

    #[test]
    fn test_job_hash_deterministic() {
        let j1 = create_chaff_job(ChaffJobKind::CompactRoot, 1000, 0.5, shape()).unwrap();
        let j2 = create_chaff_job(ChaffJobKind::CompactRoot, 1000, 0.5, shape()).unwrap();
        assert_eq!(j1.job_hash, j2.job_hash);
    }
}
