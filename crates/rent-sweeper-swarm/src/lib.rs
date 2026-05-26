use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum AccountKind {
    Scratch,
    Chaff,
    Session,
    Coupon,
    BlinkIntent,
    EmptyTokenAccount,
    EmptyMint2022,
    ReceiptCheckpointExpired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum CloseAuthorityPolicy {
    UserSigned,
    ProtocolAfterExpiry,
    KeeperAfterGrace,
    NotCloseable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RentSweeperTarget {
    pub account_hash: [u8; 32],
    pub owner_hash: [u8; 32],
    pub kind: AccountKind,
    pub expires_at_slot: u64,
    pub rent_lamports: u64,
    pub bounty_lamports: u64,
    pub close_authority_policy: CloseAuthorityPolicy,
    pub proof_hash: [u8; 32],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RentSweeperSweepPlan {
    pub targets: Vec<RentSweeperTarget>,
    pub total_reclaimable_lamports: u64,
    pub total_bounty_lamports: u64,
    pub mainnet_ready: bool,
    pub production_claim: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RentSplit {
    pub user_lamports: u64,
    pub keeper_lamports: u64,
    pub protocol_lamports: u64,
}

fn hash_label(label: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(label);
    h.finalize().into()
}

/// Create mock targets for demo purposes.
/// Returns 3 targets: 1 Scratch (expired), 1 Chaff (expired), 1 EmptyTokenAccount.
pub fn scan_mock_targets(current_slot: u64) -> Vec<RentSweeperTarget> {
    let expired_slot = current_slot.saturating_sub(100);
    let future_slot = current_slot + 1000;

    let make_proof = |seed: &[u8]| -> [u8; 32] { hash_label(seed) };

    vec![
        RentSweeperTarget {
            account_hash: hash_label(b"scratch_mock_account_1"),
            owner_hash: hash_label(b"owner_1"),
            kind: AccountKind::Scratch,
            expires_at_slot: expired_slot,
            rent_lamports: 2_039_280,
            bounty_lamports: estimate_bounty(2_039_280),
            close_authority_policy: CloseAuthorityPolicy::KeeperAfterGrace,
            proof_hash: make_proof(b"proof_scratch_1"),
        },
        RentSweeperTarget {
            account_hash: hash_label(b"chaff_mock_account_2"),
            owner_hash: hash_label(b"owner_2"),
            kind: AccountKind::Chaff,
            expires_at_slot: expired_slot,
            rent_lamports: 890_880,
            bounty_lamports: estimate_bounty(890_880),
            close_authority_policy: CloseAuthorityPolicy::ProtocolAfterExpiry,
            proof_hash: make_proof(b"proof_chaff_2"),
        },
        RentSweeperTarget {
            account_hash: hash_label(b"empty_token_account_3"),
            owner_hash: hash_label(b"owner_3"),
            kind: AccountKind::EmptyTokenAccount,
            expires_at_slot: future_slot,
            rent_lamports: 2_039_280,
            bounty_lamports: estimate_bounty(2_039_280),
            close_authority_policy: CloseAuthorityPolicy::UserSigned,
            proof_hash: make_proof(b"proof_token_3"),
        },
    ]
}

/// Bounty = 10% of reclaimed rent.
pub fn estimate_bounty(rent_lamports: u64) -> u64 {
    rent_lamports * 10 / 100
}

/// Build sweep plan: only include targets where expires_at_slot < current_slot AND policy != NotCloseable.
pub fn build_sweep_plan(
    targets: Vec<RentSweeperTarget>,
    current_slot: u64,
) -> RentSweeperSweepPlan {
    let eligible: Vec<RentSweeperTarget> = targets
        .into_iter()
        .filter(|t| {
            t.expires_at_slot < current_slot
                && t.close_authority_policy != CloseAuthorityPolicy::NotCloseable
        })
        .collect();

    let total_reclaimable_lamports: u64 = eligible.iter().map(|t| t.rent_lamports).sum();
    let total_bounty_lamports: u64 = eligible.iter().map(|t| t.bounty_lamports).sum();

    RentSweeperSweepPlan {
        targets: eligible,
        total_reclaimable_lamports,
        total_bounty_lamports,
        mainnet_ready: false,
        production_claim: false,
    }
}

/// Validate that a target is eligible to close.
pub fn validate_close_eligibility(
    target: &RentSweeperTarget,
    current_slot: u64,
) -> Result<(), String> {
    if target.close_authority_policy == CloseAuthorityPolicy::NotCloseable {
        return Err("Account is marked NotCloseable".to_string());
    }
    if target.expires_at_slot >= current_slot {
        return Err(format!(
            "Account not yet expired: expires_at_slot={}, current_slot={}",
            target.expires_at_slot, current_slot
        ));
    }
    Ok(())
}

/// Split reclaimed rent by basis points (total must be 10000).
pub fn split_reclaimed_rent(
    rent_lamports: u64,
    user_bps: u64,
    keeper_bps: u64,
    protocol_bps: u64,
) -> RentSplit {
    let total_bps = user_bps + keeper_bps + protocol_bps;
    assert_eq!(total_bps, 10_000, "basis points must sum to 10000");
    let user_lamports = rent_lamports * user_bps / 10_000;
    let keeper_lamports = rent_lamports * keeper_bps / 10_000;
    let protocol_lamports = rent_lamports * protocol_bps / 10_000;
    RentSplit {
        user_lamports,
        keeper_lamports,
        protocol_lamports,
    }
}

/// Sort targets by highest bounty first.
pub fn sort_by_highest_bounty(targets: &mut Vec<RentSweeperTarget>) {
    targets.sort_by(|a, b| b.bounty_lamports.cmp(&a.bounty_lamports));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_target(
        expires_at_slot: u64,
        rent: u64,
        policy: CloseAuthorityPolicy,
    ) -> RentSweeperTarget {
        RentSweeperTarget {
            account_hash: [0u8; 32],
            owner_hash: [1u8; 32],
            kind: AccountKind::Scratch,
            expires_at_slot,
            rent_lamports: rent,
            bounty_lamports: estimate_bounty(rent),
            close_authority_policy: policy,
            proof_hash: [2u8; 32],
        }
    }

    #[test]
    fn test_cannot_close_before_expiry() {
        let target = make_target(1000, 1_000_000, CloseAuthorityPolicy::KeeperAfterGrace);
        assert!(validate_close_eligibility(&target, 999).is_err());
    }

    #[test]
    fn test_can_close_after_expiry() {
        let target = make_target(1000, 1_000_000, CloseAuthorityPolicy::KeeperAfterGrace);
        assert!(validate_close_eligibility(&target, 1001).is_ok());
    }

    #[test]
    fn test_not_closeable_rejected() {
        let target = make_target(1000, 1_000_000, CloseAuthorityPolicy::NotCloseable);
        assert!(validate_close_eligibility(&target, 2000).is_err());
    }

    #[test]
    fn test_bounty_never_exceeds_rent() {
        for rent in [0u64, 100, 1_000_000, u64::MAX / 100] {
            let bounty = estimate_bounty(rent);
            assert!(bounty <= rent, "bounty {} exceeded rent {}", bounty, rent);
        }
    }

    #[test]
    fn test_split_adds_to_total() {
        let rent = 1_000_000u64;
        let split = split_reclaimed_rent(rent, 8000, 1500, 500);
        assert_eq!(
            split.user_lamports + split.keeper_lamports + split.protocol_lamports,
            rent
        );
    }

    #[test]
    fn test_protocol_cut_computed() {
        let rent = 1_000_000u64;
        let split = split_reclaimed_rent(rent, 8000, 1500, 500);
        assert_eq!(split.protocol_lamports, rent * 5 / 100);
    }

    #[test]
    fn test_sorted_by_highest_bounty() {
        let mut targets = vec![
            make_target(100, 500_000, CloseAuthorityPolicy::UserSigned),
            make_target(100, 2_000_000, CloseAuthorityPolicy::UserSigned),
            make_target(100, 1_000_000, CloseAuthorityPolicy::UserSigned),
        ];
        sort_by_highest_bounty(&mut targets);
        assert_eq!(targets[0].rent_lamports, 2_000_000);
        assert_eq!(targets[1].rent_lamports, 1_000_000);
        assert_eq!(targets[2].rent_lamports, 500_000);
    }
}
