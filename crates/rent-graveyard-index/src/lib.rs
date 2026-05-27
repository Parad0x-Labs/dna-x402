use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq)]
pub enum CloseabilityStatus {
    Closeable,
    MaybeCloseable,
    Locked,
}

#[derive(Debug, Clone)]
pub struct GraveEntry {
    pub account_hash: [u8; 32],
    pub lamports: u64,
    pub last_active_slot: u64,
    pub closeability_status: CloseabilityStatus,
    pub bounty_lamports: u64,
    pub grave_score: u32,
}

#[derive(Debug, Clone)]
pub struct CleanupProof {
    pub account_hash: [u8; 32],
    pub closer_hash: [u8; 32],
    pub recovered_lamports: u64,
    pub proof_hash: [u8; 32],
}

pub fn score_grave(lamports: u64, last_active_slot: u64, current_slot: u64) -> u32 {
    let idle_slots = current_slot.saturating_sub(last_active_slot);
    let raw = (lamports / 1000).saturating_add(idle_slots / 10_000);
    raw.min(u32::MAX as u64) as u32
}

pub fn create_grave_entry(
    account_hash: &[u8; 32],
    lamports: u64,
    last_active_slot: u64,
    current_slot: u64,
    status: CloseabilityStatus,
) -> GraveEntry {
    let grave_score = score_grave(lamports, last_active_slot, current_slot);
    let bounty_lamports = lamports / 10;
    GraveEntry {
        account_hash: *account_hash,
        lamports,
        last_active_slot,
        closeability_status: status,
        bounty_lamports,
        grave_score,
    }
}

pub fn create_cleanup_proof(
    account_hash: &[u8; 32],
    closer_hash: &[u8; 32],
    recovered_lamports: u64,
) -> CleanupProof {
    let mut hasher = Sha256::new();
    hasher.update(b"cleanup-proof-v1");
    hasher.update(account_hash);
    hasher.update(closer_hash);
    hasher.update(recovered_lamports.to_le_bytes());
    let proof_hash: [u8; 32] = hasher.finalize().into();

    CleanupProof {
        account_hash: *account_hash,
        closer_hash: *closer_hash,
        recovered_lamports,
        proof_hash,
    }
}

pub fn rank_graves(mut graves: Vec<GraveEntry>) -> Vec<GraveEntry> {
    graves.sort_by(|a, b| b.grave_score.cmp(&a.grave_score));
    graves
}

