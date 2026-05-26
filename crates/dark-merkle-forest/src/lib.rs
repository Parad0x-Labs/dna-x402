use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Constants ──────────────────────────────────────────────────────────────

pub const MAX_TREES: u32 = 64;

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MerkleForest {
    pub forest_id: [u8; 32],
    pub tree_roots: Vec<[u8; 32]>,
    pub forest_root: [u8; 32],
    pub tree_count: u32,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForestTree {
    pub tree_id: [u8; 32],
    pub root: [u8; 32],
}

#[derive(Debug, PartialEq)]
pub enum ForestError {
    ZeroNonce,
    TooManyTrees,
    EmptyForest,
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

fn compute_forest_id(nonce: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"mforest-id-v1", nonce])
}

fn compute_tree_id(forest_id: &[u8; 32], tree_idx: u32) -> [u8; 32] {
    sha256_multi(&[b"mforest-tree-v1", forest_id, &tree_idx.to_le_bytes()])
}

fn compute_tree_root(leaves: &[[u8; 32]], tree_id: &[u8; 32]) -> [u8; 32] {
    let xor = xor_fold(leaves);
    sha256_multi(&[b"mforest-troot-v1", &xor, tree_id])
}

fn compute_forest_root(tree_roots: &[[u8; 32]], tree_count: u32) -> [u8; 32] {
    if tree_roots.is_empty() {
        return [0u8; 32];
    }
    let xor = xor_fold(tree_roots);
    sha256_multi(&[b"mforest-root-v1", &xor, &tree_count.to_le_bytes()])
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn new_forest(nonce: &[u8; 32]) -> Result<MerkleForest, ForestError> {
    if nonce == &[0u8; 32] {
        return Err(ForestError::ZeroNonce);
    }
    let forest_id = compute_forest_id(nonce);
    Ok(MerkleForest {
        forest_id,
        tree_roots: Vec::new(),
        forest_root: [0u8; 32],
        tree_count: 0,
        mainnet_ready: false,
    })
}

pub fn add_tree(forest: &mut MerkleForest, leaves: &[[u8; 32]]) -> Result<ForestTree, ForestError> {
    if forest.tree_count >= MAX_TREES {
        return Err(ForestError::TooManyTrees);
    }
    let tree_idx = forest.tree_count;
    let tree_id = compute_tree_id(&forest.forest_id, tree_idx);
    let root = compute_tree_root(leaves, &tree_id);
    forest.tree_roots.push(root);
    forest.tree_count += 1;
    forest.forest_root = compute_forest_root(&forest.tree_roots, forest.tree_count);
    Ok(ForestTree { tree_id, root })
}

pub fn get_forest_root(forest: &MerkleForest) -> [u8; 32] {
    forest.forest_root
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_forest_creates_with_valid_nonce() {
        let nonce = [0xabu8; 32];
        let forest = new_forest(&nonce).unwrap();
        // forest_id = SHA256("mforest-id-v1" || nonce)
        let expected = sha256_multi(&[b"mforest-id-v1", &nonce]);
        assert_eq!(forest.forest_id, expected);
        assert_eq!(forest.tree_count, 0);
    }

    #[test]
    fn add_tree_updates_forest_root() {
        let nonce = [0x01u8; 32];
        let mut forest = new_forest(&nonce).unwrap();
        let old_root = forest.forest_root;
        let leaves = vec![[0xbbu8; 32], [0xccu8; 32]];
        add_tree(&mut forest, &leaves).unwrap();
        let new_root = forest.forest_root;
        // Root changed after adding a tree
        assert_ne!(old_root, new_root);
        assert_eq!(forest.tree_count, 1);
    }

    #[test]
    fn two_trees_have_different_tree_ids() {
        let nonce = [0x02u8; 32];
        let mut forest = new_forest(&nonce).unwrap();
        let leaves = vec![[0xddu8; 32]];
        let tree0 = add_tree(&mut forest, &leaves).unwrap();
        let tree1 = add_tree(&mut forest, &leaves).unwrap();
        assert_ne!(tree0.tree_id, tree1.tree_id);
    }

    #[test]
    fn forest_root_changes_on_second_tree_add() {
        let nonce = [0x03u8; 32];
        let mut forest = new_forest(&nonce).unwrap();
        let leaves = vec![[0xeeu8; 32]];
        add_tree(&mut forest, &leaves).unwrap();
        let root_after_first = forest.forest_root;
        add_tree(&mut forest, &leaves).unwrap();
        let root_after_second = forest.forest_root;
        assert_ne!(root_after_first, root_after_second);
    }

    #[test]
    fn too_many_trees_rejected() {
        let nonce = [0x04u8; 32];
        let mut forest = new_forest(&nonce).unwrap();
        let leaves = vec![[0x11u8; 32]];
        // Add MAX_TREES trees
        for _ in 0..MAX_TREES {
            add_tree(&mut forest, &leaves).unwrap();
        }
        // Next add should fail
        let err = add_tree(&mut forest, &leaves).unwrap_err();
        assert_eq!(err, ForestError::TooManyTrees);
    }

    #[test]
    fn mainnet_ready_is_false() {
        let nonce = [0x05u8; 32];
        let forest = new_forest(&nonce).unwrap();
        assert!(!forest.mainnet_ready);
    }
}
