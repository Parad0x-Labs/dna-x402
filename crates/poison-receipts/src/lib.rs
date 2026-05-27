use sha2::{Digest, Sha256};

pub const DOMAIN_REAL: u8 = 0x80;
pub const DOMAIN_POISON: u8 = 0x81;
pub const LEAF_LEN: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReceiptLeafKind {
    RealSpendCommitment,
    DelayedSettlement,
    DecoyPoison,
    MaintenanceChaff,
    BatchCheckpoint,
}

#[derive(Clone, Debug)]
pub struct ReceiptLeaf {
    pub kind: ReceiptLeafKind,
    pub leaf_hash: [u8; LEAF_LEN],
    pub epoch: u64,
}

impl ReceiptLeaf {
    pub fn new_real(commitment: &[u8; 32], scope: &[u8; 32], epoch: u64) -> Self {
        let mut h = Sha256::new();
        h.update([DOMAIN_REAL]);
        h.update(commitment);
        h.update(scope);
        h.update(epoch.to_le_bytes());
        Self {
            kind: ReceiptLeafKind::RealSpendCommitment,
            leaf_hash: h.finalize().into(),
            epoch,
        }
    }

    pub fn new_poison(entropy: &[u8; 32], fake_scope: &[u8; 32], epoch: u64) -> Self {
        let mut h = Sha256::new();
        h.update([DOMAIN_POISON]);
        h.update(entropy);
        h.update(fake_scope);
        h.update(epoch.to_le_bytes());
        Self {
            kind: ReceiptLeafKind::DecoyPoison,
            leaf_hash: h.finalize().into(),
            epoch,
        }
    }

    pub fn is_poison(&self) -> bool {
        self.kind == ReceiptLeafKind::DecoyPoison
    }
    pub fn is_real(&self) -> bool {
        self.kind == ReceiptLeafKind::RealSpendCommitment
    }
}

pub struct MixedBatch {
    pub leaves: Vec<ReceiptLeaf>,
}

impl MixedBatch {
    pub fn new() -> Self {
        Self { leaves: vec![] }
    }
    pub fn add(&mut self, leaf: ReceiptLeaf) {
        self.leaves.push(leaf);
    }

    pub fn batch_root(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update([DOMAIN_REAL, 0xBB]);
        for l in &self.leaves {
            h.update(&l.leaf_hash);
        }
        h.finalize().into()
    }

    pub fn poison_ratio(&self) -> f32 {
        if self.leaves.is_empty() {
            return 0.0;
        }
        let poison = self.leaves.iter().filter(|l| l.is_poison()).count();
        poison as f32 / self.leaves.len() as f32
    }

    pub fn real_count(&self) -> usize {
        self.leaves.iter().filter(|l| l.is_real()).count()
    }
    pub fn poison_count(&self) -> usize {
        self.leaves.iter().filter(|l| l.is_poison()).count()
    }
}

impl Default for MixedBatch {
    fn default() -> Self {
        Self::new()
    }
}

/// Poison leaves never redeem — domain separation prevents collision
pub fn can_redeem(leaf: &ReceiptLeaf) -> bool {
    leaf.kind == ReceiptLeafKind::RealSpendCommitment
}

