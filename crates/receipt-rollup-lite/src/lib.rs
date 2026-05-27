use dark_poseidon_tree::{domain_hash, merkle_node, DOMAIN_NULLIFIER, DOMAIN_RECEIPT};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReceiptNote {
    pub secret: [u8; 32],
    pub scope_hash: [u8; 32],
    pub amount_lamports: u64,
}

impl ReceiptNote {
    pub fn leaf_hash(&self) -> [u8; 32] {
        domain_hash(
            DOMAIN_RECEIPT,
            &[
                self.secret.as_ref(),
                self.scope_hash.as_ref(),
                &self.amount_lamports.to_le_bytes(),
            ],
        )
    }
}

pub fn compute_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    if leaves.is_empty() {
        return [0u8; 32];
    }
    if leaves.len() == 1 {
        return leaves[0];
    }
    let mut layer: Vec<[u8; 32]> = leaves.to_vec();
    while layer.len() > 1 {
        if layer.len() % 2 == 1 {
            layer.push(*layer.last().unwrap());
        }
        layer = layer.chunks(2).map(|c| merkle_node(&c[0], &c[1])).collect();
    }
    layer[0]
}

pub fn nullifier_for(leaf_hash: &[u8; 32], epoch_root: &[u8; 32]) -> [u8; 32] {
    domain_hash(DOMAIN_NULLIFIER, &[leaf_hash.as_ref(), epoch_root.as_ref()])
}

pub struct ReceiptRollup {
    pub epoch: u64,
    pub notes: Vec<ReceiptNote>,
    redeemed: HashSet<[u8; 32]>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RollupError {
    AlreadyRedeemed,
    NotInEpoch,
}

impl ReceiptRollup {
    pub fn new(epoch: u64) -> Self {
        Self {
            epoch,
            notes: Vec::new(),
            redeemed: HashSet::new(),
        }
    }

    pub fn add_note(&mut self, note: ReceiptNote) {
        self.notes.push(note);
    }

    pub fn epoch_root(&self) -> [u8; 32] {
        let leaves: Vec<[u8; 32]> = self.notes.iter().map(|n| n.leaf_hash()).collect();
        compute_root(&leaves)
    }

    /// Redeem a receipt note. Returns the nullifier on success.
    pub fn redeem(&mut self, note: &ReceiptNote) -> Result<[u8; 32], RollupError> {
        let leaf = note.leaf_hash();
        let root = self.epoch_root();
        let null = nullifier_for(&leaf, &root);
        if self.redeemed.contains(&null) {
            return Err(RollupError::AlreadyRedeemed);
        }
        self.redeemed.insert(null);
        Ok(null)
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn note(secret: u8, scope: u8, amount: u64) -> ReceiptNote {
        ReceiptNote {
            secret: [secret; 32],
            scope_hash: [scope; 32],
            amount_lamports: amount,
        }
    }

    #[test]
    fn test_single_note_root_is_leaf_hash() {
        let n = note(1, 2, 100);
        let leaf = n.leaf_hash();
        let mut rollup = ReceiptRollup::new(0);
        rollup.add_note(n);
        assert_eq!(rollup.epoch_root(), leaf);
    }

    #[test]
    fn test_two_notes_root_is_merkle_node() {
        let n1 = note(1, 2, 100);
        let n2 = note(3, 4, 200);
        let h1 = n1.leaf_hash();
        let h2 = n2.leaf_hash();
        let expected = merkle_node(&h1, &h2);

        let mut rollup = ReceiptRollup::new(0);
        rollup.add_note(n1);
        rollup.add_note(n2);
        assert_eq!(rollup.epoch_root(), expected);
    }

    #[test]
    fn test_redeem_once_ok() {
        let n = note(1, 2, 100);
        let mut rollup = ReceiptRollup::new(0);
        rollup.add_note(n.clone());

        assert!(rollup.redeem(&n).is_ok());
        assert_eq!(rollup.redeem(&n), Err(RollupError::AlreadyRedeemed));
    }

    #[test]
    fn test_different_notes_different_nullifiers() {
        let n1 = note(1, 2, 100);
        let n2 = note(3, 4, 200);
        let mut rollup = ReceiptRollup::new(0);
        rollup.add_note(n1.clone());
        rollup.add_note(n2.clone());

        let null1 = rollup.redeem(&n1).unwrap();
        let null2 = rollup.redeem(&n2).unwrap();
        assert_ne!(null1, null2);
    }

    #[test]
    fn test_epoch_root_deterministic() {
        let n1 = note(1, 2, 100);
        let n2 = note(3, 4, 200);

        let mut r1 = ReceiptRollup::new(0);
        r1.add_note(n1.clone());
        r1.add_note(n2.clone());

        let mut r2 = ReceiptRollup::new(0);
        r2.add_note(n1);
        r2.add_note(n2);

        assert_eq!(r1.epoch_root(), r2.epoch_root());
    }

    #[test]
    fn test_empty_rollup_root_is_zero() {
        let rollup = ReceiptRollup::new(0);
        assert_eq!(rollup.epoch_root(), [0u8; 32]);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_leaf_hash_nonzero() {
        let n = note(1, 2, 100);
        assert_ne!(n.leaf_hash(), [0u8; 32]);
    }

    #[test]
    fn test_leaf_hash_deterministic() {
        let n = note(7, 8, 999);
        assert_eq!(n.leaf_hash(), n.leaf_hash());
    }

    #[test]
    fn test_leaf_hash_secret_sensitive() {
        let n1 = note(1, 2, 100);
        let n2 = note(9, 2, 100);
        assert_ne!(n1.leaf_hash(), n2.leaf_hash());
    }

    #[test]
    fn test_leaf_hash_amount_sensitive() {
        let n1 = note(1, 2, 100);
        let n2 = note(1, 2, 200);
        assert_ne!(n1.leaf_hash(), n2.leaf_hash());
    }

    #[test]
    fn test_leaf_hash_scope_sensitive() {
        let n1 = note(1, 2, 100);
        let n2 = note(1, 9, 100);
        assert_ne!(n1.leaf_hash(), n2.leaf_hash());
    }

    #[test]
    fn test_nullifier_nonzero() {
        let n = note(1, 2, 100);
        let leaf = n.leaf_hash();
        let root = [0xBBu8; 32];
        assert_ne!(nullifier_for(&leaf, &root), [0u8; 32]);
    }

    #[test]
    fn test_nullifier_deterministic() {
        let n = note(3, 4, 500);
        let leaf = n.leaf_hash();
        let root = [0xCCu8; 32];
        assert_eq!(nullifier_for(&leaf, &root), nullifier_for(&leaf, &root));
    }

    #[test]
    fn test_epoch_stored() {
        let rollup = ReceiptRollup::new(42);
        assert_eq!(rollup.epoch, 42);
    }

    #[test]
    fn test_add_note_increments_notes_count() {
        let mut rollup = ReceiptRollup::new(0);
        rollup.add_note(note(1, 1, 10));
        rollup.add_note(note(2, 2, 20));
        rollup.add_note(note(3, 3, 30));
        assert_eq!(rollup.notes.len(), 3);
    }

    #[test]
    fn test_compute_root_odd_notes_nonzero() {
        let mut rollup = ReceiptRollup::new(0);
        rollup.add_note(note(1, 1, 10));
        rollup.add_note(note(2, 2, 20));
        rollup.add_note(note(3, 3, 30));
        let root = rollup.epoch_root();
        assert_ne!(root, [0u8; 32]);
    }
}