pub fn total_recoverable(graves: &[GraveEntry]) -> u64 {
    graves
        .iter()
        .filter(|g| g.closeability_status == CloseabilityStatus::Closeable)
        .map(|g| g.lamports)
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_hash(seed: u8) -> [u8; 32] {
        let mut h = [0u8; 32];
        h[0] = seed;
        h
    }

    #[test]
    fn test_grave_score_increases_with_lamports() {
        let s1 = score_grave(1_000_000, 0, 0);
        let s2 = score_grave(2_000_000, 0, 0);
        assert!(s2 > s1, "higher lamports should yield higher score");
    }

    #[test]
    fn test_grave_score_increases_with_idle_time() {
        let s1 = score_grave(0, 100_000, 200_000); // 100k idle slots
        let s2 = score_grave(0, 100_000, 1_200_000); // 1.1M idle slots
        assert!(s2 > s1, "more idle time should yield higher score");
    }

    #[test]
    fn test_bounty_is_10pct() {
        let entry = create_grave_entry(&dummy_hash(1), 50_000, 0, 0, CloseabilityStatus::Closeable);
        assert_eq!(entry.bounty_lamports, 5_000);
    }

    #[test]
    fn test_closeable_only_in_recoverable() {
        let closeable =
            create_grave_entry(&dummy_hash(1), 10_000, 0, 0, CloseabilityStatus::Closeable);
        let locked = create_grave_entry(&dummy_hash(2), 20_000, 0, 0, CloseabilityStatus::Locked);
        let maybe = create_grave_entry(
            &dummy_hash(3),
            30_000,
            0,
            0,
            CloseabilityStatus::MaybeCloseable,
        );
        let total = total_recoverable(&[closeable, locked, maybe]);
        assert_eq!(total, 10_000, "only Closeable entries should count");
    }

    #[test]
    fn test_rank_graves_descending() {
        let g1 = create_grave_entry(&dummy_hash(1), 1_000, 0, 0, CloseabilityStatus::Closeable);
        let g2 = create_grave_entry(&dummy_hash(2), 9_000, 0, 0, CloseabilityStatus::Closeable);
        let ranked = rank_graves(vec![g1, g2]);
        assert!(
            ranked[0].grave_score >= ranked[1].grave_score,
            "first should be highest score"
        );
    }

    #[test]
    fn test_cleanup_proof_hash_deterministic() {
        let a = dummy_hash(1);
        let c = dummy_hash(2);
        let p1 = create_cleanup_proof(&a, &c, 1_000);
        let p2 = create_cleanup_proof(&a, &c, 1_000);
        assert_eq!(p1.proof_hash, p2.proof_hash);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_proof_hash_nonzero() {
        let p = create_cleanup_proof(&dummy_hash(1), &dummy_hash(2), 5_000);
        assert_ne!(p.proof_hash, [0u8; 32]);
    }

    #[test]
    fn test_proof_lamports_sensitive() {
        let a = dummy_hash(1);
        let c = dummy_hash(2);
        let p1 = create_cleanup_proof(&a, &c, 1_000);
        let p2 = create_cleanup_proof(&a, &c, 2_000);
        assert_ne!(p1.proof_hash, p2.proof_hash);
    }

    #[test]
    fn test_proof_closer_sensitive() {
        let a = dummy_hash(1);
        let p1 = create_cleanup_proof(&a, &dummy_hash(10), 1_000);
        let p2 = create_cleanup_proof(&a, &dummy_hash(20), 1_000);
        assert_ne!(p1.proof_hash, p2.proof_hash);
    }

    #[test]
    fn test_score_zero_at_zero_lamports_zero_slots() {
        assert_eq!(score_grave(0, 0, 0), 0);
    }

    #[test]
    fn test_bounty_10pct_formula() {
        let entry = create_grave_entry(
            &dummy_hash(5),
            1_000_000,
            0,
            0,
            CloseabilityStatus::Closeable,
        );
        assert_eq!(entry.bounty_lamports, 100_000);
    }

    #[test]
    fn test_total_recoverable_empty() {
        assert_eq!(total_recoverable(&[]), 0);
    }

    #[test]
    fn test_total_recoverable_multiple_closeable() {
        let g1 = create_grave_entry(&dummy_hash(1), 10_000, 0, 0, CloseabilityStatus::Closeable);
        let g2 = create_grave_entry(&dummy_hash(2), 20_000, 0, 0, CloseabilityStatus::Closeable);
        let g3 = create_grave_entry(&dummy_hash(3), 99_999, 0, 0, CloseabilityStatus::Locked);
        assert_eq!(total_recoverable(&[g1, g2, g3]), 30_000);
    }

    #[test]
    fn test_grave_entry_lamports_stored() {
        let entry = create_grave_entry(&dummy_hash(1), 42_000, 0, 0, CloseabilityStatus::Closeable);
        assert_eq!(entry.lamports, 42_000);
    }

    #[test]
    fn test_grave_entry_account_hash_stored() {
        let h = dummy_hash(77);
        let entry = create_grave_entry(&h, 1_000, 0, 0, CloseabilityStatus::Closeable);
        assert_eq!(entry.account_hash, h);
    }

    #[test]
    fn test_score_deterministic() {
        let s1 = score_grave(500_000, 100, 200);
        let s2 = score_grave(500_000, 100, 200);
        assert_eq!(s1, s2);
    }
}
