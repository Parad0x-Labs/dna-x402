use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq)]
pub enum JobKind {
    CloseExpiredChaff,
    SolveRitualMessage,
    RevealAlphaCapsule,
    VerifyReceiptRoot,
    RefreshFeeWeather,
    FillShapePool,
}

#[derive(Debug, Clone)]
pub struct Job {
    pub job_hash: [u8; 32],
    pub kind: JobKind,
    pub proof_requirement_hash: [u8; 32],
    pub reward_lamports: u64,
    pub poster_hash: [u8; 32],
    pub open: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct JobCompletion {
    pub job_hash: [u8; 32],
    pub worker_hash: [u8; 32],
    pub proof_hash: [u8; 32],
    pub completion_receipt_hash: [u8; 32],
}

#[derive(Debug, Clone, PartialEq)]
pub enum JobError {
    JobClosed,
    InvalidProof,
    WrongWorker,
}

fn kind_byte(kind: &JobKind) -> u8 {
    match kind {
        JobKind::CloseExpiredChaff => 0,
        JobKind::SolveRitualMessage => 1,
        JobKind::RevealAlphaCapsule => 2,
        JobKind::VerifyReceiptRoot => 3,
        JobKind::RefreshFeeWeather => 4,
        JobKind::FillShapePool => 5,
    }
}

pub fn post_job(
    kind: JobKind,
    proof_requirement_hash: &[u8; 32],
    reward_lamports: u64,
    poster_hash: &[u8; 32],
) -> Job {
    let mut hasher = Sha256::new();
    hasher.update(b"job-v1");
    hasher.update([kind_byte(&kind)]);
    hasher.update(proof_requirement_hash);
    hasher.update(reward_lamports.to_le_bytes());
    hasher.update(poster_hash);
    let job_hash: [u8; 32] = hasher.finalize().into();

    Job {
        job_hash,
        kind,
        proof_requirement_hash: *proof_requirement_hash,
        reward_lamports,
        poster_hash: *poster_hash,
        open: true,
    }
}

pub fn complete_job(
    job: &mut Job,
    worker_hash: &[u8; 32],
    submitted_proof_hash: &[u8; 32],
) -> Result<JobCompletion, JobError> {
    if !job.open {
        return Err(JobError::JobClosed);
    }
    if submitted_proof_hash != &job.proof_requirement_hash {
        return Err(JobError::InvalidProof);
    }

    let mut hasher = Sha256::new();
    hasher.update(b"completion-receipt-v1");
    hasher.update(job.job_hash);
    hasher.update(worker_hash);
    hasher.update(submitted_proof_hash);
    let completion_receipt_hash: [u8; 32] = hasher.finalize().into();

    job.open = false;

    Ok(JobCompletion {
        job_hash: job.job_hash,
        worker_hash: *worker_hash,
        proof_hash: *submitted_proof_hash,
        completion_receipt_hash,
    })
}

pub fn blink_url_for_job(job: &Job, base_url: &str) -> String {
    let hex_hash: String = job.job_hash.iter().map(|b| format!("{:02x}", b)).collect();
    format!("{}/job/{}", base_url, hex_hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_hash(seed: u8) -> [u8; 32] {
        let mut h = [0u8; 32];
        h[0] = seed;
        h
    }

    fn make_job() -> Job {
        post_job(
            JobKind::FillShapePool,
            &dummy_hash(10),
            100_000,
            &dummy_hash(99),
        )
    }

    #[test]
    fn test_job_posted_correctly() {
        let job = make_job();
        assert!(job.open);
        assert_eq!(job.kind, JobKind::FillShapePool);
        assert_eq!(job.reward_lamports, 100_000);
    }

    #[test]
    fn test_job_completion_closes_job() {
        let mut job = make_job();
        let worker = dummy_hash(7);
        let result = complete_job(&mut job, &worker, &dummy_hash(10));
        assert!(result.is_ok());
        assert!(!job.open, "job should be closed after completion");
    }

    #[test]
    fn test_closed_job_rejected() {
        let mut job = make_job();
        let worker = dummy_hash(7);
        let _ = complete_job(&mut job, &worker, &dummy_hash(10));
        let result = complete_job(&mut job, &worker, &dummy_hash(10));
        assert_eq!(result, Err(JobError::JobClosed));
    }

    #[test]
    fn test_invalid_proof_rejected() {
        let mut job = make_job();
        let worker = dummy_hash(7);
        let wrong_proof = dummy_hash(99);
        let result = complete_job(&mut job, &worker, &wrong_proof);
        assert_eq!(result, Err(JobError::InvalidProof));
    }

    #[test]
    fn test_completion_receipt_hash_deterministic() {
        let mut job1 = make_job();
        let mut job2 = make_job();
        let worker = dummy_hash(7);
        let c1 = complete_job(&mut job1, &worker, &dummy_hash(10)).unwrap();
        let c2 = complete_job(&mut job2, &worker, &dummy_hash(10)).unwrap();
        assert_eq!(c1.completion_receipt_hash, c2.completion_receipt_hash);
    }

    #[test]
    fn test_blink_url_contains_job_hash() {
        let job = make_job();
        let url = blink_url_for_job(&job, "https://blinks.darknull.xyz");
        let hex_hash: String = job.job_hash.iter().map(|b| format!("{:02x}", b)).collect();
        assert!(url.contains(&hex_hash), "URL should contain job hash hex");
        assert!(url.starts_with("https://blinks.darknull.xyz/job/"));
    }
}
