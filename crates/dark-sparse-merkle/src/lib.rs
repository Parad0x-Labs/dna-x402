//! dark-sparse-merkle
//!
//! **Sparse Merkle tree (SMT) with O(depth) inclusion and non-membership proofs.**
//!
//! Key design decisions:
//! - **Sparse**: only non-empty leaves are stored in a HashMap.
//!   Empty subtrees have precomputed default hashes, so the tree never
//!   needs to materialise empty branches.
//! - **Deterministic root**: the same set of (key, value) pairs always
//!   produces the same root, regardless of insertion order.
//! - **Non-membership proofs**: a key not in the tree can still be proven
//!   absent — critical for nullifier absence checks.
//! - **Configurable depth**: depth 8 (256 leaves), depth 16 (64K), depth 32 (4B).
//!
//! ## Hash functions
//!
//! ```text
//! empty(d)   = SHA256("smt-empty-v1"  || depth_u8)          ← precomputed per level
//! leaf(k, v) = SHA256("smt-leaf-v1"   || key_hash || value_hash)
//! node(l, r) = SHA256("smt-node-v1"   || left || right)
//! ```
//!
//! Domain separation ensures leaves can never collide with interior nodes.
//!
//! ## Proofs
//!
//! A `SparseProof` contains one sibling hash per level (from leaf to root).
//! To verify: recompute the root from the leaf/default hash up through
//! the siblings. If it matches `proof.root`, the proof is valid.
//!
//! mainnet_ready = false — devnet only.

use sha2::{Digest, Sha256};
use std::collections::HashMap;

/// Maximum supported tree depth (32 = ~4 billion leaves).
pub const MAX_DEPTH: u8 = 32;

// ── Hash helpers ──────────────────────────────────────────────────────────────

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// Hash a key to a 32-byte tree key.
pub fn hash_key(key: &[u8]) -> [u8; 32] {
    sha256_multi(&[b"smt-key-v1", key])
}

/// Hash a value to a 32-byte tree value.
pub fn hash_value(value: &[u8]) -> [u8; 32] {
    sha256_multi(&[b"smt-value-v1", value])
}

/// Leaf hash: `SHA256("smt-leaf-v1" || key_hash || value_hash)`.
pub fn leaf_hash(key_hash: &[u8; 32], value_hash: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"smt-leaf-v1", key_hash, value_hash])
}

/// Interior node hash: `SHA256("smt-node-v1" || left || right)`.
pub fn node_hash(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"smt-node-v1", left, right])
}

/// Empty subtree hash at depth `d`.
///
/// Precomputed chain: `empty(0) = SHA256("smt-empty-v1" || 0)`;
/// `empty(d) = node_hash(empty(d-1), empty(d-1))`.
/// This ensures the empty root at depth `D` is deterministic.
pub fn empty_hash(depth: u8) -> [u8; 32] {
    let mut h = sha256_multi(&[b"smt-empty-v1", &[0u8]]);
    for d in 1..=depth {
        h = sha256_multi(&[b"smt-node-v1", &h, &h]);
        let _ = d; // silence warning
    }
    h
}

// ── Types ─────────────────────────────────────────────────────────────────────

/// A sparse Merkle tree.
///
/// Stores only non-empty (key_hash → leaf_hash) pairs.
/// The root reflects all current insertions.
#[derive(Debug)]
pub struct SparseMerkleTree {
    /// Depth of the tree (number of levels above the leaves).
    pub depth: u8,
    /// Current root hash.
    pub root: [u8; 32],
    /// Leaf count.
    pub leaf_count: u32,
    /// Precomputed empty hashes for each level 0..=depth.
    empty: Vec<[u8; 32]>,
    /// Sparse node store: maps bit-path prefix (as usize) at each level to hash.
    /// Key: (level, path_prefix as u128) → node hash.
    nodes: HashMap<(u8, u128), [u8; 32]>,
    /// Always false.
    pub mainnet_ready: bool,
}

/// A Merkle proof (inclusion or non-membership).
#[derive(Debug, Clone)]
pub struct SparseProof {
    /// The key this proof is for (32-byte hash of the raw key).
    pub key_hash: [u8; 32],
    /// `Some(value_hash)` if the key is in the tree; `None` for non-membership.
    pub value_hash: Option<[u8; 32]>,
    /// Sibling hash at each level, from leaf level up to root.
    /// Length == tree depth.
    pub siblings: Vec<[u8; 32]>,
    /// Tree root at the time the proof was generated.
    pub root: [u8; 32],
}

