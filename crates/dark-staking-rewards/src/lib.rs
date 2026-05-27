use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RewardPool {
    pub pool_id: [u8; 32],
    pub validator_hash: [u8; 32],
    pub total_rewards: u64,
    pub distributed: u64,
    pub epoch: u64,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RewardClaim {
    pub claim_id: [u8; 32],
    pub staker_hash: [u8; 32],
    pub amount: u64,
    pub epoch: u64,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum RewardError {
    ZeroValidatorSecret,
    ZeroStakerSecret,
    ZeroRewards,
    InsufficientRewards { available: u64, requested: u64 },
    AlreadyClaimed,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn hex32(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn create_pool(
    validator_secret: &[u8; 32],
    total_rewards: u64,
    epoch: u64,
) -> Result<RewardPool, RewardError> {
    if validator_secret == &[0u8; 32] {
        return Err(RewardError::ZeroValidatorSecret);
    }
    if total_rewards == 0 {
        return Err(RewardError::ZeroRewards);
    }
    let validator_hash = sha256_multi(&[b"reward-validator-v1", validator_secret]);
    let pool_id = sha256_multi(&[
        b"reward-pool-v1",
        &validator_hash,
        &epoch.to_le_bytes(),
        &total_rewards.to_le_bytes(),
    ]);
    Ok(RewardPool {
        pool_id,
        validator_hash,
        total_rewards,
        distributed: 0,
        epoch,
        mainnet_ready: false,
    })
}

pub fn claim_reward(
    pool: &mut RewardPool,
    staker_secret: &[u8; 32],
    amount: u64,
) -> Result<RewardClaim, RewardError> {
    if staker_secret == &[0u8; 32] {
        return Err(RewardError::ZeroStakerSecret);
    }
    let available = pool.total_rewards.saturating_sub(pool.distributed);
    if amount > available {
        return Err(RewardError::InsufficientRewards {
            available,
            requested: amount,
        });
    }
    let staker_hash = sha256_multi(&[b"reward-staker-v1", staker_secret]);
    let claim_id = sha256_multi(&[
        b"reward-claim-v1",
        &pool.pool_id,
        &staker_hash,
        &amount.to_le_bytes(),
        &pool.epoch.to_le_bytes(),
    ]);
    pool.distributed += amount;
    Ok(RewardClaim {
        claim_id,
        staker_hash,
        amount,
        epoch: pool.epoch,
        mainnet_ready: false,
    })
}

pub fn pool_public_record(pool: &RewardPool) -> String {
    serde_json::json!({
        "pool_id": hex32(&pool.pool_id),
        "total_rewards": pool.total_rewards,
        "distributed": pool.distributed,
        "epoch": pool.epoch,
        "mainnet_ready": pool.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn secret(b: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = b;
        s
    }

    // Test 1: create + claim
    #[test]
    fn test_create_and_claim() {
        let mut pool = create_pool(&secret(0x11), 1_000_000, 1).unwrap();
        assert!(!pool.mainnet_ready);
        assert_eq!(pool.distributed, 0);
        let claim = claim_reward(&mut pool, &secret(0xAA), 100_000).unwrap();
        assert_eq!(claim.amount, 100_000);
        assert_eq!(pool.distributed, 100_000);
        assert!(!claim.mainnet_ready);
    }

    // Test 2: insufficient rewards rejected
    #[test]
    fn test_insufficient_rewards_rejected() {
        let mut pool = create_pool(&secret(0x22), 500, 2).unwrap();
        let err = claim_reward(&mut pool, &secret(0xBB), 501).unwrap_err();
        assert_eq!(
            err,
            RewardError::InsufficientRewards {
                available: 500,
                requested: 501
            }
        );
    }

    // Test 3: zero validator rejected
    #[test]
    fn test_zero_validator_rejected() {
        let zero = [0u8; 32];
        let err = create_pool(&zero, 1000, 1).unwrap_err();
        assert_eq!(err, RewardError::ZeroValidatorSecret);
    }

    // Test 4: zero staker rejected
    #[test]
    fn test_zero_staker_rejected() {
        let mut pool = create_pool(&secret(0x33), 1000, 1).unwrap();
        let zero = [0u8; 32];
        let err = claim_reward(&mut pool, &zero, 100).unwrap_err();
        assert_eq!(err, RewardError::ZeroStakerSecret);
    }

    // Test 5: claim_id is deterministic
    #[test]
    fn test_claim_id_deterministic() {
        let mut pool1 = create_pool(&secret(0x44), 2000, 3).unwrap();
        let mut pool2 = create_pool(&secret(0x44), 2000, 3).unwrap();
        // same pool_id since same inputs
        assert_eq!(pool1.pool_id, pool2.pool_id);
        let claim1 = claim_reward(&mut pool1, &secret(0xCC), 200).unwrap();
        let claim2 = claim_reward(&mut pool2, &secret(0xCC), 200).unwrap();
        assert_eq!(claim1.claim_id, claim2.claim_id);
    }

    // Test 6: public record hides validator
    #[test]
    fn test_public_record_hides_validator() {
        let validator_secret = secret(0x55);
        let pool = create_pool(&validator_secret, 10_000, 4).unwrap();
        let record = pool_public_record(&pool);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["pool_id"].is_string());
        assert_eq!(v["total_rewards"], 10_000u64);
        assert_eq!(v["mainnet_ready"], false);
        // validator_hash must not appear in public record
        let vh_hex = hex32(&pool.validator_hash);
        assert!(!record.contains(&vh_hex));
        assert!(v.get("validator_hash").is_none());
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_mainnet_ready_always_false() {
        let pool = create_pool(&secret(0x10), 1000, 1).unwrap();
        assert!(!pool.mainnet_ready);
        let mut p2 = create_pool(&secret(0x10), 1000, 1).unwrap();
        let claim = claim_reward(&mut p2, &secret(0x20), 100).unwrap();
        assert!(!claim.mainnet_ready);
    }

    #[test]
    fn test_pool_id_deterministic() {
        let p1 = create_pool(&secret(0x11), 500, 5).unwrap();
        let p2 = create_pool(&secret(0x11), 500, 5).unwrap();
        assert_eq!(p1.pool_id, p2.pool_id);
    }

    #[test]
    fn test_pool_id_sensitive_to_epoch() {
        let p1 = create_pool(&secret(0x12), 500, 1).unwrap();
        let p2 = create_pool(&secret(0x12), 500, 2).unwrap();
        assert_ne!(p1.pool_id, p2.pool_id);
    }

    #[test]
    fn test_multiple_claims_reduce_available() {
        let mut pool = create_pool(&secret(0x13), 1000, 1).unwrap();
        claim_reward(&mut pool, &secret(0xA1), 300).unwrap();
        claim_reward(&mut pool, &secret(0xA2), 300).unwrap();
        assert_eq!(pool.distributed, 600);
        // only 400 left
        let err = claim_reward(&mut pool, &secret(0xA3), 500).unwrap_err();
        assert_eq!(
            err,
            RewardError::InsufficientRewards {
                available: 400,
                requested: 500
            }
        );
    }

    #[test]
    fn test_zero_rewards_rejected() {
        let err = create_pool(&secret(0x14), 0, 1).unwrap_err();
        assert_eq!(err, RewardError::ZeroRewards);
    }

    #[test]
    fn test_different_stakers_different_claim_ids() {
        let mut pool = create_pool(&secret(0x15), 2000, 1).unwrap();
        let c1 = claim_reward(&mut pool, &secret(0xB1), 100).unwrap();
        let c2 = claim_reward(&mut pool, &secret(0xB2), 100).unwrap();
        assert_ne!(c1.claim_id, c2.claim_id);
    }

    #[test]
    fn test_staker_hash_not_in_public_record() {
        let mut pool = create_pool(&secret(0x16), 1000, 1).unwrap();
        let claim = claim_reward(&mut pool, &secret(0xC1), 100).unwrap();
        let record = pool_public_record(&pool);
        let staker_hex = hex32(&claim.staker_hash);
        assert!(!record.contains(&staker_hex));
    }

    #[test]
    fn test_distributed_starts_at_zero() {
        let pool = create_pool(&secret(0x17), 1000, 1).unwrap();
        assert_eq!(pool.distributed, 0);
    }

    #[test]
    fn test_claim_amount_stored() {
        let mut pool = create_pool(&secret(0x18), 5000, 1).unwrap();
        let claim = claim_reward(&mut pool, &secret(0xD1), 777).unwrap();
        assert_eq!(claim.amount, 777);
    }

    #[test]
    fn test_claim_epoch_matches_pool() {
        let mut pool = create_pool(&secret(0x19), 1000, 42).unwrap();
        let claim = claim_reward(&mut pool, &secret(0xE1), 100).unwrap();
        assert_eq!(claim.epoch, 42);
    }
}