/// Same public byte length: both kinds produce 32-byte leaf hashes
pub fn public_leaf_size(_leaf: &ReceiptLeaf) -> usize {
    LEAF_LEN
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_real_leaf_can_redeem() {
        let commitment = [1u8; 32];
        let scope = [2u8; 32];
        let leaf = ReceiptLeaf::new_real(&commitment, &scope, 42);
        assert!(can_redeem(&leaf));
        assert!(leaf.is_real());
        assert!(!leaf.is_poison());
    }

    #[test]
    fn test_poison_leaf_cannot_redeem() {
        let entropy = [3u8; 32];
        let fake_scope = [4u8; 32];
        let leaf = ReceiptLeaf::new_poison(&entropy, &fake_scope, 42);
        assert!(!can_redeem(&leaf));
        assert!(leaf.is_poison());
        assert!(!leaf.is_real());
    }

    #[test]
    fn test_domain_separation() {
        let data = [7u8; 32];
        let scope = [8u8; 32];
        let real_leaf = ReceiptLeaf::new_real(&data, &scope, 1);
        let poison_leaf = ReceiptLeaf::new_poison(&data, &scope, 1);
        // Same input data but different domains → different hashes
        assert_ne!(real_leaf.leaf_hash, poison_leaf.leaf_hash);
    }

    #[test]
    fn test_batch_root_changes_with_leaves() {
        let commitment = [1u8; 32];
        let scope = [2u8; 32];
        let mut batch_a = MixedBatch::new();
        let mut batch_b = MixedBatch::new();
        batch_a.add(ReceiptLeaf::new_real(&commitment, &scope, 1));
        batch_b.add(ReceiptLeaf::new_real(&commitment, &scope, 1));
        batch_b.add(ReceiptLeaf::new_poison(&[9u8; 32], &[10u8; 32], 1));
        assert_ne!(batch_a.batch_root(), batch_b.batch_root());
        // Empty batch has deterministic root
        let empty = MixedBatch::new();
        assert_ne!(batch_a.batch_root(), empty.batch_root());
    }

    #[test]
    fn test_poison_ratio() {
        let mut batch = MixedBatch::new();
        assert_eq!(batch.poison_ratio(), 0.0);
        batch.add(ReceiptLeaf::new_real(&[1u8; 32], &[2u8; 32], 1));
        batch.add(ReceiptLeaf::new_poison(&[3u8; 32], &[4u8; 32], 1));
        batch.add(ReceiptLeaf::new_poison(&[5u8; 32], &[6u8; 32], 1));
        assert_eq!(batch.real_count(), 1);
        assert_eq!(batch.poison_count(), 2);
        let ratio = batch.poison_ratio();
        assert!((ratio - 2.0 / 3.0).abs() < 1e-5);
    }

    #[test]
    fn test_same_public_size() {
        let real_leaf = ReceiptLeaf::new_real(&[1u8; 32], &[2u8; 32], 0);
        let poison_leaf = ReceiptLeaf::new_poison(&[3u8; 32], &[4u8; 32], 0);
        assert_eq!(public_leaf_size(&real_leaf), LEAF_LEN);
        assert_eq!(public_leaf_size(&poison_leaf), LEAF_LEN);
        assert_eq!(real_leaf.leaf_hash.len(), poison_leaf.leaf_hash.len());
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_leaf_hash_nonzero_real() {
        let leaf = ReceiptLeaf::new_real(&[1u8; 32], &[2u8; 32], 10);
        assert_ne!(leaf.leaf_hash, [0u8; 32]);
    }

    #[test]
    fn test_leaf_hash_nonzero_poison() {
        let leaf = ReceiptLeaf::new_poison(&[3u8; 32], &[4u8; 32], 10);
        assert_ne!(leaf.leaf_hash, [0u8; 32]);
    }

    #[test]
    fn test_real_leaf_commitment_sensitive() {
        let l1 = ReceiptLeaf::new_real(&[1u8; 32], &[2u8; 32], 5);
        let l2 = ReceiptLeaf::new_real(&[9u8; 32], &[2u8; 32], 5);
        assert_ne!(l1.leaf_hash, l2.leaf_hash);
    }

    #[test]
    fn test_poison_leaf_entropy_sensitive() {
        let l1 = ReceiptLeaf::new_poison(&[1u8; 32], &[2u8; 32], 5);
        let l2 = ReceiptLeaf::new_poison(&[9u8; 32], &[2u8; 32], 5);
        assert_ne!(l1.leaf_hash, l2.leaf_hash);
    }

    #[test]
    fn test_epoch_stored_in_leaf() {
        let real = ReceiptLeaf::new_real(&[1u8; 32], &[2u8; 32], 77);
        let poison = ReceiptLeaf::new_poison(&[3u8; 32], &[4u8; 32], 88);
        assert_eq!(real.epoch, 77);
        assert_eq!(poison.epoch, 88);
    }

    #[test]
    fn test_batch_root_nonzero() {
        let mut batch = MixedBatch::new();
        batch.add(ReceiptLeaf::new_real(&[1u8; 32], &[2u8; 32], 1));
        assert_ne!(batch.batch_root(), [0u8; 32]);
    }

    #[test]
    fn test_batch_root_deterministic() {
        let mut b1 = MixedBatch::new();
        b1.add(ReceiptLeaf::new_real(&[1u8; 32], &[2u8; 32], 1));
        let mut b2 = MixedBatch::new();
        b2.add(ReceiptLeaf::new_real(&[1u8; 32], &[2u8; 32], 1));
        assert_eq!(b1.batch_root(), b2.batch_root());
    }

    #[test]
    fn test_real_and_poison_counts() {
        let mut batch = MixedBatch::new();
        batch.add(ReceiptLeaf::new_real(&[1u8; 32], &[2u8; 32], 1));
        batch.add(ReceiptLeaf::new_real(&[3u8; 32], &[4u8; 32], 1));
        batch.add(ReceiptLeaf::new_poison(&[5u8; 32], &[6u8; 32], 1));
        batch.add(ReceiptLeaf::new_poison(&[7u8; 32], &[8u8; 32], 1));
        batch.add(ReceiptLeaf::new_poison(&[9u8; 32], &[10u8; 32], 1));
        assert_eq!(batch.real_count(), 2);
        assert_eq!(batch.poison_count(), 3);
    }

    #[test]
    fn test_empty_batch_root_deterministic() {
        let r1 = MixedBatch::new().batch_root();
        let r2 = MixedBatch::new().batch_root();
        assert_eq!(r1, r2);
    }

    #[test]
    fn test_scope_sensitive_real_leaf_hash() {
        let l1 = ReceiptLeaf::new_real(&[1u8; 32], &[2u8; 32], 1);
        let l2 = ReceiptLeaf::new_real(&[1u8; 32], &[99u8; 32], 1);
        assert_ne!(l1.leaf_hash, l2.leaf_hash);
    }
}