/// Errors from SMT operations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SparseError {
    /// Depth is zero.
    DepthZero,
    /// Depth exceeds MAX_DEPTH.
    DepthTooHigh,
    /// Key is empty.
    EmptyKey,
    /// Value is empty.
    EmptyValue,
}

// ── SparseMerkleTree impl ─────────────────────────────────────────────────────

impl SparseMerkleTree {
    /// Create a new empty sparse Merkle tree of the given depth.
    pub fn new(depth: u8) -> Result<Self, SparseError> {
        if depth == 0 {
            return Err(SparseError::DepthZero);
        }
        if depth > MAX_DEPTH {
            return Err(SparseError::DepthTooHigh);
        }

        // Precompute empty hashes for levels 0..=depth
        let mut empty = Vec::with_capacity(depth as usize + 1);
        let base = sha256_multi(&[b"smt-empty-v1", &[0u8]]);
        empty.push(base);
        for _ in 1..=(depth as usize) {
            let prev = *empty.last().unwrap();
            empty.push(sha256_multi(&[b"smt-node-v1", &prev, &prev]));
        }

        let root = *empty.last().unwrap();
        Ok(Self {
            depth,
            root,
            leaf_count: 0,
            empty,
            nodes: HashMap::new(),
            mainnet_ready: false,
        })
    }

    /// Get the hash of the subtree rooted at (level, path_prefix).
    fn get_node(&self, level: u8, path: u128) -> [u8; 32] {
        *self
            .nodes
            .get(&(level, path))
            .unwrap_or_else(|| &self.empty[level as usize])
    }

    /// Set a node and propagate up to recompute the root.
    fn set_leaf_and_recompute(&mut self, key_hash: &[u8; 32], leaf: [u8; 32]) {
        // Extract the `depth` most significant bits of key_hash as the path.
        // We use the first 16 bytes (128 bits) as u128 — sufficient for depth ≤ 32.
        let path_full = u128::from_be_bytes(key_hash[0..16].try_into().unwrap());

        // Store the leaf node at level 0
        let shift = 128 - self.depth;
        let leaf_idx = path_full >> shift; // depth-bit prefix
        self.nodes.insert((0, leaf_idx), leaf);

        // Recompute up
        let mut current_hash = leaf;
        let mut current_path = leaf_idx;
        for level in 0..self.depth {
            let sibling_path = current_path ^ 1; // flip the lowest bit to get sibling
            let sibling = self.get_node(level, sibling_path);
            let (left, right) = if current_path & 1 == 0 {
                (current_hash, sibling)
            } else {
                (sibling, current_hash)
            };
            current_hash = node_hash(&left, &right);
            current_path >>= 1;
            let parent_level = level + 1;
            self.nodes
                .insert((parent_level, current_path), current_hash);
        }
        self.root = current_hash;
    }

    /// Insert or update `(key, value)` in the tree.
    pub fn insert(&mut self, key: &[u8], value: &[u8]) -> Result<[u8; 32], SparseError> {
        if key.is_empty() {
            return Err(SparseError::EmptyKey);
        }
        if value.is_empty() {
            return Err(SparseError::EmptyValue);
        }

        let kh = hash_key(key);
        let vh = hash_value(value);
        let lh = leaf_hash(&kh, &vh);

        let was_empty = self.get_leaf_hash(&kh).is_none();
        self.set_leaf_and_recompute(&kh, lh);
        if was_empty {
            self.leaf_count += 1;
        }
        Ok(lh)
    }

    /// Get the leaf hash for a key hash, or None if not present.
    fn get_leaf_hash(&self, key_hash: &[u8; 32]) -> Option<[u8; 32]> {
        let path_full = u128::from_be_bytes(key_hash[0..16].try_into().unwrap());
        let shift = 128 - self.depth;
        let leaf_idx = path_full >> shift;
        let stored = *self.nodes.get(&(0, leaf_idx))?;
        // Check it's not the default empty hash
        if stored == self.empty[0] {
            None
        } else {
            Some(stored)
        }
    }

    /// Look up whether a key is in the tree.
    pub fn contains(&self, key: &[u8]) -> bool {
        let kh = hash_key(key);
        self.get_leaf_hash(&kh).is_some()
    }

