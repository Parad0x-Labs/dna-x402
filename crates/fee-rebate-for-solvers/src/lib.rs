use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq)]
pub struct JobCompletion {
    pub job_hash: [u8; 32],
    pub solver_hash: [u8; 32],
    pub completed_at_slot: u64,
    pub proof_hash: [u8; 32],
}

#[derive(Debug, Clone, PartialEq)]
pub struct FeeRebate {
    pub solver_hash: [u8; 32],
    pub job_hash: [u8; 32],
    pub rebate_lamports: u64,
    pub expires_at_slot: u64,
    pub receipt_hash: [u8; 32],
    pub claimed: bool,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum RebateError {
    #[error("expired")]
    Expired,
    #[error("exceeds cap")]
    ExceedsCap,
    #[error("duplicate job")]
    DuplicateJob,
    #[error("already claimed")]
    AlreadyClaimed,
}

pub fn create_rebate(
    completion: &JobCompletion,
    rebate_lamports: u64,
    cap_lamports: u64,
    expires_at_slot: u64,
) -> Result<FeeRebate, RebateError> {
    if rebate_lamports > cap_lamports {
        return Err(RebateError::ExceedsCap);
    }

    let receipt_hash = rebate_receipt_hash(completion, rebate_lamports);

    Ok(FeeRebate {
        solver_hash: completion.solver_hash,
        job_hash: completion.job_hash,
        rebate_lamports,
        expires_at_slot,
        receipt_hash,
        claimed: false,
    })
}

pub fn create_rebate_checked(
    completion: &JobCompletion,
    rebate_lamports: u64,
    cap_lamports: u64,
    expires_at_slot: u64,
    seen_jobs: &[[u8; 32]],
) -> Result<FeeRebate, RebateError> {
    if seen_jobs.contains(&completion.job_hash) {
        return Err(RebateError::DuplicateJob);
    }
    create_rebate(completion, rebate_lamports, cap_lamports, expires_at_slot)
}

pub fn claim_rebate(rebate: &mut FeeRebate, current_slot: u64) -> Result<u64, RebateError> {
    if rebate.claimed {
        return Err(RebateError::AlreadyClaimed);
    }
    if current_slot > rebate.expires_at_slot {
        return Err(RebateError::Expired);
    }
    rebate.claimed = true;
    Ok(rebate.rebate_lamports)
}

pub fn rebate_receipt_hash(completion: &JobCompletion, lamports: u64) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"rebate-receipt-v1");
    h.update(completion.job_hash);
    h.update(completion.solver_hash);
    h.update(completion.proof_hash);
    h.update(lamports.to_le_bytes());
    h.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_completion(job_id: u8) -> JobCompletion {
        let mut job_hash = [0u8; 32];
        job_hash[0] = job_id;
        JobCompletion {
            job_hash,
            solver_hash: [0xAA_u8; 32],
            completed_at_slot: 100,
            proof_hash: [0xBB_u8; 32],
        }
    }

    #[test]
    fn test_valid_job_earns_rebate() {
        let c = make_completion(1);
        let result = create_rebate(&c, 500, 1000, 9999);
        assert!(result.is_ok());
        let rebate = result.unwrap();
        assert_eq!(rebate.rebate_lamports, 500);
    }

    #[test]
    fn test_rebate_expires() {
        let c = make_completion(1);
        let mut rebate = create_rebate(&c, 500, 1000, 100).unwrap();
        let result = claim_rebate(&mut rebate, 200);
        assert_eq!(result, Err(RebateError::Expired));
    }

    #[test]
    fn test_rebate_cannot_exceed_cap() {
        let c = make_completion(1);
        let result = create_rebate(&c, 2000, 1000, 9999);
        assert_eq!(result, Err(RebateError::ExceedsCap));
    }

    #[test]
    fn test_duplicate_job_detection() {
        let c1 = make_completion(1);
        let seen = vec![c1.job_hash];
        let result = create_rebate_checked(&c1, 500, 1000, 9999, &seen);
        assert_eq!(result, Err(RebateError::DuplicateJob));
    }

    #[test]
    fn test_rebate_receipt_hash_deterministic() {
        let c = make_completion(1);
        let h1 = rebate_receipt_hash(&c, 500);
        let h2 = rebate_receipt_hash(&c, 500);
        assert_eq!(h1, h2);
        // Different lamports produce different hash
        let h3 = rebate_receipt_hash(&c, 501);
        assert_ne!(h1, h3);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_receipt_hash_nonzero() {
        let c = make_completion(1);
        assert_ne!(rebate_receipt_hash(&c, 500), [0u8; 32]);
    }

    #[test]
    fn test_receipt_hash_job_sensitive() {
        let c1 = make_completion(1);
        let c2 = make_completion(2);
        assert_ne!(rebate_receipt_hash(&c1, 500), rebate_receipt_hash(&c2, 500));
    }

    #[test]
    fn test_rebate_unclaimed_initially() {
        let c = make_completion(1);
        let rebate = create_rebate(&c, 500, 1000, 9999).unwrap();
        assert!(!rebate.claimed);
    }

    #[test]
    fn test_claim_at_exact_expiry_succeeds() {
        // slot == expires_at_slot: condition is (slot > expires_at_slot) → false → ok
        let c = make_completion(1);
        let mut rebate = create_rebate(&c, 500, 1000, 100).unwrap();
        let result = claim_rebate(&mut rebate, 100);
        assert_eq!(result, Ok(500));
    }

    #[test]
    fn test_claim_rebate_returns_lamports() {
        let c = make_completion(1);
        let mut rebate = create_rebate(&c, 750, 1000, 9999).unwrap();
        assert_eq!(claim_rebate(&mut rebate, 50).unwrap(), 750);
    }

    #[test]
    fn test_claim_twice_fails() {
        let c = make_completion(1);
        let mut rebate = create_rebate(&c, 500, 1000, 9999).unwrap();
        claim_rebate(&mut rebate, 50).unwrap();
        assert_eq!(
            claim_rebate(&mut rebate, 50),
            Err(RebateError::AlreadyClaimed)
        );
    }

    #[test]
    fn test_rebate_at_cap_allowed() {
        // rebate_lamports == cap_lamports: condition is > cap → false → ok
        let c = make_completion(1);
        let result = create_rebate(&c, 1000, 1000, 9999);
        assert!(result.is_ok());
    }

    #[test]
    fn test_new_job_passes_checked() {
        let c = make_completion(5);
        let seen: Vec<[u8; 32]> = vec![];
        let result = create_rebate_checked(&c, 300, 1000, 9999, &seen);
        assert!(result.is_ok());
    }

    #[test]
    fn test_solver_hash_in_rebate() {
        let c = make_completion(1);
        let rebate = create_rebate(&c, 500, 1000, 9999).unwrap();
        assert_eq!(rebate.solver_hash, c.solver_hash);
    }

    #[test]
    fn test_rebate_expires_at_slot_preserved() {
        let c = make_completion(1);
        let rebate = create_rebate(&c, 500, 1000, 54321).unwrap();
        assert_eq!(rebate.expires_at_slot, 54321);
    }

    #[test]
    fn test_rebate_lamports_preserved_in_struct() {
        let c = make_completion(1);
        let rebate = create_rebate(&c, 777, 1000, 9999).unwrap();
        assert_eq!(rebate.rebate_lamports, 777);
    }
}
