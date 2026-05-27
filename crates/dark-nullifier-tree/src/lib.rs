use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Constants ──────────────────────────────────────────────────────────────

pub const MAX_TREE_DEPTH: u8 = 20;

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NullifierTree {
    pub tree_id: [u8; 32],
    pub root: [u8; 32],
    pub count: u32,
    pub depth: u8,
    pub mainnet_ready: bool,
    // internal: store inserted nullifiers for duplicate detection
    #[serde(skip)]
    pub(crate) nullifiers: Vec<[u8; 32]>,
    // internal: store leaf_hashes for root computation
    #[serde(skip)]
    pub(crate) leaf_hashes: Vec<[u8; 32]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NullifierLeaf {
    pub nullifier: [u8; 32],
    pub leaf_hash: [u8; 32],
    pub position: u32,
}

#[derive(Debug, PartialEq)]
pub enum TreeError {
    ZeroNullifier,
    AlreadyInserted,
    TreeFull,
    DepthZero,
    DepthTooHigh,
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

fn xor_fold(hashes: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = [0u8; 32];
    for h in hashes {
        for i in 0..32 {
            acc[i] ^= h[i];
        }
    }
    acc
}

fn compute_tree_id(depth: u8, nonce: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"ntree-id-v1");
    d.push(depth);
    d.extend_from_slice(nonce);
    sha256(&d)
}

fn compute_leaf_hash(nullifier: &[u8; 32], position: u32) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"ntree-leaf-v1");
    d.extend_from_slice(nullifier);
    d.extend_from_slice(&position.to_le_bytes());
    sha256(&d)
}

fn compute_root(leaf_hashes: &[[u8; 32]], count: u32) -> [u8; 32] {
    if leaf_hashes.is_empty() {
        // empty tree root
        let mut d = Vec::new();
        d.extend_from_slice(b"ntree-root-v1");
        d.extend_from_slice(&[0u8; 32]);
        d.extend_from_slice(&0u32.to_le_bytes());
        return sha256(&d);
    }
    let xor = xor_fold(leaf_hashes);
    let mut d = Vec::new();
    d.extend_from_slice(b"ntree-root-v1");
    d.extend_from_slice(&xor);
    d.extend_from_slice(&count.to_le_bytes());
    sha256(&d)
}

