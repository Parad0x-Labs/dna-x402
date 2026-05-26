use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SparseMerkleTree {
    pub tree_id: [u8; 32],
    pub root: [u8; 32],
    pub depth: u8,
    pub leaf_count: u32,
    pub mainnet_ready: bool,
    // internal: all leaf nodes accumulated
    leaf_nodes: Vec<[u8; 32]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SparseLeaf {
    pub key_hash: [u8; 32],
    pub value_hash: [u8; 32],
    pub leaf_node: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum SparseError {
    ZeroKey,
    ZeroValue,
    DepthZero,
    DepthTooHigh,
}

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts { h.update(p); }
    h.finalize().into()
}

fn xor_fold(nodes: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = [0u8; 32];
    for node in nodes {
        for i in 0..32 { acc[i] ^= node[i]; }
    }
    acc
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

fn compute_tree_id(depth: u8, nonce: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"smt-id-v1", &[depth], nonce])
}

fn compute_key_hash(key_bytes: &[u8]) -> [u8; 32] {
    sha256_multi(&[b"smt-key-v1", key_bytes])
}

fn compute_value_hash(value_bytes: &[u8]) -> [u8; 32] {
    sha256_multi(&[b"smt-value-v1", value_bytes])
}

fn compute_leaf_node(key_hash: &[u8; 32], value_hash: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"smt-leaf-v1", key_hash, value_hash])
}

fn compute_root(leaf_nodes: &[[u8; 32]], leaf_count: u32) -> [u8; 32] {
    let folded = xor_fold(leaf_nodes);
    sha256_multi(&[b"smt-root-v1", &folded, &leaf_count.to_le_bytes()])
}

fn compute_empty_root(depth: u8) -> [u8; 32] {
    sha256_multi(&[b"smt-empty-v1", &[depth]])
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Create a new sparse Merkle tree.
///
/// Errors: DepthZero, DepthTooHigh (>32)
pub fn new_tree(depth: u8, nonce: &[u8; 32]) -> Result<SparseMerkleTree, SparseError> {
    if depth == 0 {
        return Err(SparseError::DepthZero);
    }
    if depth > 32 {
        return Err(SparseError::DepthTooHigh);
    }
    let tree_id = compute_tree_id(depth, nonce);
    let root = compute_empty_root(depth);
    Ok(SparseMerkleTree {
        tree_id,
        root,
        depth,
        leaf_count: 0,
        mainnet_ready: false,
        leaf_nodes: Vec::new(),
    })
}

/// Insert a key-value pair into the tree.
/// Updates the root.
///
/// Errors: ZeroKey (empty key), ZeroValue (empty value)
pub fn insert(
    tree: &mut SparseMerkleTree,
    key_bytes: &[u8],
    value_bytes: &[u8],
) -> Result<SparseLeaf, SparseError> {
    if key_bytes.is_empty() {
        return Err(SparseError::ZeroKey);
    }
    if value_bytes.is_empty() {
        return Err(SparseError::ZeroValue);
    }
    let key_hash = compute_key_hash(key_bytes);
    let value_hash = compute_value_hash(value_bytes);
    let leaf_node = compute_leaf_node(&key_hash, &value_hash);

    tree.leaf_nodes.push(leaf_node);
    tree.leaf_count += 1;
    tree.root = compute_root(&tree.leaf_nodes, tree.leaf_count);

    Ok(SparseLeaf { key_hash, value_hash, leaf_node })
}

/// Check if a leaf (key, value) is in the provided list of leaf_nodes.
pub fn contains(
    _tree: &SparseMerkleTree,
    leaf_nodes: &[[u8; 32]],
    key_bytes: &[u8],
    value_bytes: &[u8],
) -> bool {
    if key_bytes.is_empty() || value_bytes.is_empty() {
        return false;
    }
    let key_hash = compute_key_hash(key_bytes);
    let value_hash = compute_value_hash(value_bytes);
    let target = compute_leaf_node(&key_hash, &value_hash);
    leaf_nodes.iter().any(|n| *n == target)
}

/// Public JSON record: tree_id, root, leaf_count, depth, mainnet_ready.
pub fn tree_public_record(tree: &SparseMerkleTree) -> String {
    let tree_id_hex: String = tree.tree_id.iter().map(|b| format!("{:02x}", b)).collect();
    let root_hex: String = tree.root.iter().map(|b| format!("{:02x}", b)).collect();
    serde_json::json!({
        "tree_id": tree_id_hex,
        "root": root_hex,
        "leaf_count": tree.leaf_count,
        "depth": tree.depth,
        "mainnet_ready": tree.mainnet_ready,
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn nonce() -> [u8; 32] { let mut n = [0u8; 32]; n[0] = 0x5A; n }

    #[test]
    fn test_insert_and_contains() {
        let mut tree = new_tree(16, &nonce()).unwrap();
        assert!(!tree.mainnet_ready);

        let leaf = insert(&mut tree, b"key-alpha", b"value-alpha").unwrap();
        assert_eq!(leaf.leaf_node.len(), 32);

        let leaf_nodes: Vec<[u8; 32]> = vec![leaf.leaf_node];
        assert!(contains(&tree, &leaf_nodes, b"key-alpha", b"value-alpha"));
    }

    #[test]
    fn test_root_changes_on_insert() {
        let mut tree = new_tree(8, &nonce()).unwrap();
        let initial_root = tree.root;
        insert(&mut tree, b"k1", b"v1").unwrap();
        assert_ne!(tree.root, initial_root);
    }

    #[test]
    fn test_empty_root_is_correct() {
        let tree = new_tree(4, &nonce()).unwrap();
        let expected = sha2::Sha256::new()
            .chain_update(b"smt-empty-v1")
            .chain_update(&[4u8])
            .finalize();
        let expected_arr: [u8; 32] = expected.into();
        assert_eq!(tree.root, expected_arr);
    }

    #[test]
    fn test_depth_zero_rejected() {
        let err = new_tree(0, &nonce()).unwrap_err();
        assert_eq!(err, SparseError::DepthZero);
    }

    #[test]
    fn test_different_key_value_different_leaf_nodes() {
        let mut tree = new_tree(10, &nonce()).unwrap();
        let l1 = insert(&mut tree, b"key-one", b"value-one").unwrap();
        let l2 = insert(&mut tree, b"key-two", b"value-two").unwrap();
        assert_ne!(l1.leaf_node, l2.leaf_node);
    }

    #[test]
    fn test_contains_returns_false_for_absent_key() {
        let mut tree = new_tree(8, &nonce()).unwrap();
        let leaf = insert(&mut tree, b"present-key", b"present-value").unwrap();
        let leaf_nodes: Vec<[u8; 32]> = vec![leaf.leaf_node];
        assert!(!contains(&tree, &leaf_nodes, b"absent-key", b"absent-value"));
    }
}
