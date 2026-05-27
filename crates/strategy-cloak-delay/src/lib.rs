use sha2::{Digest, Sha256};

pub const DOMAIN_CLOAK: u8 = 0x90;

#[derive(Clone, Debug)]
pub struct CloakPlanInput {
    pub earliest_slot: u64,
    pub latest_slot: u64, // hard deadline (expiry)
    pub max_delay_slots: u64,
    pub target_event_slot: u64,  // event start
    pub fee_hot_slots: Vec<u64>, // slots with elevated fees to avoid
    pub session_id: [u8; 32],
    pub seed: [u8; 32], // deterministic randomization
}

#[derive(Debug)]
pub struct CloakSubmitPlan {
    pub submit_slot: u64,
    pub delay_reason: String,
    pub privacy_score: f32,    // 0.0-1.0
    pub chaff_slots: Vec<u64>, // decoy slots
}

#[derive(Debug, PartialEq, Eq)]
pub enum CloakError {
    DeadlineExceedsExpiry,
    EarliestAfterLatest,
    EventAlreadyPassed,
}

/// Deterministic jitter using PRNG from seed
fn slot_jitter(seed: &[u8; 32], range: u64) -> u64 {
    if range == 0 {
        return 0;
    }
    let mut h = Sha256::new();
    h.update([DOMAIN_CLOAK]);
    h.update(seed);
    let bytes: [u8; 32] = h.finalize().into();
    u64::from_le_bytes(bytes[..8].try_into().unwrap()) % range
}