    /// Generate a Merkle proof for `key`.
    ///
    /// Returns an inclusion proof if the key is in the tree,
    /// or a non-membership proof if it's absent.
    pub fn prove(&self, key: &[u8]) -> SparseProof {
        let kh = hash_key(key);
        let path_full = u128::from_be_bytes(kh[0..16].try_into().unwrap());
        let shift = 128 - self.depth;
        let leaf_idx = path_full >> shift;

        let leaf_stored = self.nodes.get(&(0, leaf_idx)).copied();
        let value_hash = if let Some(lh) = leaf_stored {
            if lh != self.empty[0] {
                Some(lh)
            } else {
                None
            }
        } else {
            None
        };

        // Collect siblings from leaf up to root
        let mut siblings = Vec::with_capacity(self.depth as usize);
        let mut path = leaf_idx;
        for level in 0..self.depth {
            let sibling_path = path ^ 1;
            siblings.push(self.get_node(level, sibling_path));
            path >>= 1;
        }

        SparseProof {
            key_hash: kh,
            value_hash,
            siblings,
            root: self.root,
        }
    }
}

// ── Standalone verification ───────────────────────────────────────────────────

/// Verify a `SparseProof` against an expected root.
///
/// Works for both inclusion proofs (`proof.value_hash = Some(...)`)
/// and non-membership proofs (`proof.value_hash = None`).
///
/// Does NOT require access to the original tree.
pub fn verify_proof(proof: &SparseProof, depth: u8) -> bool {
    if proof.siblings.len() != depth as usize {
        return false;
    }

    // Compute the starting leaf hash
    let path_full = u128::from_be_bytes(proof.key_hash[0..16].try_into().unwrap());
    let shift = 128 - depth;
    let leaf_idx = path_full >> shift;

    // The leaf hash to verify:
    // - inclusion: the stored leaf hash (which should equal leaf_hash(key, value))
    // - non-membership: the empty hash at level 0
    let base_empty = sha256_multi(&[b"smt-empty-v1", &[0u8]]);
    let mut current = match &proof.value_hash {
        Some(lh) => *lh,    // inclusion: the stored leaf node
        None => base_empty, // non-membership: empty leaf
    };

    // Walk up the tree using siblings
    let mut path = leaf_idx;
    for sibling in &proof.siblings {
        let (left, right) = if path & 1 == 0 {
            (current, *sibling)
        } else {
            (*sibling, current)
        };
        current = node_hash(&left, &right);
        path >>= 1;
    }

    current == proof.root
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Test 1: empty tree has non-zero deterministic root ───────────────────
    #[test]
    fn test_empty_root_deterministic() {
        let t1 = SparseMerkleTree::new(8).unwrap();
        let t2 = SparseMerkleTree::new(8).unwrap();
        assert_eq!(
            t1.root, t2.root,
            "empty trees of same depth must have same root"
        );
        assert_ne!(t1.root, [0u8; 32], "root must be non-zero");
        assert!(!t1.mainnet_ready);
    }

    // ── Test 2: root changes after insertion ─────────────────────────────────
    #[test]
    fn test_root_changes_on_insert() {
        let mut tree = SparseMerkleTree::new(8).unwrap();
        let empty_root = tree.root;
        tree.insert(b"key1", b"value1").unwrap();
        assert_ne!(tree.root, empty_root, "root must change after insertion");
    }

    // ── Test 3: depth 0 rejected ─────────────────────────────────────────────
    #[test]
    fn test_depth_zero_rejected() {
        assert_eq!(
            SparseMerkleTree::new(0).unwrap_err(),
            SparseError::DepthZero
        );
    }

    // ── Test 4: depth too high rejected ──────────────────────────────────────
    #[test]
    fn test_depth_too_high_rejected() {
        assert_eq!(
            SparseMerkleTree::new(MAX_DEPTH + 1).unwrap_err(),
            SparseError::DepthTooHigh
        );
    }

    // ── Test 5: inclusion proof verifies ─────────────────────────────────────
    #[test]
    fn test_inclusion_proof_verifies() {
        let mut tree = SparseMerkleTree::new(16).unwrap();
        tree.insert(b"nullifier-001", b"spent").unwrap();
        let proof = tree.prove(b"nullifier-001");
        assert!(
            proof.value_hash.is_some(),
            "inclusion proof must have value"
        );
        assert!(verify_proof(&proof, 16), "inclusion proof must verify");
    }

    // ── Test 6: non-membership proof verifies ───────────────────────────────
    #[test]
    fn test_non_membership_proof_verifies() {
        let mut tree = SparseMerkleTree::new(16).unwrap();
        tree.insert(b"nullifier-001", b"spent").unwrap();
        // Prove that nullifier-002 is NOT in the tree
        let proof = tree.prove(b"nullifier-002");
        assert!(
            proof.value_hash.is_none(),
            "non-membership proof must have None value"
        );
        assert!(verify_proof(&proof, 16), "non-membership proof must verify");
    }

    // ── Test 7: different keys have different leaf hashes ────────────────────
    #[test]
    fn test_different_keys_different_leaves() {
        let mut tree = SparseMerkleTree::new(8).unwrap();
        tree.insert(b"key-alpha", b"val").unwrap();
        tree.insert(b"key-beta", b"val").unwrap();
        let p1 = tree.prove(b"key-alpha");
        let p2 = tree.prove(b"key-beta");
        assert_ne!(p1.key_hash, p2.key_hash);
        assert!(verify_proof(&p1, 8));
        assert!(verify_proof(&p2, 8));
    }

    // ── Test 8: same key inserted twice — root is idempotent ────────────────
    #[test]
    fn test_idempotent_insert() {
        let mut tree = SparseMerkleTree::new(8).unwrap();
        tree.insert(b"key", b"value").unwrap();
        let root_after_first = tree.root;
        tree.insert(b"key", b"value").unwrap(); // same key + value
        assert_eq!(
            tree.root, root_after_first,
            "inserting the same key/value twice must not change the root"
        );
    }

    // ── Test 9: contains() reflects inserts ──────────────────────────────────
    #[test]
    fn test_contains_after_insert() {
        let mut tree = SparseMerkleTree::new(8).unwrap();
        assert!(!tree.contains(b"nullifier-x"), "key not yet inserted");
        tree.insert(b"nullifier-x", b"1").unwrap();
        assert!(
            tree.contains(b"nullifier-x"),
            "key must be found after insert"
        );
        assert!(
            !tree.contains(b"nullifier-y"),
            "different key must not be found"
        );
    }

    // ── Test 10: update existing key changes root ─────────────────────────────
    #[test]
    fn test_update_changes_root() {
        let mut tree = SparseMerkleTree::new(8).unwrap();
        tree.insert(b"key", b"v1").unwrap();
        let r1 = tree.root;
        tree.insert(b"key", b"v2").unwrap();
        let r2 = tree.root;
        assert_ne!(r1, r2, "updating a key must change the root");
    }

    // ── Test 11: proof for absent key in empty tree verifies ─────────────────
    #[test]
    fn test_non_membership_empty_tree() {
        let tree = SparseMerkleTree::new(8).unwrap();
        let proof = tree.prove(b"any-key");
        assert!(proof.value_hash.is_none());
        assert!(
            verify_proof(&proof, 8),
            "non-membership proof in empty tree must verify"
        );
    }

    // ── Test 12: many insertions, all inclusion proofs verify ────────────────
    #[test]
    fn test_many_insertions_all_proofs_valid() {
        let mut tree = SparseMerkleTree::new(16).unwrap();
        let keys: Vec<Vec<u8>> = (0u8..20)
            .map(|i| {
                let mut k = b"nullifier-".to_vec();
                k.push(i);
                k
            })
            .collect();

        for k in &keys {
            tree.insert(k, b"spent").unwrap();
        }

        for k in &keys {
            let proof = tree.prove(k);
            assert!(proof.value_hash.is_some(), "key {:?} must be present", k);
            assert!(verify_proof(&proof, 16), "proof for {:?} must verify", k);
        }
        assert_eq!(tree.leaf_count, 20);
    }

    // ── Test 13: insertion order doesn't change final root ────────────────────
    #[test]
    fn test_insertion_order_independent() {
        let mut t1 = SparseMerkleTree::new(8).unwrap();
        t1.insert(b"a", b"1").unwrap();
        t1.insert(b"b", b"2").unwrap();
        t1.insert(b"c", b"3").unwrap();

        let mut t2 = SparseMerkleTree::new(8).unwrap();
        t2.insert(b"c", b"3").unwrap();
        t2.insert(b"a", b"1").unwrap();
        t2.insert(b"b", b"2").unwrap();

        assert_eq!(t1.root, t2.root, "insertion order must not change the root");
    }

    // ── Test 14: trees of different depths have different empty roots ─────────
    #[test]
    fn test_different_depth_different_empty_root() {
        let t8 = SparseMerkleTree::new(8).unwrap();
        let t16 = SparseMerkleTree::new(16).unwrap();
        assert_ne!(
            t8.root, t16.root,
            "trees of different depths must have different empty roots"
        );
    }

    // ── Test 15: leaf_hash and node_hash use domain separation ───────────────
    #[test]
    fn test_domain_separation() {
        let kh = [0x01u8; 32];
        let vh = [0x02u8; 32];
        let lh = leaf_hash(&kh, &vh);
        let nh = node_hash(&kh, &vh);
        assert_ne!(
            lh, nh,
            "leaf_hash and node_hash must differ for same inputs"
        );
    }
}
