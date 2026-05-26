use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum PuzzleMethod {
    ShardAscii,
    AltOrderCipher,
    ChaffConstellation,
    CouponNonceCipher,
}

impl PuzzleMethod {
    pub fn method_byte(&self) -> u8 {
        match self {
            PuzzleMethod::ShardAscii => 0,
            PuzzleMethod::AltOrderCipher => 1,
            PuzzleMethod::ChaffConstellation => 2,
            PuzzleMethod::CouponNonceCipher => 3,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PuzzleJob {
    pub job_id: [u8; 32],
    pub message_hash: [u8; 32],
    pub message_len: u32,
    pub method: PuzzleMethod,
    pub reward_lamports: u64,
    pub expires_at_slot: u64,
    pub solution_commitment: [u8; 32],
    pub claimed: bool,
}

#[derive(Debug, PartialEq)]
pub enum PuzzleError {
    Expired,
    DuplicateSolution,
    WrongSolution,
    AlreadyClaimed,
}

pub fn create_puzzle_job(
    message: &str,
    method: PuzzleMethod,
    reward_lamports: u64,
    expires_at_slot: u64,
) -> PuzzleJob {
    let mut mh = Sha256::new();
    mh.update(message.as_bytes());
    let message_hash: [u8; 32] = mh.finalize().into();

    let mut sc = Sha256::new();
    sc.update(b"puzzle_solution_commitment_v1");
    sc.update(message_hash);
    sc.update([method.method_byte()]);
    let solution_commitment: [u8; 32] = sc.finalize().into();

    let mut jh = Sha256::new();
    jh.update(b"ritual_puzzle_job_v1");
    jh.update(message_hash);
    jh.update(reward_lamports.to_le_bytes());
    let job_id: [u8; 32] = jh.finalize().into();

    PuzzleJob {
        job_id,
        message_hash,
        message_len: message.len() as u32,
        method,
        reward_lamports,
        expires_at_slot,
        solution_commitment,
        claimed: false,
    }
}

pub fn submit_solution(
    job: &mut PuzzleJob,
    solution_hash: [u8; 32],
    current_slot: u64,
) -> Result<u64, PuzzleError> {
    if current_slot > job.expires_at_slot {
        return Err(PuzzleError::Expired);
    }
    if job.claimed {
        return Err(PuzzleError::AlreadyClaimed);
    }
    if solution_hash != job.solution_commitment {
        return Err(PuzzleError::WrongSolution);
    }
    job.claimed = true;
    Ok(job.reward_lamports)
}

pub fn generate_public_thread(job: &PuzzleJob) -> String {
    let id_hex: String = job
        .job_id
        .iter()
        .take(4)
        .map(|b| format!("{:02x}", b))
        .collect();
    let method_name = match job.method {
        PuzzleMethod::ShardAscii => "ShardAscii",
        PuzzleMethod::AltOrderCipher => "AltOrderCipher",
        PuzzleMethod::ChaffConstellation => "ChaffConstellation",
        PuzzleMethod::CouponNonceCipher => "CouponNonceCipher",
    };
    format!(
        "PuzzleJob(id={}..., len={}, method={}, reward={}, claimed={})",
        id_hex, job.message_len, method_name, job.reward_lamports, job.claimed,
    )
}

/// Build the correct solution hash for ShardAscii method (method_byte=0x00).
pub fn build_correct_solution(job: &PuzzleJob) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"puzzle_solution_commitment_v1");
    h.update(job.message_hash);
    h.update([0x00u8]); // ShardAscii byte
    h.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_puzzle_job() {
        let job = create_puzzle_job("CASH", PuzzleMethod::ShardAscii, 50_000, 100_000);
        assert_eq!(job.message_len, 4);
        assert_eq!(job.reward_lamports, 50_000);
        assert!(!job.claimed);
    }

    #[test]
    fn test_correct_solution_accepted() {
        let mut job = create_puzzle_job("CASH", PuzzleMethod::ShardAscii, 50_000, 100_000);
        let correct = build_correct_solution(&job);
        let reward = submit_solution(&mut job, correct, 50_000).unwrap();
        assert_eq!(reward, 50_000);
        assert!(job.claimed);
    }

    #[test]
    fn test_wrong_solution_rejected() {
        let mut job = create_puzzle_job("CASH", PuzzleMethod::ShardAscii, 50_000, 100_000);
        let wrong = [0xFFu8; 32];
        assert_eq!(
            submit_solution(&mut job, wrong, 50_000),
            Err(PuzzleError::WrongSolution)
        );
    }

    #[test]
    fn test_expired_puzzle_rejected() {
        let mut job = create_puzzle_job("CASH", PuzzleMethod::ShardAscii, 50_000, 100);
        let correct = build_correct_solution(&job);
        assert_eq!(
            submit_solution(&mut job, correct, 200),
            Err(PuzzleError::Expired)
        );
    }

    #[test]
    fn test_already_claimed_rejected() {
        let mut job = create_puzzle_job("CASH", PuzzleMethod::ShardAscii, 50_000, 100_000);
        let correct = build_correct_solution(&job);
        assert!(submit_solution(&mut job, correct, 50_000).is_ok());
        assert_eq!(
            submit_solution(&mut job, correct, 50_000),
            Err(PuzzleError::AlreadyClaimed)
        );
    }

    #[test]
    fn test_public_thread_no_secret_message() {
        let job = create_puzzle_job("CASH", PuzzleMethod::ShardAscii, 50_000, 100_000);
        let thread = generate_public_thread(&job);
        assert!(!thread.contains("CASH"));
        assert!(thread.contains("ShardAscii"));
        assert!(thread.contains("50000"));
    }
}