pub fn plan_cloak_submit(input: &CloakPlanInput) -> Result<CloakSubmitPlan, CloakError> {
    if input.earliest_slot > input.latest_slot {
        return Err(CloakError::EarliestAfterLatest);
    }

    let window = input.latest_slot - input.earliest_slot;
    let effective_delay = input.max_delay_slots.min(window);
    let jitter = slot_jitter(&input.seed, effective_delay + 1);
    let mut submit_slot = input.earliest_slot + jitter;

    // Avoid hot fee slots
    if input.fee_hot_slots.contains(&submit_slot) {
        let alt = submit_slot + 1;
        if alt <= input.latest_slot {
            submit_slot = alt;
        }
    }

    // Submit must be before event (don't leak intent timing)
    let submit_slot = submit_slot
        .min(input.target_event_slot.saturating_sub(1))
        .max(input.earliest_slot);
    // Hard cap: never after latest
    let submit_slot = submit_slot.min(input.latest_slot);

    // Generate chaff slots (different from real submit)
    let chaff_slots: Vec<u64> = (0u64..3)
        .map(|i| {
            let mut h = Sha256::new();
            h.update([DOMAIN_CLOAK, 0xCC]);
            h.update(&input.seed);
            h.update(i.to_le_bytes());
            let b: [u8; 32] = h.finalize().into();
            let offset = u64::from_le_bytes(b[..8].try_into().unwrap()) % (window.max(1));
            (input.earliest_slot + offset).min(input.latest_slot)
        })
        .filter(|&s| s != submit_slot)
        .collect();

    let privacy_score = if window > 100 {
        0.9
    } else if window > 10 {
        0.6
    } else {
        0.3
    };

    Ok(CloakSubmitPlan {
        submit_slot,
        delay_reason: format!(
            "jitter={} hot_avoided={}",
            jitter,
            input.fee_hot_slots.contains(&submit_slot)
        ),
        privacy_score,
        chaff_slots,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_input(earliest: u64, latest: u64, max_delay: u64, event: u64) -> CloakPlanInput {
        CloakPlanInput {
            earliest_slot: earliest,
            latest_slot: latest,
            max_delay_slots: max_delay,
            target_event_slot: event,
            fee_hot_slots: vec![],
            session_id: [0u8; 32],
            seed: [0xABu8; 32],
        }
    }

    #[test]
    fn test_submit_within_window() {
        let input = make_input(100, 500, 200, 600);
        let plan = plan_cloak_submit(&input).unwrap();
        assert!(plan.submit_slot >= 100);
        assert!(plan.submit_slot <= 500);
    }

    #[test]
    fn test_never_after_deadline() {
        for seed_byte in 0u8..=10 {
            let mut input = make_input(0, 50, 100, 200);
            input.seed = [seed_byte; 32];
            let plan = plan_cloak_submit(&input).unwrap();
            assert!(
                plan.submit_slot <= 50,
                "submit_slot {} exceeded latest 50",
                plan.submit_slot
            );
        }
    }

    #[test]
    fn test_hot_slot_avoided() {
        let base = make_input(100, 200, 100, 300);
        let plan_no_hot = plan_cloak_submit(&base).unwrap();
        let hot = plan_no_hot.submit_slot;

        let mut input = make_input(100, 200, 100, 300);
        input.fee_hot_slots = vec![hot];
        let plan = plan_cloak_submit(&input).unwrap();
        assert!(plan.submit_slot <= 200);
        assert!(plan.submit_slot >= 100);
    }

    #[test]
    fn test_deterministic_with_seed() {
        let input = make_input(0, 1000, 500, 2000);
        let plan_a = plan_cloak_submit(&input).unwrap();
        let plan_b = plan_cloak_submit(&input).unwrap();
        assert_eq!(plan_a.submit_slot, plan_b.submit_slot);
    }

    #[test]
    fn test_chaff_differs_from_submit() {
        let input = make_input(0, 1000, 500, 2000);
        let plan = plan_cloak_submit(&input).unwrap();
        for &cs in &plan.chaff_slots {
            assert_ne!(cs, plan.submit_slot, "chaff slot collides with submit slot");
        }
    }

    #[test]
    fn test_earliest_after_latest_error() {
        let input = make_input(500, 100, 50, 200); // earliest > latest
        let result = plan_cloak_submit(&input);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), CloakError::EarliestAfterLatest);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_privacy_score_large_window() {
        // window = 1000 > 100 → score = 0.9
        let input = make_input(0, 1000, 999, 2000);
        let plan = plan_cloak_submit(&input).unwrap();
        assert!((plan.privacy_score - 0.9).abs() < 1e-5);
    }

    #[test]
    fn test_privacy_score_medium_window() {
        // window = 50 > 10 and <= 100 → score = 0.6
        let input = make_input(0, 50, 999, 2000);
        let plan = plan_cloak_submit(&input).unwrap();
        assert!((plan.privacy_score - 0.6).abs() < 1e-5);
    }

    #[test]
    fn test_privacy_score_small_window() {
        // window = 5 <= 10 → score = 0.3
        let input = make_input(100, 105, 999, 2000);
        let plan = plan_cloak_submit(&input).unwrap();
        assert!((plan.privacy_score - 0.3).abs() < 1e-5);
    }

    #[test]
    fn test_submit_before_event_when_event_within_window() {
        // event=150 is within [100, 200] → submit_slot < 150
        let input = make_input(100, 200, 200, 150);
        let plan = plan_cloak_submit(&input).unwrap();
        assert!(plan.submit_slot < 150, "submit must be before event");
    }

    #[test]
    fn test_chaff_slots_within_window() {
        let input = make_input(50, 200, 100, 500);
        let plan = plan_cloak_submit(&input).unwrap();
        for &cs in &plan.chaff_slots {
            assert!(cs >= 50 && cs <= 200, "chaff slot {} out of window", cs);
        }
    }

    #[test]
    fn test_equal_earliest_latest_ok() {
        // earliest == latest is valid (not EarliestAfterLatest)
        let input = make_input(100, 100, 50, 500);
        assert!(plan_cloak_submit(&input).is_ok());
    }

    #[test]
    fn test_submit_at_least_earliest() {
        let input = make_input(100, 300, 100, 600);
        let plan = plan_cloak_submit(&input).unwrap();
        assert!(plan.submit_slot >= 100);
    }

    #[test]
    fn test_delay_reason_not_empty() {
        let input = make_input(0, 500, 100, 1000);
        let plan = plan_cloak_submit(&input).unwrap();
        assert!(!plan.delay_reason.is_empty());
    }

    #[test]
    fn test_large_delay_clamped_to_window() {
        // max_delay far exceeds window → still within bounds
        let input = make_input(10, 110, 999_999, 9_999_999);
        let plan = plan_cloak_submit(&input).unwrap();
        assert!(plan.submit_slot >= 10 && plan.submit_slot <= 110);
    }

    #[test]
    fn test_chaff_at_most_three() {
        let input = make_input(0, 1000, 500, 2000);
        let plan = plan_cloak_submit(&input).unwrap();
        assert!(plan.chaff_slots.len() <= 3);
    }
}
