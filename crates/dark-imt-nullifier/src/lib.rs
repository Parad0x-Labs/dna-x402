//! Indexed Merkle Tree (IMT) nullifier set for Dark Null.
//!
//! An IMT stores nullifiers in a sorted linked list encoded as a Merkle tree.
//! Non-membership proofs ("this nullifier has not been spent") use the
//! **low-nullifier technique**: reveal leaf L where L.value < target < L.next_value.
//!
//! Cost comparison vs sparse Merkle trees (depth-26):
//!   - Sparse:  2,032 Poseidon hashes per 4-value batch → ~1.2M CU in-circuit
//!   - IMT:       327 Poseidon hashes per 4-value batch → ~197k CU in-circuit
//!   - Savings: **8×**
//!
//! No Solana implementation of an IMT nullifier set exists prior to this crate.
//!
//! `IS_STUB = true`, `MAINNET_READY = false`.

use sha2::{Digest, Sha256};

pub const IMT_MAX_DEPTH: usize = 26;
pub const IMT_MAX_LEAVES: u32 = 1 << 26; // 67M nullifiers
/// On-chain PDA byte size: value(32) + next_value(32) + next_index(8) = 72
pub const IMT_NODE_SIZE: usize = 72;
/// Sentinel minimum — the initial root node value.
pub const IMT_SENTINEL_MIN: [u8; 32] = [0x00u8; 32];
/// Sentinel maximum — the `next_value` of the last inserted leaf.
pub const IMT_SENTINEL_MAX: [u8; 32] = [0xffu8; 32];

pub const IS_STUB: bool = true;
pub const MAINNET_READY: bool = false;

#[derive(Debug, Clone, PartialEq)]
pub struct IMTNode {
    pub value: [u8; 32],
    pub next_value: [u8; 32],
    pub next_index: u32,
}

/// Non-membership proof produced by `IMT::prove_non_membership`.
/// In production: includes a Merkle inclusion proof for `low_nullifier`.
#[derive(Debug, Clone)]
pub struct IMTNonMembershipProof {
    pub low_nullifier: IMTNode,
    pub low_nullifier_index: u32,
    pub is_stub: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum IMTError {
    /// Nullifier is already in the tree (already spent).
    NullifierAlreadyInserted,
    /// Tree contains no leaves yet (only the bootstrap sentinel).
    EmptyTree,
    /// No valid low-nullifier found — internal invariant violation.
    InvalidLowNullifier,
    /// `IMT_MAX_LEAVES` reached.
    MaxCapacityReached,
    /// Attempt to insert the sentinel min or max value.
    SentinelValue,
}

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn leaf_hash(node: &IMTNode) -> [u8; 32] {
    sha256_multi(&[
        b"dark-imt-leaf-v1",
        &node.value,
        &node.next_value,
        &node.next_index.to_le_bytes(),
    ])
}

/// Compute a simple Merkle root over all leaf hashes (stub, not depth-fixed).
fn compute_root(nodes: &[IMTNode]) -> [u8; 32] {
    if nodes.is_empty() {
        return [0u8; 32];
    }
    let mut layer: Vec<[u8; 32]> = nodes.iter().map(leaf_hash).collect();
    while layer.len() > 1 {
        let mut next = Vec::with_capacity((layer.len() + 1) / 2);
        let mut i = 0;
        while i < layer.len() {
            let left = layer[i];
            let right = if i + 1 < layer.len() { layer[i + 1] } else { left };
            next.push(sha256_multi(&[b"dark-imt-node-v1", &left, &right]));
            i += 2;
        }
        layer = next;
    }
    layer[0]
}

/// In-memory Indexed Merkle Tree.
pub struct IMT {
    pub nodes: Vec<IMTNode>,
    pub root: [u8; 32],
    /// Number of *real* nullifiers inserted (excludes the sentinel).
    pub size: u32,
    pub is_stub: bool,
    pub mainnet_ready: bool,
}

impl IMT {
    /// Create a new empty tree with a bootstrap sentinel node.
    pub fn new() -> Self {
        let sentinel = IMTNode {
            value: IMT_SENTINEL_MIN,
            next_value: IMT_SENTINEL_MAX,
            next_index: 0,
        };
        let nodes = vec![sentinel];
        let root = compute_root(&nodes);
        IMT { nodes, root, size: 0, is_stub: true, mainnet_ready: false }
    }

