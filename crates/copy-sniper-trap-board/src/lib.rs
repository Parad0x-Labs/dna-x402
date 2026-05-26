use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum LeafKind {
    Real,
    Decoy,
    Poison,
    Delayed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrapLeaf {
    pub kind: LeafKind,
    pub leaf_hash: [u8; 32],
    pub reveal_slot: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrapBoard {
    pub board_id: [u8; 32],
    pub market_hash: [u8; 32],
    pub public_leaves: Vec<TrapLeaf>,
    pub poison_count: usize,
    pub real_count: usize,
    pub delayed_count: usize,
    pub reveal_policy_hash: [u8; 32],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SniperReport {
    pub leaf_hash: [u8; 32],
    pub flagged_as_poison: bool,
    pub copy_risk_score: f64,
}

pub fn create_board(
    market_hash: [u8; 32],
    real_leaf_seed: &[u8],
    decoy_count: usize,
    poison_count: usize,
    delay_slots: u64,
) -> TrapBoard {
    let mut leaves = Vec::new();

    // Real leaf
    let mut h = Sha256::new();
    h.update(b"real_leaf:");
    h.update(real_leaf_seed);
    let real_hash: [u8; 32] = h.finalize().into();
    leaves.push(TrapLeaf {
        kind: LeafKind::Real,
        leaf_hash: real_hash,
        reveal_slot: 0,
    });

    // Decoy leaves
    for i in 0..decoy_count {
        let mut h = Sha256::new();
        h.update(b"decoy_leaf:");
        h.update(&(i as u64).to_le_bytes());
        h.update(market_hash);
        let decoy_hash: [u8; 32] = h.finalize().into();
        leaves.push(TrapLeaf {
            kind: LeafKind::Decoy,
            leaf_hash: decoy_hash,
            reveal_slot: 0,
        });
    }

    // Poison leaves
    for i in 0..poison_count {
        let mut h = Sha256::new();
        h.update(b"poison_leaf:");
        h.update(&(i as u64).to_le_bytes());
        h.update(market_hash);
        let poison_hash: [u8; 32] = h.finalize().into();
        leaves.push(TrapLeaf {
            kind: LeafKind::Poison,
            leaf_hash: poison_hash,
            reveal_slot: delay_slots,
        });
    }

    let mut board_h = Sha256::new();
    board_h.update(b"trap_board_v1:");
    board_h.update(market_hash);
    let board_id: [u8; 32] = board_h.finalize().into();

    let mut policy_h = Sha256::new();
    policy_h.update(b"reveal_policy:");
    policy_h.update(market_hash);
    let reveal_policy_hash: [u8; 32] = policy_h.finalize().into();

    let real_count = 1usize;
    let delayed_count = poison_count; // poison leaves have delay slots set

    TrapBoard {
        board_id,
        market_hash,
        public_leaves: leaves,
        poison_count,
        real_count,
        delayed_count,
        reveal_policy_hash,
    }
}

pub fn detect_poison_redeemer(board: &TrapBoard, redeemed_leaf_hash: [u8; 32]) -> SniperReport {
    let flagged_as_poison = board
        .public_leaves
        .iter()
        .any(|leaf| leaf.kind == LeafKind::Poison && leaf.leaf_hash == redeemed_leaf_hash);
    let copy_risk_score = compute_copy_risk(board);

    SniperReport {
        leaf_hash: redeemed_leaf_hash,
        flagged_as_poison,
        copy_risk_score,
    }
}

pub fn compute_copy_risk(board: &TrapBoard) -> f64 {
    let n = board.public_leaves.len();
    if n == 0 {
        return 1.0;
    }
    1.0 / n as f64
}

pub fn board_root(board: &TrapBoard) -> [u8; 32] {
    let mut h = Sha256::new();
    for leaf in &board.public_leaves {
        h.update(leaf.leaf_hash);
    }
    h.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn market() -> [u8; 32] {
        [0xA0u8; 32]
    }

    fn get_poison_hash(board: &TrapBoard) -> [u8; 32] {
        board
            .public_leaves
            .iter()
            .find(|l| l.kind == LeafKind::Poison)
            .unwrap()
            .leaf_hash
    }

    fn get_real_hash(board: &TrapBoard) -> [u8; 32] {
        board
            .public_leaves
            .iter()
            .find(|l| l.kind == LeafKind::Real)
            .unwrap()
            .leaf_hash
    }

    #[test]
    fn test_poison_redeemer_flagged() {
        let board = create_board(market(), b"seed", 3, 1, 500);
        let poison_hash = get_poison_hash(&board);
        let report = detect_poison_redeemer(&board, poison_hash);
        assert!(report.flagged_as_poison);
    }

    #[test]
    fn test_real_leaf_not_flagged() {
        let board = create_board(market(), b"seed", 3, 1, 500);
        let real_hash = get_real_hash(&board);
        let report = detect_poison_redeemer(&board, real_hash);
        assert!(!report.flagged_as_poison);
    }

    #[test]
    fn test_copy_risk_decreases_with_more_leaves() {
        let board_small = create_board(market(), b"seed", 1, 0, 0);
        let board_large = create_board(market(), b"seed", 9, 0, 0);
        assert!(compute_copy_risk(&board_small) > compute_copy_risk(&board_large));
    }

    #[test]
    fn test_board_root_deterministic() {
        let board1 = create_board(market(), b"seed", 3, 1, 500);
        let board2 = create_board(market(), b"seed", 3, 1, 500);
        assert_eq!(board_root(&board1), board_root(&board2));
    }

    #[test]
    fn test_delayed_reveal_slot_set() {
        let board = create_board(market(), b"seed", 2, 1, 999);
        let poison_leaf = board
            .public_leaves
            .iter()
            .find(|l| l.kind == LeafKind::Poison)
            .unwrap();
        assert_eq!(poison_leaf.reveal_slot, 999);
    }

    #[test]
    fn test_copy_precision_with_5_leaves() {
        let board = create_board(market(), b"seed", 3, 1, 0);
        // 1 real + 3 decoy + 1 poison = 5 leaves
        assert_eq!(board.public_leaves.len(), 5);
        let risk = compute_copy_risk(&board);
        let expected = 1.0 / 5.0;
        assert!((risk - expected).abs() < 1e-9);
    }
}
