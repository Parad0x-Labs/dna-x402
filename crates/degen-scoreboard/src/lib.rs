use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ScoreEventKind {
    RentReclaimed,
    ChaffJobCompleted,
    PuzzleSolved,
    ShapePoolFilled,
    ReceiptVerified,
    RitualTransferPassed,
    BadRouteAvoided,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DegenScoreEvent {
    pub user_hash: [u8; 32],
    pub event_kind: ScoreEventKind,
    pub value_lamports: u64,
    pub proof_hash: [u8; 32],
    pub slot: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DegenBadge {
    pub user_hash: [u8; 32],
    pub epoch_score: u64,
    pub badge_hash: [u8; 32],
    pub events_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedactedLeaderboard {
    pub entries: Vec<[u8; 32]>,
    pub epoch_root: [u8; 32],
}

fn event_multiplier(kind: &ScoreEventKind) -> u64 {
    match kind {
        ScoreEventKind::ChaffJobCompleted => 2,
        ScoreEventKind::PuzzleSolved => 5,
        _ => 1,
    }
}

pub fn compute_epoch_score(events: &[DegenScoreEvent]) -> u64 {
    events
        .iter()
        .map(|e| e.value_lamports * event_multiplier(&e.event_kind))
        .sum()
}

pub fn generate_badge(user_hash: [u8; 32], events: &[DegenScoreEvent]) -> DegenBadge {
    let epoch_score = compute_epoch_score(events);

    let mut h = Sha256::new();
    h.update(b"degen_badge_v1");
    h.update(user_hash);
    h.update(epoch_score.to_le_bytes());
    let badge_hash: [u8; 32] = h.finalize().into();

    DegenBadge {
        user_hash,
        epoch_score,
        badge_hash,
        events_count: events.len() as u32,
    }
}

pub fn anti_sybil_minimum_work(events: &[DegenScoreEvent], min_value_lamports: u64) -> bool {
    let total: u64 = events.iter().map(|e| e.value_lamports).sum();
    total >= min_value_lamports
}

pub fn leaderboard_redacted(mut user_scores: Vec<([u8; 32], u64)>) -> RedactedLeaderboard {
    user_scores.sort_by(|a, b| b.1.cmp(&a.1));
    let entries: Vec<[u8; 32]> = user_scores.iter().map(|(hash, _)| *hash).collect();

    let mut h = Sha256::new();
    for entry in &entries {
        h.update(entry);
    }
    let epoch_root: [u8; 32] = h.finalize().into();

    RedactedLeaderboard {
        entries,
        epoch_root,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_event(kind: ScoreEventKind, value: u64) -> DegenScoreEvent {
        DegenScoreEvent {
            user_hash: [0xDEu8; 32],
            event_kind: kind,
            value_lamports: value,
            proof_hash: [0u8; 32],
            slot: 100,
        }
    }

    #[test]
    fn test_score_deterministic() {
        let events = vec![
            make_event(ScoreEventKind::RentReclaimed, 1000),
            make_event(ScoreEventKind::ChaffJobCompleted, 500),
        ];
        let s1 = compute_epoch_score(&events);
        let s2 = compute_epoch_score(&events);
        assert_eq!(s1, s2);
        // 1000*1 + 500*2 = 2000
        assert_eq!(s1, 2000);
    }

    #[test]
    fn test_puzzle_solved_weighted_higher() {
        let rent_event = make_event(ScoreEventKind::RentReclaimed, 1000);
        let puzzle_event = make_event(ScoreEventKind::PuzzleSolved, 1000);
        let rent_score = compute_epoch_score(&[rent_event]);
        let puzzle_score = compute_epoch_score(&[puzzle_event]);
        assert!(puzzle_score > rent_score);
        assert_eq!(puzzle_score, 5000); // 1000 * 5
        assert_eq!(rent_score, 1000); // 1000 * 1
    }

    #[test]
    fn test_redacted_leaderboard_hides_raw_wallet() {
        let user1 = [0x01u8; 32];
        let user2 = [0x02u8; 32];
        let lb = leaderboard_redacted(vec![(user1, 5000), (user2, 10000)]);
        // entries are [u8;32] hashes, not readable strings
        assert_eq!(lb.entries.len(), 2);
        // sorted: user2 (10000) first
        assert_eq!(lb.entries[0], user2);
        assert_eq!(lb.entries[1], user1);
        // epoch_root is a hash, not raw wallet
        assert_ne!(lb.epoch_root, [0u8; 32]);
    }

    #[test]
    fn test_badge_hash_generated() {
        let events = vec![make_event(ScoreEventKind::RentReclaimed, 1000)];
        let badge = generate_badge([0xDEu8; 32], &events);
        assert_ne!(badge.badge_hash, [0u8; 32]);
        assert_eq!(badge.events_count, 1);
    }

    #[test]
    fn test_anti_sybil_minimum_work() {
        let events = vec![
            make_event(ScoreEventKind::RentReclaimed, 500),
            make_event(ScoreEventKind::ChaffJobCompleted, 300),
        ];
        assert!(anti_sybil_minimum_work(&events, 700));
        assert!(!anti_sybil_minimum_work(&events, 900));
    }
}
