//! dark-compressed-leaves — ZK Compression Receipt Leaf Schema
//!
//! Defines the leaf hash format for compressed nullifiers, commitments,
//! and receipt heads. ~1,000x cheaper than full Solana account rent.
//!
//! Status: prototype — leaf schema and hash format defined.
//! On-chain deployment requires Light Protocol state-tree integration.
//!
//! Cost comparison (Solana mainnet 2026):
//!   Full account (128 bytes): ~0.00204 SOL rent
//!   Compressed leaf:          ~0.000002 SOL per leaf
//!   Savings at 100k users:    ~200 SOL
//!
//! Daily use case: Dark Null stores receipt heads, nullifiers, and
//! commitment leaves in a ZK Compression state tree. One 128-byte
//! Groth16 validity proof covers any batch of compressed operations.
//! The tree root is committed on-chain once per epoch — one Solana
//! account write regardless of how many receipts were processed.
//!
//! NOT_PRODUCTION — prototype schema only. Not deployed on-chain.
//! mainnet_ready = false.

use sha2::{Digest, Sha256};
use thiserror::Error;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

pub const LEAF_SCHEMA_VERSION: &str = "0.1.0-design";
pub const COMMITMENT_LEAF_DOMAIN: u8 = 0x01;
pub const NULLIFIER_LEAF_DOMAIN: u8 = 0x02;
pub const RECEIPT_HEAD_LEAF_DOMAIN: u8 = 0x03;
pub const ZERO_HASH: [u8; 32] = [0u8; 32];

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeafKind {
    Commitment,
    Nullifier,
    ReceiptHead,
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct CompressedLeaf {
    pub kind: LeafKind,
    pub leaf_hash: [u8; 32],
    pub epoch: u32,
    pub slot: u64,
    pub schema_version: String,
}

#[derive(Debug, Clone)]
pub struct MockInclusionProof {
    pub leaf_hash: [u8; 32],
    pub root: [u8; 32],
    pub sibling_hashes: Vec<[u8; 32]>,
    pub path_bits: Vec<bool>,
}

#[derive(Debug, Clone)]
pub struct StateTreeRoot {
    pub root: [u8; 32],
    pub epoch: u32,
    pub leaf_count: u32,
    pub committed_at_slot: u64,
}

#[derive(Debug, Error)]
pub enum CompressedLeavesError {
    #[error("wrong root")]
    WrongRoot,
    #[error("stale root: root_slot={root_slot}, current_slot={current_slot}")]
    StaleRoot { root_slot: u64, current_slot: u64 },
    #[error("duplicate nullifier detected")]
    DuplicateNullifier,
    #[error("missing leaf")]
    MissingLeaf,
    #[error("wrong state tree")]
    WrongStateTree,
    #[error("invalid proof shape")]
    InvalidProofShape,
}

// ---------------------------------------------------------------------------
// Leaf constructors
// ---------------------------------------------------------------------------

/// Commitment leaf: SHA256(COMMITMENT_LEAF_DOMAIN || commitment_bytes || epoch.le || slot.le)
pub fn create_commitment_leaf(commitment: &[u8; 32], epoch: u32, slot: u64) -> CompressedLeaf {
    let mut hasher = Sha256::new();
    hasher.update([COMMITMENT_LEAF_DOMAIN]);
    hasher.update(commitment);
    hasher.update(epoch.to_le_bytes());
    hasher.update(slot.to_le_bytes());
    let result: [u8; 32] = hasher.finalize().into();
    CompressedLeaf {
        kind: LeafKind::Commitment,
        leaf_hash: result,
        epoch,
        slot,
        schema_version: LEAF_SCHEMA_VERSION.to_string(),
    }
}

/// Nullifier leaf: SHA256(NULLIFIER_LEAF_DOMAIN || nullifier_bytes || epoch.le || slot.le)
pub fn create_nullifier_leaf(nullifier: &[u8; 32], epoch: u32, slot: u64) -> CompressedLeaf {
    let mut hasher = Sha256::new();
    hasher.update([NULLIFIER_LEAF_DOMAIN]);
    hasher.update(nullifier);
    hasher.update(epoch.to_le_bytes());
    hasher.update(slot.to_le_bytes());
    let result: [u8; 32] = hasher.finalize().into();
    CompressedLeaf {
        kind: LeafKind::Nullifier,
        leaf_hash: result,
        epoch,
        slot,
        schema_version: LEAF_SCHEMA_VERSION.to_string(),
    }
}

/// Receipt head leaf:
/// SHA256(RECEIPT_HEAD_LEAF_DOMAIN || receipt_hash || previous_leaf_hash_or_zeros || epoch.le || slot.le)
pub fn create_receipt_head_leaf(
    receipt_hash: &[u8; 32],
    previous_leaf_hash: Option<&[u8; 32]>,
    epoch: u32,
    slot: u64,
) -> CompressedLeaf {
    let prev = previous_leaf_hash.unwrap_or(&ZERO_HASH);
    let mut hasher = Sha256::new();
    hasher.update([RECEIPT_HEAD_LEAF_DOMAIN]);
    hasher.update(receipt_hash);
    hasher.update(prev);
    hasher.update(epoch.to_le_bytes());
    hasher.update(slot.to_le_bytes());
    let result: [u8; 32] = hasher.finalize().into();
    CompressedLeaf {
        kind: LeafKind::ReceiptHead,
        leaf_hash: result,
        epoch,
        slot,
        schema_version: LEAF_SCHEMA_VERSION.to_string(),
    }
}

// ---------------------------------------------------------------------------
// State tree helpers
// ---------------------------------------------------------------------------

fn hash_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(left);
    hasher.update(right);
    hasher.finalize().into()
}