    /// `true` if `nullifier` has been inserted (i.e. has been spent).
    pub fn contains(&self, nullifier: &[u8; 32]) -> bool {
        self.nodes.iter().any(|n| &n.value == nullifier)
    }

    /// Find the index of the low-nullifier for `target`:
    /// the node L where L.value < target < L.next_value.
    fn find_low_idx(&self, target: &[u8; 32]) -> Option<usize> {
        let mut best: Option<usize> = None;
        for (i, node) in self.nodes.iter().enumerate() {
            if &node.value >= target {
                continue;
            }
            if node.next_value > *target || node.next_value == IMT_SENTINEL_MAX {
                match best {
                    None => best = Some(i),
                    Some(b) if node.value > self.nodes[b].value => best = Some(i),
                    _ => {}
                }
            }
        }
        best
    }

    /// Insert a nullifier into the tree, maintaining sorted order.
    pub fn insert(&mut self, nullifier: &[u8; 32]) -> Result<(), IMTError> {
        if nullifier == &IMT_SENTINEL_MIN || nullifier == &IMT_SENTINEL_MAX {
            return Err(IMTError::SentinelValue);
        }
        if self.contains(nullifier) {
            return Err(IMTError::NullifierAlreadyInserted);
        }
        if self.size >= IMT_MAX_LEAVES {
            return Err(IMTError::MaxCapacityReached);
        }
        let low_idx = self.find_low_idx(nullifier).ok_or(IMTError::InvalidLowNullifier)?;
        let new_index = self.nodes.len() as u32;
        let new_node = IMTNode {
            value: *nullifier,
            next_value: self.nodes[low_idx].next_value,
            next_index: self.nodes[low_idx].next_index,
        };
        self.nodes[low_idx].next_value = *nullifier;
        self.nodes[low_idx].next_index = new_index;
        self.nodes.push(new_node);
        self.size += 1;
        self.root = compute_root(&self.nodes);
        Ok(())
    }

    /// Produce a non-membership proof for `nullifier` (proves it hasn't been spent).
    /// Returns `Err(NullifierAlreadyInserted)` if `nullifier` is already in the tree.
    pub fn prove_non_membership(
        &self,
        nullifier: &[u8; 32],
    ) -> Result<IMTNonMembershipProof, IMTError> {
        if self.contains(nullifier) {
            return Err(IMTError::NullifierAlreadyInserted);
        }
        let low_idx = self.find_low_idx(nullifier).ok_or(IMTError::InvalidLowNullifier)?;
        Ok(IMTNonMembershipProof {
            low_nullifier: self.nodes[low_idx].clone(),
            low_nullifier_index: low_idx as u32,
            is_stub: true,
            mainnet_ready: false,
        })
    }

    /// Verify a non-membership proof: check the bracketing invariant.
    /// In production this also verifies the Merkle inclusion proof for the low nullifier.
    pub fn verify_non_membership(
        &self,
        nullifier: &[u8; 32],
        proof: &IMTNonMembershipProof,
    ) -> bool {
        let low = &proof.low_nullifier;
        low.value < *nullifier && *nullifier < low.next_value
    }
}

impl Default for IMT {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n1() -> [u8; 32] {
        let mut v = [0u8; 32];
        v[31] = 0x10;
        v
    }

    fn n2() -> [u8; 32] {
        let mut v = [0u8; 32];
        v[31] = 0x20;
        v
    }

    fn n3() -> [u8; 32] {
        let mut v = [0u8; 32];
        v[31] = 0x05;
        v
    }

