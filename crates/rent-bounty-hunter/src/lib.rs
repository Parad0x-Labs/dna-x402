use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExpiredAccountKind {
    Scratch,
    Chaff,
    Session,
    Coupon,
    BlinkIntent,
}

#[derive(Clone, Debug)]
pub struct ExpiredAccountTarget {
    pub account: [u8; 32],
    pub kind: ExpiredAccountKind,
    pub expires_at_slot: u64,
    pub estimated_lamports: u64,
}

#[derive(Clone, Debug)]
pub struct BountyRules {
    /// Must be this many slots old past expiry before closure is allowed
    pub min_age_slots: u64,
    /// Bounty as basis points of reclaimed rent
    pub bounty_bps: u32,
    /// Cap per account in lamports
    pub max_bounty_lamports: u64,
    /// Protected window (in slots) after creation during which closure is blocked
    pub grace_period_slots: u64,
}

impl BountyRules {
    pub fn default_rules() -> Self {
        Self {
            min_age_slots: 10,
            bounty_bps: 100,
            max_bounty_lamports: 1_000_000,
            grace_period_slots: 5,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum BountyError {
    NotYetExpired,
    ProtectedGracePeriod,
    BountyZero,
}

/// Calculate the bounty for closing `target`.
///
/// - `created_at_slot`: the slot the account was created (for grace period).
/// - `current_slot`: the slot at which the hunter is attempting the close.
pub fn calculate_bounty(
    target: &ExpiredAccountTarget,
    rules: &BountyRules,
    current_slot: u64,
    created_at_slot: u64,
) -> Result<u64, BountyError> {
    // Cannot close before expiry
    if current_slot <= target.expires_at_slot {
        return Err(BountyError::NotYetExpired);
    }
    // Grace period from creation
    if current_slot < created_at_slot + rules.grace_period_slots {
        return Err(BountyError::ProtectedGracePeriod);
    }
    // Must be old enough past expiry
    if current_slot < target.expires_at_slot + rules.min_age_slots {
        return Err(BountyError::NotYetExpired);
    }
    let bounty = (target.estimated_lamports as u128 * rules.bounty_bps as u128 / 10_000) as u64;
    let bounty = bounty.min(rules.max_bounty_lamports);
    if bounty == 0 {
        return Err(BountyError::BountyZero);
    }
    Ok(bounty)
}

/// Sort targets by highest estimated_lamports first (most valuable to close first).
pub fn sort_targets_by_value(targets: &mut Vec<ExpiredAccountTarget>) {
    targets.sort_by(|a, b| b.estimated_lamports.cmp(&a.estimated_lamports));
}

/// Sum of all estimated lamports across targets.
pub fn total_reclaimable(targets: &[ExpiredAccountTarget]) -> u64 {
    targets.iter().map(|t| t.estimated_lamports).sum()
}

/// Compute bounty directly from reclaimed lamports (e.g. after on-chain close).
/// Bounty comes from reclaimed rent, not treasury.
pub fn bounty_from_reclaimed(reclaimed_lamports: u64, rules: &BountyRules) -> u64 {
    let b = (reclaimed_lamports as u128 * rules.bounty_bps as u128 / 10_000) as u64;
    b.min(rules.max_bounty_lamports)
}

/// Deterministic target hash for deduplication / logging.
pub fn target_hash(target: &ExpiredAccountTarget) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(&target.account);
    h.update(target.expires_at_slot.to_le_bytes());
    h.update(target.estimated_lamports.to_le_bytes());
    h.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_target(lamports: u64, expires: u64) -> ExpiredAccountTarget {
        ExpiredAccountTarget {
            account: [0xABu8; 32],
            kind: ExpiredAccountKind::Chaff,
            expires_at_slot: expires,
            estimated_lamports: lamports,
        }
    }

    fn default_rules() -> BountyRules {
        BountyRules::default_rules()
    }

    #[test]
    fn test_cannot_close_before_expiry() {
        let target = make_target(1_000_000, 100);
        let rules = default_rules();
        // current_slot == expires_at_slot => NotYetExpired (not strictly after)
        assert_eq!(
            calculate_bounty(&target, &rules, 100, 0),
            Err(BountyError::NotYetExpired)
        );
        assert_eq!(
            calculate_bounty(&target, &rules, 99, 0),
            Err(BountyError::NotYetExpired)
        );
    }

    #[test]
    fn test_grace_period_protected() {
        // Account created at slot 0, grace_period = 5, expires at 2
        // At slot 101 (past expiry + min_age), but within grace_period from creation
        // Actually grace_period is from creation, so created_at=200, grace=5 → protected until 205
        let target = make_target(1_000_000, 50);
        let rules = default_rules(); // grace_period_slots=5, min_age_slots=10
                                     // current=61, expires=50, created=60 → within grace (60+5=65 > 61)
        assert_eq!(
            calculate_bounty(&target, &rules, 61, 60),
            Err(BountyError::ProtectedGracePeriod)
        );
    }

    #[test]
    fn test_bounty_calculated() {
        // 1_000_000 lamports, 100 bps = 1% = 10_000 lamports
        let target = make_target(1_000_000, 100);
        let rules = default_rules(); // min_age=10, bounty_bps=100, max=1_000_000
                                     // current=111, expires=100, created=0 (well past grace)
        let bounty = calculate_bounty(&target, &rules, 111, 0).expect("should succeed");
        assert_eq!(bounty, 10_000);
    }

    #[test]
    fn test_bounty_capped() {
        // 100_000_000_000 lamports at 100 bps = 1_000_000_000 but cap is 1_000_000
        let target = make_target(100_000_000_000, 100);
        let rules = default_rules();
        let bounty = calculate_bounty(&target, &rules, 111, 0).expect("should succeed");
        assert_eq!(bounty, 1_000_000);
    }

    #[test]
    fn test_sort_by_value() {
        let mut targets = vec![
            make_target(500_000, 100),
            make_target(2_000_000, 200),
            make_target(100_000, 300),
        ];
        sort_targets_by_value(&mut targets);
        assert_eq!(targets[0].estimated_lamports, 2_000_000);
        assert_eq!(targets[1].estimated_lamports, 500_000);
        assert_eq!(targets[2].estimated_lamports, 100_000);
    }

    #[test]
    fn test_bounty_from_reclaimed() {
        let rules = default_rules(); // bounty_bps=100, max=1_000_000
                                     // 500_000 lamports * 1% = 5_000
        assert_eq!(bounty_from_reclaimed(500_000, &rules), 5_000);
        // Capped
        assert_eq!(bounty_from_reclaimed(200_000_000_000, &rules), 1_000_000);
    }
}