/// Compute state tree root from a slice of leaf hashes.
/// Odd layer sizes are padded with ZERO_HASH on the right.
pub fn compute_state_tree_root(leaf_hashes: &[[u8; 32]]) -> StateTreeRoot {
    if leaf_hashes.is_empty() {
        return StateTreeRoot {
            root: ZERO_HASH,
            epoch: 0,
            leaf_count: 0,
            committed_at_slot: 0,
        };
    }
    let mut layer: Vec<[u8; 32]> = leaf_hashes.to_vec();
    while layer.len() > 1 {
        if layer.len() % 2 == 1 {
            layer.push(ZERO_HASH);
        }
        let mut next = Vec::with_capacity(layer.len() / 2);
        for chunk in layer.chunks(2) {
            next.push(hash_pair(&chunk[0], &chunk[1]));
        }
        layer = next;
    }
    StateTreeRoot {
        root: layer[0],
        epoch: 0,
        leaf_count: leaf_hashes.len() as u32,
        committed_at_slot: 0,
    }
}

/// Verify mock inclusion proof by recomputing root from leaf + siblings.
pub fn verify_mock_inclusion(
    proof: &MockInclusionProof,
    expected_root: &[u8; 32],
) -> Result<(), CompressedLeavesError> {
    if proof.sibling_hashes.len() != proof.path_bits.len() {
        return Err(CompressedLeavesError::InvalidProofShape);
    }
    let mut current = proof.leaf_hash;
    for (sibling, &go_right) in proof.sibling_hashes.iter().zip(proof.path_bits.iter()) {
        current = if go_right {
            hash_pair(sibling, &current)
        } else {
            hash_pair(&current, sibling)
        };
    }
    if &current == expected_root {
        Ok(())
    } else {
        Err(CompressedLeavesError::WrongRoot)
    }
}

/// Check for duplicate nullifier in an existing leaf set.
pub fn check_duplicate_nullifier(
    nullifier: &[u8; 32],
    existing_leaves: &[CompressedLeaf],
) -> Result<(), CompressedLeavesError> {
    // Build what a nullifier leaf hash would look like for each existing leaf
    for leaf in existing_leaves {
        if leaf.kind == LeafKind::Nullifier {
            // We can only check by comparing already-computed leaf hashes
            // against a freshly computed candidate across matching epoch/slot.
            // Re-derive using same epoch/slot as the stored leaf.
            let candidate = create_nullifier_leaf(nullifier, leaf.epoch, leaf.slot);
            if candidate.leaf_hash == leaf.leaf_hash {
                return Err(CompressedLeavesError::DuplicateNullifier);
            }
        }
    }
    Ok(())
}