fn capacity(depth: u8) -> u64 {
    1u64 << (depth as u64)
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn new_tree(depth: u8, nonce: &[u8; 32]) -> Result<NullifierTree, TreeError> {
    if depth == 0 {
        return Err(TreeError::DepthZero);
    }
    if depth > MAX_TREE_DEPTH {
        return Err(TreeError::DepthTooHigh);
    }
    let tree_id = compute_tree_id(depth, nonce);
    let root = compute_root(&[], 0);
    Ok(NullifierTree {
        tree_id,
        root,
        count: 0,
        depth,
        mainnet_ready: false,
        nullifiers: Vec::new(),
        leaf_hashes: Vec::new(),
    })
}

pub fn insert_nullifier(
    tree: &mut NullifierTree,
    nullifier: &[u8; 32],
) -> Result<NullifierLeaf, TreeError> {
    if nullifier == &[0u8; 32] {
        return Err(TreeError::ZeroNullifier);
    }
    if tree.nullifiers.contains(nullifier) {
        return Err(TreeError::AlreadyInserted);
    }
    let cap = capacity(tree.depth);
    if (tree.count as u64) >= cap {
        return Err(TreeError::TreeFull);
    }

    let position = tree.count;
    let leaf_hash = compute_leaf_hash(nullifier, position);
    tree.nullifiers.push(*nullifier);
    tree.leaf_hashes.push(leaf_hash);
    tree.count += 1;
    tree.root = compute_root(&tree.leaf_hashes, tree.count);

    Ok(NullifierLeaf {
        nullifier: *nullifier,
        leaf_hash,
        position,
    })
}

pub fn contains(tree: &NullifierTree, nullifier: &[u8; 32]) -> bool {
    tree.nullifiers.contains(nullifier)
}

pub fn tree_public_record(tree: &NullifierTree) -> String {
    serde_json::json!({
        "tree_id": hex(&tree.tree_id),
        "root": hex(&tree.root),
        "count": tree.count,
        "depth": tree.depth,
        "mainnet_ready": tree.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn nonce() -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = 0xaa;
        n
    }

    fn null(b: u8) -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = b + 1;
        n
    }

    // Test 1: insert + contains
    #[test]
    fn test_insert_and_contains() {
        let mut tree = new_tree(4, &nonce()).unwrap();
        assert!(!tree.mainnet_ready);
        let leaf = insert_nullifier(&mut tree, &null(1)).unwrap();
        assert!(contains(&tree, &null(1)));
        assert!(!contains(&tree, &null(2)));
        assert_eq!(leaf.position, 0);
        assert_eq!(tree.count, 1);
    }

    // Test 2: double insert rejected
    #[test]
    fn test_double_insert_rejected() {
        let mut tree = new_tree(4, &nonce()).unwrap();
        insert_nullifier(&mut tree, &null(5)).unwrap();
        let err = insert_nullifier(&mut tree, &null(5)).unwrap_err();
        assert_eq!(err, TreeError::AlreadyInserted);
    }

    // Test 3: root changes on insert
    #[test]
    fn test_root_changes_on_insert() {
        let mut tree = new_tree(4, &nonce()).unwrap();
        let root0 = tree.root;
        insert_nullifier(&mut tree, &null(1)).unwrap();
        let root1 = tree.root;
        assert_ne!(root0, root1);
        insert_nullifier(&mut tree, &null(2)).unwrap();
        let root2 = tree.root;
        assert_ne!(root1, root2);
    }

    // Test 4: tree full detection for small depth (depth=1 → capacity=2)
    #[test]
    fn test_tree_full() {
        let mut tree = new_tree(1, &nonce()).unwrap();
        insert_nullifier(&mut tree, &null(1)).unwrap();
        insert_nullifier(&mut tree, &null(2)).unwrap();
        let err = insert_nullifier(&mut tree, &null(3)).unwrap_err();
        assert_eq!(err, TreeError::TreeFull);
    }

    // Test 5: depth zero rejected
    #[test]
    fn test_depth_zero_rejected() {
        let err = new_tree(0, &nonce()).unwrap_err();
        assert_eq!(err, TreeError::DepthZero);
    }

    // Test 6: public record correct
    #[test]
    fn test_public_record_correct() {
        let mut tree = new_tree(8, &nonce()).unwrap();
        insert_nullifier(&mut tree, &null(1)).unwrap();
        let record = tree_public_record(&tree);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["tree_id"].is_string());
        assert!(v["root"].is_string());
        assert_eq!(v["count"], 1u32);
        assert_eq!(v["depth"], 8u8);
        assert_eq!(v["mainnet_ready"], false);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_tree_id_nonzero() {
        let tree = new_tree(4, &nonce()).unwrap();
        assert_ne!(tree.tree_id, [0u8; 32]);
    }

    #[test]
    fn test_tree_id_deterministic() {
        let t1 = new_tree(4, &nonce()).unwrap();
        let t2 = new_tree(4, &nonce()).unwrap();
        assert_eq!(t1.tree_id, t2.tree_id);
    }

    #[test]
    fn test_tree_id_nonce_sensitive() {
        let n1 = nonce();
        let mut n2 = nonce();
        n2[1] = 0xFF;
        let t1 = new_tree(4, &n1).unwrap();
        let t2 = new_tree(4, &n2).unwrap();
        assert_ne!(t1.tree_id, t2.tree_id);
    }

    #[test]
    fn test_mainnet_ready_false() {
        let tree = new_tree(4, &nonce()).unwrap();
        assert!(!tree.mainnet_ready);
    }

    #[test]
    fn test_zero_nullifier_rejected() {
        let mut tree = new_tree(4, &nonce()).unwrap();
        let err = insert_nullifier(&mut tree, &[0u8; 32]).unwrap_err();
        assert_eq!(err, TreeError::ZeroNullifier);
    }

    #[test]
    fn test_max_depth_ok() {
        // depth == MAX_TREE_DEPTH (20) must succeed; check is `> MAX_TREE_DEPTH`
        let result = new_tree(MAX_TREE_DEPTH, &nonce());
        assert!(result.is_ok(), "depth == MAX_TREE_DEPTH must succeed");
    }

    #[test]
    fn test_depth_too_high_rejected() {
        let err = new_tree(MAX_TREE_DEPTH + 1, &nonce()).unwrap_err();
        assert_eq!(err, TreeError::DepthTooHigh);
    }

    #[test]
    fn test_leaf_hash_nonzero() {
        let mut tree = new_tree(4, &nonce()).unwrap();
        let leaf = insert_nullifier(&mut tree, &null(1)).unwrap();
        assert_ne!(leaf.leaf_hash, [0u8; 32]);
    }

    #[test]
    fn test_leaf_position_increments() {
        let mut tree = new_tree(4, &nonce()).unwrap();
        let l0 = insert_nullifier(&mut tree, &null(1)).unwrap();
        let l1 = insert_nullifier(&mut tree, &null(2)).unwrap();
        assert_eq!(l0.position, 0);
        assert_eq!(l1.position, 1);
    }

    #[test]
    fn test_root_nonzero_after_insert() {
        let mut tree = new_tree(4, &nonce()).unwrap();
        insert_nullifier(&mut tree, &null(1)).unwrap();
        assert_ne!(tree.root, [0u8; 32]);
    }
}
