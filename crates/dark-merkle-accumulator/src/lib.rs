use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Constants ──────────────────────────────────────────────────────────────

pub const MAX_DEPTH: u8 = 16;

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MerkleAcc {
    pub acc_id: [u8; 32],
    pub root: [u8; 32],
    pub leaves: Vec<[u8; 32]>,
    pub depth: u8,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MerkleProofPath {
    pub leaf_hash: [u8; 32],
    pub siblings: Vec<[u8; 32]>,
    pub root: [u8; 32],
    pub valid: bool,
}

#[derive(Debug, PartialEq)]
pub enum AccError {
    DepthZero,
    DepthTooHigh,
    LeafZero,
    AccFull,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

fn hex(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn compute_acc_id(depth: u8, nonce: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"macc-id-v1");
    d.push(depth);
    d.extend_from_slice(nonce);
    sha256(&d)
}

pub fn compute_leaf_hash(data_bytes: &[u8]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"macc-leaf-v1");
    d.extend_from_slice(data_bytes);
    sha256(&d)
}

fn compute_node(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"macc-node-v1");
    d.extend_from_slice(left);
    d.extend_from_slice(right);
    sha256(&d)
}

/// Build the Merkle root from a padded leaf array of size 2^depth.
fn build_root(leaves: &[[u8; 32]], depth: u8) -> [u8; 32] {
    let capacity = 1usize << depth;
    // Pad leaves to capacity with zeros
    let mut layer: Vec<[u8; 32]> = leaves.to_vec();
    layer.resize(capacity, [0u8; 32]);

    // Reduce upward
    while layer.len() > 1 {
        let mut next = Vec::with_capacity(layer.len() / 2);
        for i in (0..layer.len()).step_by(2) {
            next.push(compute_node(&layer[i], &layer[i + 1]));
        }
        layer = next;
    }
    layer[0]
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn new_accumulator(depth: u8, nonce: &[u8; 32]) -> Result<MerkleAcc, AccError> {
    if depth == 0 {
        return Err(AccError::DepthZero);
    }
    if depth > MAX_DEPTH {
        return Err(AccError::DepthTooHigh);
    }
    let acc_id = compute_acc_id(depth, nonce);
    // Initial root: tree of all-zero leaves
    let root = build_root(&[], depth);
    Ok(MerkleAcc {
        acc_id,
        root,
        leaves: Vec::new(),
        depth,
        mainnet_ready: false,
    })
}

pub fn append_leaf(acc: &mut MerkleAcc, data_bytes: &[u8]) -> Result<[u8; 32], AccError> {
    if data_bytes.is_empty() {
        return Err(AccError::LeafZero);
    }
    let capacity = 1usize << acc.depth;
    if acc.leaves.len() >= capacity {
        return Err(AccError::AccFull);
    }
    let leaf_hash = compute_leaf_hash(data_bytes);
    acc.leaves.push(leaf_hash);
    acc.root = build_root(&acc.leaves, acc.depth);
    Ok(leaf_hash)
}

pub fn prove_membership(acc: &MerkleAcc, leaf_index: usize) -> Option<MerkleProofPath> {
    if leaf_index >= acc.leaves.len() {
        return None;
    }
    let capacity = 1usize << acc.depth;
    let mut layer: Vec<[u8; 32]> = acc.leaves.clone();
    layer.resize(capacity, [0u8; 32]);

    let mut siblings = Vec::new();
    let mut idx = leaf_index;

    for _ in 0..acc.depth {
        let sibling_idx = if idx % 2 == 0 { idx + 1 } else { idx - 1 };
        siblings.push(layer[sibling_idx]);
        let mut next = Vec::with_capacity(layer.len() / 2);
        for i in (0..layer.len()).step_by(2) {
            next.push(compute_node(&layer[i], &layer[i + 1]));
        }
        layer = next;
        idx /= 2;
    }

    Some(MerkleProofPath {
        leaf_hash: acc.leaves[leaf_index],
        siblings,
        root: acc.root,
        valid: true,
    })
}

pub fn acc_public_record(acc: &MerkleAcc) -> String {
    serde_json::json!({
        "acc_id":      hex(&acc.acc_id),
        "root":        hex(&acc.root),
        "leaf_count":  acc.leaves.len(),
        "depth":       acc.depth,
        "mainnet_ready": acc.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn nonce() -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = 0x01;
        n
    }

    // Test 1: append + prove membership
    #[test]
    fn test_append_and_prove_membership() {
        let mut acc = new_accumulator(4, &nonce()).unwrap();
        let lh = append_leaf(&mut acc, b"leaf-data").unwrap();
        let proof = prove_membership(&acc, 0).unwrap();
        assert_eq!(proof.leaf_hash, lh);
        assert_eq!(proof.root, acc.root);
        assert!(proof.valid);
        assert_eq!(proof.siblings.len(), 4);
    }

    // Test 2: root changes on append
    #[test]
    fn test_root_changes_on_append() {
        let mut acc = new_accumulator(4, &nonce()).unwrap();
        let root_init = acc.root;
        append_leaf(&mut acc, b"first").unwrap();
        assert_ne!(acc.root, root_init);
        let root_after_first = acc.root;
        append_leaf(&mut acc, b"second").unwrap();
        assert_ne!(acc.root, root_after_first);
    }

    // Test 3: acc full detection (depth=1 → capacity=2)
    #[test]
    fn test_acc_full_detection() {
        let mut acc = new_accumulator(1, &nonce()).unwrap();
        append_leaf(&mut acc, b"leaf1").unwrap();
        append_leaf(&mut acc, b"leaf2").unwrap();
        let err = append_leaf(&mut acc, b"leaf3").unwrap_err();
        assert_eq!(err, AccError::AccFull);
    }

    // Test 4: depth zero rejected
    #[test]
    fn test_depth_zero_rejected() {
        let err = new_accumulator(0, &nonce()).unwrap_err();
        assert_eq!(err, AccError::DepthZero);
    }

    // Test 5: leaf_hash computation is deterministic
    #[test]
    fn test_leaf_hash_computation() {
        let lh1 = compute_leaf_hash(b"test-data");
        let lh2 = compute_leaf_hash(b"test-data");
        assert_eq!(lh1, lh2);
        // Different data → different hash
        let lh3 = compute_leaf_hash(b"other-data");
        assert_ne!(lh1, lh3);
    }

    // Test 6: root is valid tree root (3-leaf tree)
    #[test]
    fn test_root_is_valid_tree_root() {
        let mut acc = new_accumulator(2, &nonce()).unwrap(); // depth=2 → capacity=4
        let lh0 = append_leaf(&mut acc, b"alpha").unwrap();
        let lh1 = append_leaf(&mut acc, b"beta").unwrap();
        let lh2 = append_leaf(&mut acc, b"gamma").unwrap();
        // Manually build expected root:
        // layer0: [lh0, lh1, lh2, zero]
        // layer1: [node(lh0,lh1), node(lh2,zero)]
        // layer2: [node(node(lh0,lh1), node(lh2,zero))]
        let zero = [0u8; 32];
        let n01 = compute_node(&lh0, &lh1);
        let n23 = compute_node(&lh2, &zero);
        let expected = compute_node(&n01, &n23);
        assert_eq!(acc.root, expected);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_acc_id_nonzero() {
        let acc = new_accumulator(4, &nonce()).unwrap();
        assert_ne!(acc.acc_id, [0u8; 32]);
    }

    #[test]
    fn test_acc_id_deterministic() {
        let a1 = new_accumulator(4, &nonce()).unwrap();
        let a2 = new_accumulator(4, &nonce()).unwrap();
        assert_eq!(a1.acc_id, a2.acc_id);
    }

    #[test]
    fn test_acc_id_nonce_sensitive() {
        let nonce2 = {
            let mut n = [0u8; 32];
            n[0] = 0xFF;
            n
        };
        let a1 = new_accumulator(4, &nonce()).unwrap();
        let a2 = new_accumulator(4, &nonce2).unwrap();
        assert_ne!(a1.acc_id, a2.acc_id);
    }

    #[test]
    fn test_mainnet_ready_false() {
        let acc = new_accumulator(4, &nonce()).unwrap();
        assert!(!acc.mainnet_ready);
    }

    #[test]
    fn test_max_depth_ok() {
        // depth == MAX_DEPTH must succeed; check is `depth > MAX_DEPTH`
        let result = new_accumulator(MAX_DEPTH, &nonce());
        assert!(result.is_ok(), "depth == MAX_DEPTH must succeed");
    }

    #[test]
    fn test_depth_too_high_rejected() {
        let err = new_accumulator(MAX_DEPTH + 1, &nonce()).unwrap_err();
        assert_eq!(err, AccError::DepthTooHigh);
    }

    #[test]
    fn test_leaf_hash_nonzero() {
        let lh = compute_leaf_hash(b"some-data");
        assert_ne!(lh, [0u8; 32]);
    }

    #[test]
    fn test_empty_leaf_rejected() {
        let mut acc = new_accumulator(4, &nonce()).unwrap();
        let err = append_leaf(&mut acc, b"").unwrap_err();
        assert_eq!(err, AccError::LeafZero);
    }

    #[test]
    fn test_prove_membership_out_of_bounds_returns_none() {
        let acc = new_accumulator(4, &nonce()).unwrap();
        assert!(prove_membership(&acc, 0).is_none());
    }

    #[test]
    fn test_root_nonzero_after_append() {
        let mut acc = new_accumulator(4, &nonce()).unwrap();
        append_leaf(&mut acc, b"leaf-data").unwrap();
        assert_ne!(acc.root, [0u8; 32]);
    }
}
