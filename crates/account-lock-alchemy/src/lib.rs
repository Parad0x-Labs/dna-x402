use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WritableHeat {
    pub account_hash: [u8; 32],
    pub recent_writes: u32,
    pub heat_score: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShapePrivacyScore {
    pub shape_hash: [u8; 32],
    pub k_shape: usize,
    pub uniqueness_ratio: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountLockPlan {
    pub writable_set: Vec<[u8; 32]>,
    pub readonly_set: Vec<[u8; 32]>,
    pub decoy_readonly: Vec<[u8; 32]>,
    pub plan_hash: [u8; 32],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LockAlchemyScore {
    pub fee_heat_score: f32,
    pub parallelism_score: f32,
    pub fingerprint_uniqueness: f32,
    pub shape_pool_score: f32,
    pub rent_touch_score: f32,
    pub overall: f32,
    pub recommendation: String,
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/// Compute plan_hash = SHA256("dark_null_v1_lock_plan" || all writable_set bytes || all readonly_set bytes)
pub fn compute_plan_hash(plan: &AccountLockPlan) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"dark_null_v1_lock_plan");
    for w in &plan.writable_set {
        h.update(w);
    }
    for r in &plan.readonly_set {
        h.update(r);
    }
    h.finalize().into()
}

/// Score a lock plan against heat data and privacy info.
pub fn score_lock_plan(
    plan: &AccountLockPlan,
    heats: &[WritableHeat],
    privacy: &ShapePrivacyScore,
) -> LockAlchemyScore {
    // fee_heat_score: avg heat of writable accounts found in heats
    let mut heat_sum = 0.0f32;
    let mut heat_count = 0usize;
    for w in &plan.writable_set {
        if let Some(wh) = heats.iter().find(|h| &h.account_hash == w) {
            heat_sum += wh.heat_score;
            heat_count += 1;
        }
    }
    let fee_heat_score = if heat_count > 0 {
        heat_sum / heat_count as f32
    } else {
        0.0
    };

    let fingerprint_uniqueness = privacy.uniqueness_ratio;
    let shape_pool_score = (privacy.k_shape as f32 / 10.0).min(1.0);
    let parallelism_score = if plan.writable_set.len() <= 2 {
        0.8
    } else {
        0.4
    };
    // rent_touch_score: 0.0 (no rent-touch info available at this layer)
    let rent_touch_score = 0.0f32;

    // overall: (1-fee_heat)*0.3 + (1-fingerprint_uniqueness)*0.3 + shape_pool_score*0.2 + parallelism_score*0.2
    let overall = (1.0 - fee_heat_score) * 0.3
        + (1.0 - fingerprint_uniqueness) * 0.3
        + shape_pool_score * 0.2
        + parallelism_score * 0.2;

    let recommendation = if overall > 0.6 {
        "safe".to_string()
    } else if fingerprint_uniqueness > 0.8 {
        "risky: unique fingerprint".to_string()
    } else {
        "risky: hot accounts".to_string()
    };

    LockAlchemyScore {
        fee_heat_score,
        parallelism_score,
        fingerprint_uniqueness,
        shape_pool_score,
        rent_touch_score,
        overall,
        recommendation,
    }
}

/// True if any writable account's heat_score > 0.7 in heats.
pub fn should_rollover_shard(plan: &AccountLockPlan, heats: &[WritableHeat]) -> bool {
    for w in &plan.writable_set {
        if let Some(wh) = heats.iter().find(|h| &h.account_hash == w) {
            if wh.heat_score > 0.7 {
                return true;
            }
        }
    }
    false
}

/// True if fingerprint_uniqueness > 0.8 (k_shape < 2).
pub fn plan_is_doxxed(privacy: &ShapePrivacyScore) -> bool {
    privacy.uniqueness_ratio > 0.8
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_hash(seed: u8) -> [u8; 32] {
        [seed; 32]
    }

    fn empty_plan(writable: Vec<[u8; 32]>) -> AccountLockPlan {
        AccountLockPlan {
            writable_set: writable,
            readonly_set: vec![],
            decoy_readonly: vec![],
            plan_hash: [0u8; 32],
        }
    }

    #[test]
    fn test_hot_account_lowers_score() {
        let hash_a = make_hash(0xAA);
        let plan = empty_plan(vec![hash_a]);
        let heats = vec![WritableHeat {
            account_hash: hash_a,
            recent_writes: 100,
            heat_score: 0.9,
        }];
        let privacy = ShapePrivacyScore {
            shape_hash: make_hash(0x01),
            k_shape: 5,
            uniqueness_ratio: 0.2,
        };
        let score = score_lock_plan(&plan, &heats, &privacy);
        assert!(
            score.fee_heat_score >= 0.8,
            "expected fee_heat_score >= 0.8, got {}",
            score.fee_heat_score
        );
    }

    #[test]
    fn test_cool_account_high_score() {
        let hash_b = make_hash(0xBB);
        let plan = empty_plan(vec![hash_b]);
        let heats = vec![WritableHeat {
            account_hash: hash_b,
            recent_writes: 1,
            heat_score: 0.1,
        }];
        let privacy = ShapePrivacyScore {
            shape_hash: make_hash(0x01),
            k_shape: 10,
            uniqueness_ratio: 0.1,
        };
        let score = score_lock_plan(&plan, &heats, &privacy);
        assert_eq!(score.recommendation, "safe");
    }

    #[test]
    fn test_unique_plan_flagged() {
        let privacy = ShapePrivacyScore {
            shape_hash: make_hash(0x01),
            k_shape: 1,
            uniqueness_ratio: 1.0,
        };
        assert!(plan_is_doxxed(&privacy));
    }

    #[test]
    fn test_shard_rollover_suggested_for_hot_accounts() {
        let hash_x = make_hash(0x42);
        let plan = empty_plan(vec![hash_x]);
        let heats = vec![WritableHeat {
            account_hash: hash_x,
            recent_writes: 50,
            heat_score: 0.85,
        }];
        assert!(should_rollover_shard(&plan, &heats));
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_compute_plan_hash_nonzero() {
        let plan = empty_plan(vec![make_hash(0x01)]);
        assert_ne!(compute_plan_hash(&plan), [0u8; 32]);
    }

    #[test]
    fn test_compute_plan_hash_deterministic() {
        let plan = empty_plan(vec![make_hash(0x01)]);
        assert_eq!(compute_plan_hash(&plan), compute_plan_hash(&plan));
    }

    #[test]
    fn test_compute_plan_hash_writable_sensitive() {
        let p1 = empty_plan(vec![make_hash(0x01)]);
        let p2 = empty_plan(vec![make_hash(0x02)]);
        assert_ne!(compute_plan_hash(&p1), compute_plan_hash(&p2));
    }

    #[test]
    fn test_compute_plan_hash_readonly_sensitive() {
        let mut p1 = empty_plan(vec![]);
        p1.readonly_set = vec![make_hash(0x10)];
        let mut p2 = empty_plan(vec![]);
        p2.readonly_set = vec![make_hash(0x20)];
        assert_ne!(compute_plan_hash(&p1), compute_plan_hash(&p2));
    }

    #[test]
    fn test_plan_not_doxxed_at_boundary() {
        // uniqueness_ratio == 0.8 is NOT doxxed (check is >, not >=)
        let privacy = ShapePrivacyScore {
            shape_hash: make_hash(0x01),
            k_shape: 2,
            uniqueness_ratio: 0.8,
        };
        assert!(!plan_is_doxxed(&privacy));
    }

    #[test]
    fn test_plan_not_doxxed_low_uniqueness() {
        let privacy = ShapePrivacyScore {
            shape_hash: make_hash(0x01),
            k_shape: 5,
            uniqueness_ratio: 0.5,
        };
        assert!(!plan_is_doxxed(&privacy));
    }

    #[test]
    fn test_shard_rollover_false_at_boundary() {
        // heat_score == 0.7 → false (check is >, not >=)
        let hash_x = make_hash(0x11);
        let plan = empty_plan(vec![hash_x]);
        let heats = vec![WritableHeat {
            account_hash: hash_x,
            recent_writes: 10,
            heat_score: 0.7,
        }];
        assert!(!should_rollover_shard(&plan, &heats));
    }

    #[test]
    fn test_score_no_heat_data_zero_fee_heat() {
        let plan = empty_plan(vec![make_hash(0xCC)]);
        let privacy = ShapePrivacyScore {
            shape_hash: make_hash(0x01),
            k_shape: 5,
            uniqueness_ratio: 0.1,
        };
        let score = score_lock_plan(&plan, &[], &privacy);
        assert_eq!(score.fee_heat_score, 0.0);
    }

    #[test]
    fn test_score_many_writables_lower_parallelism() {
        let plan = AccountLockPlan {
            writable_set: vec![make_hash(0x01), make_hash(0x02), make_hash(0x03)],
            readonly_set: vec![],
            decoy_readonly: vec![],
            plan_hash: [0u8; 32],
        };
        let privacy = ShapePrivacyScore {
            shape_hash: make_hash(0x01),
            k_shape: 5,
            uniqueness_ratio: 0.1,
        };
        let score = score_lock_plan(&plan, &[], &privacy);
        assert_eq!(score.parallelism_score, 0.4);
    }

    #[test]
    fn test_score_two_writables_high_parallelism() {
        let plan = empty_plan(vec![make_hash(0x01), make_hash(0x02)]);
        let privacy = ShapePrivacyScore {
            shape_hash: make_hash(0x01),
            k_shape: 5,
            uniqueness_ratio: 0.1,
        };
        let score = score_lock_plan(&plan, &[], &privacy);
        assert_eq!(score.parallelism_score, 0.8);
    }

    #[test]
    fn test_rent_touch_score_zero() {
        let plan = empty_plan(vec![make_hash(0x01)]);
        let privacy = ShapePrivacyScore {
            shape_hash: make_hash(0x01),
            k_shape: 5,
            uniqueness_ratio: 0.1,
        };
        let score = score_lock_plan(&plan, &[], &privacy);
        assert_eq!(score.rent_touch_score, 0.0);
    }

    #[test]
    fn test_shape_pool_score_capped_at_one() {
        let plan = empty_plan(vec![make_hash(0x01)]);
        let privacy = ShapePrivacyScore {
            shape_hash: make_hash(0x01),
            k_shape: 100, // 100/10 = 10.0, capped to 1.0
            uniqueness_ratio: 0.1,
        };
        let score = score_lock_plan(&plan, &[], &privacy);
        assert_eq!(score.shape_pool_score, 1.0);
    }
}