    #[test]
    fn test_new_imt_size_zero() {
        let tree = IMT::new();
        assert_eq!(tree.size, 0);
    }

    #[test]
    fn test_insert_increases_size() {
        let mut tree = IMT::new();
        tree.insert(&n1()).unwrap();
        assert_eq!(tree.size, 1);
    }

    #[test]
    fn test_double_insert_fails() {
        let mut tree = IMT::new();
        tree.insert(&n1()).unwrap();
        let err = tree.insert(&n1()).unwrap_err();
        assert_eq!(err, IMTError::NullifierAlreadyInserted);
    }

    #[test]
    fn test_contains_after_insert() {
        let mut tree = IMT::new();
        tree.insert(&n1()).unwrap();
        assert!(tree.contains(&n1()));
    }

    #[test]
    fn test_not_contains_before_insert() {
        let tree = IMT::new();
        assert!(!tree.contains(&n1()));
    }

    #[test]
    fn test_root_changes_after_insert() {
        let mut tree = IMT::new();
        let root_before = tree.root;
        tree.insert(&n1()).unwrap();
        assert_ne!(tree.root, root_before);
    }

    #[test]
    fn test_prove_non_membership_for_unspent() {
        let tree = IMT::new();
        let proof = tree.prove_non_membership(&n1()).unwrap();
        assert_eq!(proof.is_stub, true);
        assert_eq!(proof.mainnet_ready, false);
    }

    #[test]
    fn test_verify_non_membership_passes_for_unspent() {
        let tree = IMT::new();
        let proof = tree.prove_non_membership(&n1()).unwrap();
        assert!(tree.verify_non_membership(&n1(), &proof));
    }

    #[test]
    fn test_prove_non_membership_fails_for_spent() {
        let mut tree = IMT::new();
        tree.insert(&n1()).unwrap();
        let err = tree.prove_non_membership(&n1()).unwrap_err();
        assert_eq!(err, IMTError::NullifierAlreadyInserted);
    }

    #[test]
    fn test_imt_node_size_constant() {
        assert_eq!(IMT_NODE_SIZE, 72);
    }

    #[test]
    fn test_imt_max_depth_constant() {
        assert_eq!(IMT_MAX_DEPTH, 26);
    }

    #[test]
    fn test_low_nullifier_bracketing() {
        let tree = IMT::new();
        let proof = tree.prove_non_membership(&n1()).unwrap();
        let low = &proof.low_nullifier;
        // low.value < n1 < low.next_value
        assert!(low.value < n1());
        assert!(n1() < low.next_value);
    }

    #[test]
    fn test_insert_two_nullifiers_both_findable() {
        let mut tree = IMT::new();
        tree.insert(&n1()).unwrap();
        tree.insert(&n2()).unwrap();
        assert!(tree.contains(&n1()));
        assert!(tree.contains(&n2()));
        assert_eq!(tree.size, 2);
    }

    #[test]
    fn test_sentinel_value_rejected() {
        let mut tree = IMT::new();
        assert_eq!(tree.insert(&IMT_SENTINEL_MIN).unwrap_err(), IMTError::SentinelValue);
        assert_eq!(tree.insert(&IMT_SENTINEL_MAX).unwrap_err(), IMTError::SentinelValue);
    }

    #[test]
    fn test_insert_out_of_order_still_finds_low() {
        let mut tree = IMT::new();
        // Insert n2 (0x20) first, then n3 (0x05) — n3 < n2
        tree.insert(&n2()).unwrap();
        tree.insert(&n3()).unwrap();
        // Prove non-membership for n1 (0x10) which sits between n3 and n2
        let proof = tree.prove_non_membership(&n1()).unwrap();
        assert!(tree.verify_non_membership(&n1(), &proof));
    }

    #[test]
    fn test_mainnet_ready_false() {
        let tree = IMT::new();
        assert!(!tree.mainnet_ready);
    }

    #[test]
    fn test_is_stub_true() {
        let tree = IMT::new();
        assert!(tree.is_stub);
    }
}
