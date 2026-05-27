use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Constants ──────────────────────────────────────────────────────────────

pub const MAX_BATCH: usize = 64;

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NullifierBatch {
    pub batch_id: [u8; 32],
    pub batch_root: [u8; 32],
    pub nullifiers: Vec<[u8; 32]>,
    pub committed: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum BatchError {
    EmptyBatch,
    TooLarge,
    AlreadyCommitted,
    DuplicateNullifier,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn xor_fold(bufs: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = [0u8; 32];
    for b in bufs {
        for i in 0..32 {
            acc[i] ^= b[i];
        }
    }
    acc
}

fn nullifier_entry(nullifier: &[u8; 32], idx: u32) -> [u8; 32] {
    sha256_multi(&[b"bnull-entry-v1", nullifier, &idx.to_le_bytes()])
}

fn compute_batch_root(nullifiers: &[[u8; 32]]) -> [u8; 32] {
    let count = nullifiers.len() as u32;
    let entries: Vec<[u8; 32]> = nullifiers
        .iter()
        .enumerate()
        .map(|(i, n)| nullifier_entry(n, i as u32))
        .collect();
    let xor = xor_fold(&entries);
    sha256_multi(&[b"bnull-root-v1", &xor, &count.to_le_bytes()])
}

fn compute_batch_id(batch_root: &[u8; 32], committed: bool) -> [u8; 32] {
    let committed_byte = if committed { 1u8 } else { 0u8 };
    sha256_multi(&[b"bnull-id-v1", batch_root, &[committed_byte]])
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn new_batch() -> NullifierBatch {
    NullifierBatch {
        batch_id: [0u8; 32],
        batch_root: [0u8; 32],
        nullifiers: Vec::new(),
        committed: false,
        mainnet_ready: false,
    }
}

pub fn add_nullifier(batch: &mut NullifierBatch, nullifier: [u8; 32]) -> Result<(), BatchError> {
    if batch.committed {
        return Err(BatchError::AlreadyCommitted);
    }
    if batch.nullifiers.len() >= MAX_BATCH {
        return Err(BatchError::TooLarge);
    }
    if batch.nullifiers.contains(&nullifier) {
        return Err(BatchError::DuplicateNullifier);
    }
    batch.nullifiers.push(nullifier);
    Ok(())
}

pub fn commit_batch(batch: &mut NullifierBatch) -> Result<[u8; 32], BatchError> {
    if batch.nullifiers.is_empty() {
        return Err(BatchError::EmptyBatch);
    }
    batch.batch_root = compute_batch_root(&batch.nullifiers);
    batch.committed = true;
    batch.batch_id = compute_batch_id(&batch.batch_root, true);
    Ok(batch.batch_id)
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_nullifiers_to_batch() {
        let mut batch = new_batch();
        let n1 = [0x11u8; 32];
        let n2 = [0x22u8; 32];
        add_nullifier(&mut batch, n1).unwrap();
        add_nullifier(&mut batch, n2).unwrap();
        assert_eq!(batch.nullifiers.len(), 2);
        assert!(!batch.committed);
    }

    #[test]
    fn commit_batch_returns_batch_id() {
        let mut batch = new_batch();
        add_nullifier(&mut batch, [0xaau8; 32]).unwrap();
        let batch_id = commit_batch(&mut batch).unwrap();
        assert!(batch.committed);
        assert_ne!(batch_id, [0u8; 32]);
        // Verify batch_id formula
        let expected_root = compute_batch_root(&batch.nullifiers);
        let expected_id = compute_batch_id(&expected_root, true);
        assert_eq!(batch_id, expected_id);
    }

    #[test]
    fn duplicate_nullifier_rejected() {
        let mut batch = new_batch();
        let n = [0xbbu8; 32];
        add_nullifier(&mut batch, n).unwrap();
        let err = add_nullifier(&mut batch, n).unwrap_err();
        assert_eq!(err, BatchError::DuplicateNullifier);
    }

    #[test]
    fn empty_batch_commit_rejected() {
        let mut batch = new_batch();
        let err = commit_batch(&mut batch).unwrap_err();
        assert_eq!(err, BatchError::EmptyBatch);
    }

    #[test]
    fn too_large_rejected() {
        let mut batch = new_batch();
        for i in 0..MAX_BATCH {
            let mut n = [0u8; 32];
            n[0] = (i & 0xff) as u8;
            n[1] = ((i >> 8) & 0xff) as u8;
            add_nullifier(&mut batch, n).unwrap();
        }
        // 65th nullifier should fail
        let mut extra = [0xffu8; 32];
        extra[31] = 0xfe;
        let err = add_nullifier(&mut batch, extra).unwrap_err();
        assert_eq!(err, BatchError::TooLarge);
    }

    #[test]
    fn mainnet_ready_is_false() {
        let batch = new_batch();
        assert!(!batch.mainnet_ready);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_batch_root_deterministic() {
        let mut b1 = new_batch();
        let mut b2 = new_batch();
        add_nullifier(&mut b1, [0x11u8; 32]).unwrap();
        add_nullifier(&mut b1, [0x22u8; 32]).unwrap();
        add_nullifier(&mut b2, [0x11u8; 32]).unwrap();
        add_nullifier(&mut b2, [0x22u8; 32]).unwrap();
        commit_batch(&mut b1).unwrap();
        commit_batch(&mut b2).unwrap();
        assert_eq!(b1.batch_root, b2.batch_root);
    }

    #[test]
    fn test_batch_root_order_sensitive() {
        let mut b1 = new_batch();
        let mut b2 = new_batch();
        add_nullifier(&mut b1, [0x11u8; 32]).unwrap();
        add_nullifier(&mut b1, [0x22u8; 32]).unwrap();
        add_nullifier(&mut b2, [0x22u8; 32]).unwrap();
        add_nullifier(&mut b2, [0x11u8; 32]).unwrap();
        commit_batch(&mut b1).unwrap();
        commit_batch(&mut b2).unwrap();
        // Index is included in entry hash, so order matters
        assert_ne!(b1.batch_root, b2.batch_root);
    }

    #[test]
    fn test_batch_id_deterministic() {
        let mut b1 = new_batch();
        let mut b2 = new_batch();
        add_nullifier(&mut b1, [0xAAu8; 32]).unwrap();
        add_nullifier(&mut b2, [0xAAu8; 32]).unwrap();
        let id1 = commit_batch(&mut b1).unwrap();
        let id2 = commit_batch(&mut b2).unwrap();
        assert_eq!(id1, id2);
    }

    #[test]
    fn test_add_after_commit_rejected() {
        let mut batch = new_batch();
        add_nullifier(&mut batch, [0x01u8; 32]).unwrap();
        commit_batch(&mut batch).unwrap();
        let err = add_nullifier(&mut batch, [0x02u8; 32]).unwrap_err();
        assert_eq!(err, BatchError::AlreadyCommitted);
    }

    #[test]
    fn test_nullifier_count_stored() {
        let mut batch = new_batch();
        add_nullifier(&mut batch, [0x01u8; 32]).unwrap();
        add_nullifier(&mut batch, [0x02u8; 32]).unwrap();
        add_nullifier(&mut batch, [0x03u8; 32]).unwrap();
        assert_eq!(batch.nullifiers.len(), 3);
    }

    #[test]
    fn test_new_batch_not_committed() {
        let batch = new_batch();
        assert!(!batch.committed);
    }

    #[test]
    fn test_batch_root_nonzero_after_commit() {
        let mut batch = new_batch();
        add_nullifier(&mut batch, [0xFFu8; 32]).unwrap();
        commit_batch(&mut batch).unwrap();
        assert_ne!(batch.batch_root, [0u8; 32]);
    }

    #[test]
    fn test_max_batch_constant() {
        assert_eq!(MAX_BATCH, 64);
    }

    #[test]
    fn test_different_nullifiers_different_root() {
        let mut b1 = new_batch();
        let mut b2 = new_batch();
        add_nullifier(&mut b1, [0xAAu8; 32]).unwrap();
        add_nullifier(&mut b2, [0xBBu8; 32]).unwrap();
        commit_batch(&mut b1).unwrap();
        commit_batch(&mut b2).unwrap();
        assert_ne!(b1.batch_root, b2.batch_root);
    }

    #[test]
    fn test_batch_id_not_equal_to_batch_root() {
        let mut batch = new_batch();
        add_nullifier(&mut batch, [0x01u8; 32]).unwrap();
        commit_batch(&mut batch).unwrap();
        // batch_id is derived from batch_root with a different domain prefix
        assert_ne!(batch.batch_id, batch.batch_root);
    }
}
