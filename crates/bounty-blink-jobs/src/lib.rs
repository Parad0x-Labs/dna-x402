use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum JobKind {
    CloseExpiredAccount,
    CompileRitualPuzzle,
    FillShapePool,
    RevealAlphaCapsule,
    SubmitNullifier,
    RefreshFeeHeatmap,
    CompactReceiptRoot,
    VerifySessionRoot,
}

impl JobKind {
    pub fn kind_byte(&self) -> u8 {
        match self {
            JobKind::CloseExpiredAccount => 0,
            JobKind::CompileRitualPuzzle => 1,
            JobKind::FillShapePool => 2,
            JobKind::RevealAlphaCapsule => 3,
            JobKind::SubmitNullifier => 4,
            JobKind::RefreshFeeHeatmap => 5,
            JobKind::CompactReceiptRoot => 6,
            JobKind::VerifySessionRoot => 7,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BountyBlinkJob {
    pub job_id: [u8; 32],
    pub kind: JobKind,
    pub reward_lamports: u64,
    pub expires_at_slot: u64,
    pub required_proof_hash: [u8; 32],
    pub public_title: String,
    pub public_description_hash: [u8; 32],
    pub action_url_hash: [u8; 32],
    pub claimed: bool,
    pub completed: bool,
}

#[derive(Debug, PartialEq)]
pub enum JobError {
    Expired,
    AlreadyClaimed,
    AlreadyCompleted,
    WrongProof,
    RawSecretInTitle,
}

pub fn create_job(
    kind: JobKind,
    reward_lamports: u64,
    expires_at_slot: u64,
    proof_hash: [u8; 32],
    title: &str,
) -> Result<BountyBlinkJob, JobError> {
    let title_lower = title.to_lowercase();
    if title_lower.contains("http")
        || title_lower.contains("secret")
        || title_lower.contains("key")
        || title_lower.contains('@')
    {
        return Err(JobError::RawSecretInTitle);
    }

    let mut h = Sha256::new();
    h.update(b"bounty_blink_job_v1");
    h.update([kind.kind_byte()]);
    h.update(reward_lamports.to_le_bytes());
    h.update(proof_hash);
    let job_id: [u8; 32] = h.finalize().into();

    let mut desc_h = Sha256::new();
    desc_h.update(b"desc:");
    desc_h.update(title.as_bytes());
    let public_description_hash: [u8; 32] = desc_h.finalize().into();

    let mut url_h = Sha256::new();
    url_h.update(b"action_url:");
    url_h.update(job_id);
    let action_url_hash: [u8; 32] = url_h.finalize().into();

    Ok(BountyBlinkJob {
        job_id,
        kind,
        reward_lamports,
        expires_at_slot,
        required_proof_hash: proof_hash,
        public_title: title.to_string(),
        public_description_hash,
        action_url_hash,
        claimed: false,
        completed: false,
    })
}

pub fn claim_job(job: &mut BountyBlinkJob, current_slot: u64) -> Result<(), JobError> {
    if current_slot > job.expires_at_slot {
        return Err(JobError::Expired);
    }
    if job.claimed {
        return Err(JobError::AlreadyClaimed);
    }
    job.claimed = true;
    Ok(())
}

pub fn complete_job(job: &mut BountyBlinkJob, submitted_proof: [u8; 32]) -> Result<u64, JobError> {
    if job.completed {
        return Err(JobError::AlreadyCompleted);
    }
    if submitted_proof != job.required_proof_hash {
        return Err(JobError::WrongProof);
    }
    job.completed = true;
    Ok(job.reward_lamports)
}

pub fn job_hash(job: &BountyBlinkJob) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(job.job_id);
    h.update(job.reward_lamports.to_le_bytes());
    h.update(job.required_proof_hash);
    h.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proof() -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(b"test_proof");
        h.finalize().into()
    }

    #[test]
    fn test_create_job_succeeds() {
        let job = create_job(
            JobKind::CloseExpiredAccount,
            5_000,
            100_000,
            proof(),
            "Close expired PDA",
        );
        assert!(job.is_ok());
        let j = job.unwrap();
        assert_eq!(j.reward_lamports, 5_000);
        assert!(!j.claimed);
        assert!(!j.completed);
    }

    #[test]
    fn test_expired_job_rejected() {
        let mut job = create_job(
            JobKind::CloseExpiredAccount,
            5_000,
            100,
            proof(),
            "Close expired PDA",
        )
        .unwrap();
        assert_eq!(claim_job(&mut job, 200), Err(JobError::Expired));
    }

    #[test]
    fn test_duplicate_claim_rejected() {
        let mut job = create_job(
            JobKind::CloseExpiredAccount,
            5_000,
            100_000,
            proof(),
            "Close expired PDA",
        )
        .unwrap();
        assert!(claim_job(&mut job, 50_000).is_ok());
        assert_eq!(claim_job(&mut job, 50_000), Err(JobError::AlreadyClaimed));
    }

    #[test]
    fn test_already_completed_rejected() {
        let mut job = create_job(
            JobKind::CompileRitualPuzzle,
            5_000,
            100_000,
            proof(),
            "Compile ritual puzzle",
        )
        .unwrap();
        assert!(complete_job(&mut job, proof()).is_ok());
        assert_eq!(
            complete_job(&mut job, proof()),
            Err(JobError::AlreadyCompleted)
        );
    }

    #[test]
    fn test_wrong_proof_rejected() {
        let mut job = create_job(
            JobKind::FillShapePool,
            5_000,
            100_000,
            proof(),
            "Fill shape pool",
        )
        .unwrap();
        let bad_proof = [0xAAu8; 32];
        assert_eq!(complete_job(&mut job, bad_proof), Err(JobError::WrongProof));
    }

    #[test]
    fn test_correct_proof_pays_once() {
        let mut job = create_job(
            JobKind::CompactReceiptRoot,
            7_500,
            100_000,
            proof(),
            "Compact receipt root",
        )
        .unwrap();
        let reward = complete_job(&mut job, proof()).unwrap();
        assert_eq!(reward, 7_500);
        assert!(job.completed);
    }

    #[test]
    fn test_raw_url_in_title_rejected() {
        let result = create_job(
            JobKind::SubmitNullifier,
            1_000,
            100_000,
            proof(),
            "http://malicious.example.com/exploit",
        );
        assert!(matches!(result, Err(JobError::RawSecretInTitle)));
    }
}