/// Estimate rent savings for N leaves vs N full accounts.
/// Returns (compressed_cost_lamports, full_account_cost_lamports, savings_lamports)
pub fn estimate_rent_savings(leaf_count: u64) -> (u64, u64, u64) {
    const COMPRESSED_LAMPORTS_PER_LEAF: u64 = 2_000;
    const FULL_ACCOUNT_LAMPORTS_PER_LEAF: u64 = 2_039_280;

    let compressed = COMPRESSED_LAMPORTS_PER_LEAF.saturating_mul(leaf_count);
    let full = FULL_ACCOUNT_LAMPORTS_PER_LEAF.saturating_mul(leaf_count);
    let savings = full.saturating_sub(compressed);
    (compressed, full, savings)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_hash(seed: u8) -> [u8; 32] {
        let mut h = [0u8; 32];
        h[0] = seed;
        h[1] = 0xab;
        h
    }

    #[test]
    fn test_commitment_leaf_deterministic() {
        let c = dummy_hash(1);
        let a = create_commitment_leaf(&c, 5, 100);
        let b = create_commitment_leaf(&c, 5, 100);
        assert_eq!(a.leaf_hash, b.leaf_hash);
        assert_eq!(a.kind, LeafKind::Commitment);
    }

    #[test]
    fn test_nullifier_leaf_deterministic() {
        let n = dummy_hash(2);
        let a = create_nullifier_leaf(&n, 3, 200);
        let b = create_nullifier_leaf(&n, 3, 200);
        assert_eq!(a.leaf_hash, b.leaf_hash);
        assert_eq!(a.kind, LeafKind::Nullifier);
    }

    #[test]
    fn test_receipt_head_leaf_deterministic() {
        let r = dummy_hash(3);
        let a = create_receipt_head_leaf(&r, None, 1, 50);
        let b = create_receipt_head_leaf(&r, None, 1, 50);
        assert_eq!(a.leaf_hash, b.leaf_hash);
        assert_eq!(a.kind, LeafKind::ReceiptHead);
    }

    #[test]
    fn test_receipt_head_leaf_chaining() {
        let r = dummy_hash(4);
        let prev = dummy_hash(5);
        let without_prev = create_receipt_head_leaf(&r, None, 1, 50);
        let with_prev = create_receipt_head_leaf(&r, Some(&prev), 1, 50);
        assert_ne!(without_prev.leaf_hash, with_prev.leaf_hash);
    }

    #[test]
    fn test_state_tree_root_deterministic() {
        let leaves = vec![dummy_hash(10), dummy_hash(11), dummy_hash(12), dummy_hash(13)];
        let root_a = compute_state_tree_root(&leaves);
        let root_b = compute_state_tree_root(&leaves);
        assert_eq!(root_a.root, root_b.root);
        assert_eq!(root_a.leaf_count, 4);
    }

    #[test]
    fn test_state_tree_root_changes_with_leaf() {
        let leaves_a = vec![dummy_hash(10), dummy_hash(11)];
        let mut leaves_b = leaves_a.clone();
        leaves_b[1] = dummy_hash(99);
        let root_a = compute_state_tree_root(&leaves_a);
        let root_b = compute_state_tree_root(&leaves_b);
        assert_ne!(root_a.root, root_b.root);
    }

    #[test]
    fn test_duplicate_nullifier_detected() {
        let n = dummy_hash(20);
        let leaf = create_nullifier_leaf(&n, 1, 500);
        let existing = vec![leaf];
        let result = check_duplicate_nullifier(&n, &existing);
        assert!(matches!(result, Err(CompressedLeavesError::DuplicateNullifier)));
    }

    #[test]
    fn test_no_duplicate_different_nullifiers() {
        let n1 = dummy_hash(21);
        let n2 = dummy_hash(22);
        let leaf = create_nullifier_leaf(&n1, 1, 500);
        let existing = vec![leaf];
        let result = check_duplicate_nullifier(&n2, &existing);
        assert!(result.is_ok());
    }

    #[test]
    fn test_rent_savings_100k_leaves() {
        let (compressed, full, savings) = estimate_rent_savings(100_000);
        assert!(savings > 0);
        assert!(full > compressed);
    }

    #[test]
    fn test_rent_savings_zero_leaves() {
        let result = estimate_rent_savings(0);
        assert_eq!(result, (0, 0, 0));
    }

    #[test]
    fn test_mock_inclusion_proof_valid() {
        // Build a 4-leaf tree: leaves[0..3]
        let leaves: Vec<[u8; 32]> = (0u8..4).map(|i| dummy_hash(i + 30)).collect();
        let tree_root = compute_state_tree_root(&leaves);

        // Prove inclusion of leaf[1] (index 1).
        // Layer 0: [L0, L1, L2, L3]
        // Layer 1: [H(L0,L1), H(L2,L3)]
        // Layer 2: [H(H(L0,L1), H(L2,L3))]
        //
        // Path for index 1:
        //   Step 0: sibling = leaves[0], path_bit = true (leaf[1] is right child)
        //   Step 1: sibling = H(L2,L3), path_bit = false (H(L0,L1) is left child)
        let sibling_0 = leaves[0];
        let sibling_1 = hash_pair(&leaves[2], &leaves[3]);
        let proof = MockInclusionProof {
            leaf_hash: leaves[1],
            root: tree_root.root,
            sibling_hashes: vec![sibling_0, sibling_1],
            path_bits: vec![true, false],
        };
        let result = verify_mock_inclusion(&proof, &tree_root.root);
        assert!(result.is_ok(), "inclusion proof should verify: {:?}", result);
    }

    #[test]
    fn test_mock_inclusion_wrong_root() {
        let leaves: Vec<[u8; 32]> = (0u8..2).map(|i| dummy_hash(i + 40)).collect();
        let tree_root = compute_state_tree_root(&leaves);
        let wrong_root = dummy_hash(0xff);
        let proof = MockInclusionProof {
            leaf_hash: leaves[0],
            root: tree_root.root,
            sibling_hashes: vec![leaves[1]],
            path_bits: vec![false],
        };
        let result = verify_mock_inclusion(&proof, &wrong_root);
        assert!(matches!(result, Err(CompressedLeavesError::WrongRoot)));
    }
}
