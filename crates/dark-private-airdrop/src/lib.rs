// dark-private-airdrop - private Merkle airdrop with nullifier-based anti-double-claim
// Prove eligibility without revealing recipient list position.
// NOT_PRODUCTION - devnet design only - no audit - mainnet_ready = false

use sha2::{Digest, Sha256};

// -- Domain separation constants --------------------------------------------

const DOMAIN_LEAF: u8 = 0x20; // recipient leaf
const DOMAIN_NODE: u8 = 0x21; // Merkle node
const DOMAIN_NULL: u8 = 0x22; // airdrop nullifier
const DOMAIN_GENESIS: u8 = 0x23; // tree root

// -- Core types -------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct AirdropLeaf {
    /// SHA256(DOMAIN_LEAF || recipient_hash || amount_le8 || nonce)
    pub leaf_hash: [u8; 32],
    /// SHA256 of recipient identity - never raw
    pub recipient_hash: [u8; 32],
    /// Amount committed - not stored raw in the public tree
    pub amount: u64,
    /// Blinding nonce
    pub nonce: [u8; 32],
    pub mainnet_ready: bool, // always false
}

#[derive(Debug, Clone, PartialEq)]
pub struct AirdropTree {
    /// Sorted leaves for deterministic root construction
    pub leaf_hashes: Vec<[u8; 32]>,
    /// SHA256(DOMAIN_GENESIS || count_le4 || binary_tree_root)
    pub root: [u8; 32],
    pub mainnet_ready: bool, // always false
}

/// Merkle inclusion proof.
///
/// `root` holds the **binary-tree root** (before genesis wrapping).
/// `verify_inclusion` reconstructs and checks against `root`.
/// `claim()` re-wraps with DOMAIN_GENESIS + leaf_count to validate
/// against the full `AirdropTree.root`.
#[derive(Debug, Clone, PartialEq)]
pub struct AirdropProof {
    pub leaf_hash: [u8; 32],
    /// Sibling entries walking from leaf up to root.
    /// Each tuple is (sibling_hash, is_right_sibling):
    ///   is_right_sibling = true  means sibling is RIGHT of current: hash(current, sibling)
    ///   is_right_sibling = false means sibling is LEFT  of current: hash(sibling, current)
    pub siblings: Vec<([u8; 32], bool)>,
    /// Binary-tree root (pre-genesis-wrap). Used by verify_inclusion.
    pub root: [u8; 32],
    /// Number of leaves in the tree (needed so claim() can re-derive genesis root).
    pub leaf_count: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ClaimNullifier {
    /// SHA256(DOMAIN_NULL || leaf_hash || secret)
    pub nullifier: [u8; 32],
    pub leaf_hash: [u8; 32],
    pub mainnet_ready: bool, // always false
}

#[derive(Debug, Clone, PartialEq)]
pub struct ClaimReceipt {
    pub nullifier: [u8; 32],
    pub amount: u64, // revealed at claim time
    pub claimed_at_slot: u64,
    pub mainnet_ready: bool, // always false
}

#[derive(Debug, PartialEq)]
pub enum AirdropError {
    EmptyRecipientList,
    DuplicateRecipient,
    LeafNotInTree,
    InvalidProof,
    AlreadyClaimed, // nullifier already used
    InvalidLeaf,    // commitment mismatch
}

// -- Internal helpers -------------------------------------------------------

fn hash_recipient(recipient_id: &[u8]) -> [u8; 32] {
    Sha256::digest(recipient_id).into()
}

fn compute_leaf_hash(recipient_hash: &[u8; 32], amount: u64, nonce: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([DOMAIN_LEAF]);
    h.update(recipient_hash);
    h.update(amount.to_le_bytes());
    h.update(nonce);
    h.finalize().into()
}

fn node_hash(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([DOMAIN_NODE]);
    h.update(left);
    h.update(right);
    h.finalize().into()
}

/// Build all tree levels from sorted leaves.
/// levels[0] = leaf layer, levels[last] = [binary_root].
fn build_levels(sorted_leaves: &[[u8; 32]]) -> Vec<Vec<[u8; 32]>> {
    assert!(!sorted_leaves.is_empty());
    let mut levels: Vec<Vec<[u8; 32]>> = vec![sorted_leaves.to_vec()];
    while levels.last().unwrap().len() > 1 {
        let current = levels.last().unwrap().clone();
        let mut next: Vec<[u8; 32]> = Vec::new();
        let mut i = 0;
        while i < current.len() {
            let left = current[i];
            let right = if i + 1 < current.len() {
                current[i + 1]
            } else {
                current[i]
            };
            next.push(node_hash(&left, &right));
            i += 2;
        }
        levels.push(next);
    }
    levels
}

fn binary_root(sorted_leaf_hashes: &[[u8; 32]]) -> [u8; 32] {
    if sorted_leaf_hashes.len() == 1 {
        return sorted_leaf_hashes[0];
    }
    build_levels(sorted_leaf_hashes).last().unwrap()[0]
}

fn wrap_genesis(bin_root: &[u8; 32], leaf_count: u32) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([DOMAIN_GENESIS]);
    h.update(leaf_count.to_le_bytes());
    h.update(bin_root);
    h.finalize().into()
}

// -- Public API -------------------------------------------------------------

pub fn create_leaf(recipient_id: &[u8], amount: u64, nonce: &[u8; 32]) -> AirdropLeaf {
    let recipient_hash = hash_recipient(recipient_id);
    let leaf_hash = compute_leaf_hash(&recipient_hash, amount, nonce);
    AirdropLeaf {
        leaf_hash,
        recipient_hash,
        amount,
        nonce: *nonce,
        mainnet_ready: false,
    }
}

pub fn build_tree(leaves: &[AirdropLeaf]) -> Result<AirdropTree, AirdropError> {
    if leaves.is_empty() {
        return Err(AirdropError::EmptyRecipientList);
    }
    let mut sorted_hashes: Vec<[u8; 32]> = leaves.iter().map(|l| l.leaf_hash).collect();
    sorted_hashes.sort();
    for w in sorted_hashes.windows(2) {
        if w[0] == w[1] {
            return Err(AirdropError::DuplicateRecipient);
        }
    }
    let bin = binary_root(&sorted_hashes);
    let root = wrap_genesis(&bin, sorted_hashes.len() as u32);
    Ok(AirdropTree {
        leaf_hashes: sorted_hashes,
        root,
        mainnet_ready: false,
    })
}

pub fn prove_inclusion(
    tree: &AirdropTree,
    leaf: &AirdropLeaf,
) -> Result<AirdropProof, AirdropError> {
    let pos = tree
        .leaf_hashes
        .iter()
        .position(|&h| h == leaf.leaf_hash)
        .ok_or(AirdropError::LeafNotInTree)?;

    let leaf_count = tree.leaf_hashes.len() as u32;

    if tree.leaf_hashes.len() == 1 {
        return Ok(AirdropProof {
            leaf_hash: leaf.leaf_hash,
            siblings: vec![],
            root: leaf.leaf_hash,
            leaf_count,
        });
    }

    let levels = build_levels(&tree.leaf_hashes);
    let mut siblings: Vec<([u8; 32], bool)> = Vec::new();
    let mut idx = pos;

    for level in &levels[..levels.len().saturating_sub(1)] {
        if idx % 2 == 0 {
            let sib_idx = if idx + 1 < level.len() { idx + 1 } else { idx };
            siblings.push((level[sib_idx], true)); // sibling on right
        } else {
            siblings.push((level[idx - 1], false)); // sibling on left
        }
        idx /= 2;
    }

    let bin = binary_root(&tree.leaf_hashes);
    Ok(AirdropProof {
        leaf_hash: leaf.leaf_hash,
        siblings,
        root: bin,
        leaf_count,
    })
}

pub fn verify_inclusion(proof: &AirdropProof) -> bool {
    if proof.siblings.is_empty() {
        return proof.root == proof.leaf_hash;
    }
    let mut current = proof.leaf_hash;
    for (sibling, is_right) in &proof.siblings {
        current = if *is_right {
            node_hash(&current, sibling)
        } else {
            node_hash(sibling, &current)
        };
    }
    current == proof.root
}

pub fn make_claim_nullifier(leaf: &AirdropLeaf, secret: &[u8; 32]) -> ClaimNullifier {
    let mut h = Sha256::new();
    h.update([DOMAIN_NULL]);
    h.update(leaf.leaf_hash);
    h.update(secret);
    let nullifier: [u8; 32] = h.finalize().into();
    ClaimNullifier {
        nullifier,
        leaf_hash: leaf.leaf_hash,
        mainnet_ready: false,
    }
}

pub fn claim(
    tree: &AirdropTree,
    leaf: &AirdropLeaf,
    proof: &AirdropProof,
    nullifier: &ClaimNullifier,
    slot: u64,
) -> Result<ClaimReceipt, AirdropError> {
    let expected = compute_leaf_hash(&leaf.recipient_hash, leaf.amount, &leaf.nonce);
    if expected != leaf.leaf_hash {
        return Err(AirdropError::InvalidLeaf);
    }
    if nullifier.leaf_hash != leaf.leaf_hash {
        return Err(AirdropError::InvalidLeaf);
    }
    if proof.leaf_hash != leaf.leaf_hash {
        return Err(AirdropError::InvalidProof);
    }
    if !verify_inclusion(proof) {
        return Err(AirdropError::InvalidProof);
    }
    let derived = wrap_genesis(&proof.root, proof.leaf_count);
    if derived != tree.root {
        return Err(AirdropError::InvalidProof);
    }
    Ok(ClaimReceipt {
        nullifier: nullifier.nullifier,
        amount: leaf.amount,
        claimed_at_slot: slot,
        mainnet_ready: false,
    })
}

// -- Tests ------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn nonce(b: u8) -> [u8; 32] {
        [b; 32]
    }
    fn secret(b: u8) -> [u8; 32] {
        [b; 32]
    }

    // 1. mainnet_ready is always false on AirdropLeaf
    #[test]
    fn test_leaf_mainnet_ready_false() {
        let leaf = create_leaf(b"alice", 1_000, &nonce(0x01));
        assert!(!leaf.mainnet_ready);
    }

    // 2. Creating a leaf twice with the same inputs yields the same hash
    #[test]
    fn test_leaf_hash_deterministic() {
        let a = create_leaf(b"alice", 500, &nonce(0xAA));
        let b = create_leaf(b"alice", 500, &nonce(0xAA));
        assert_eq!(a.leaf_hash, b.leaf_hash);
    }

    // 3. leaf_hash is NOT equal to SHA256 of the raw recipient_id
    #[test]
    fn test_leaf_hides_recipient_id() {
        let leaf = create_leaf(b"bob", 100, &nonce(0x01));
        let raw: [u8; 32] = Sha256::digest(b"bob").into();
        assert_ne!(leaf.leaf_hash, raw);
    }

    // 4. Single-leaf tree builds without error; root is deterministic
    #[test]
    fn test_build_tree_single_leaf() {
        let leaf = create_leaf(b"alice", 1_000, &nonce(0x01));
        let tree = build_tree(&[leaf.clone()]).unwrap();
        assert_eq!(tree.leaf_hashes.len(), 1);
        assert!(!tree.mainnet_ready);
        assert_eq!(tree.root, build_tree(&[leaf]).unwrap().root);
    }

    // 5. Two-leaf tree root is stable regardless of input order
    #[test]
    fn test_build_tree_two_leaves() {
        let la = create_leaf(b"alice", 1_000, &nonce(0x01));
        let lb = create_leaf(b"bob", 2_000, &nonce(0x02));
        let t1 = build_tree(&[la.clone(), lb.clone()]).unwrap();
        let t2 = build_tree(&[lb, la]).unwrap();
        assert_eq!(t1.root, t2.root);
        assert_eq!(t1.leaf_hashes.len(), 2);
    }

    // 6. Four-leaf tree root is consistent regardless of input order
    #[test]
    fn test_build_tree_four_leaves_consistent_root() {
        let leaves: Vec<AirdropLeaf> = (0u8..4)
            .map(|i| create_leaf(&[b'u', i], u64::from(i) * 100 + 50, &nonce(i)))
            .collect();
        let t1 = build_tree(&leaves).unwrap();
        let mut rev = leaves.clone();
        rev.reverse();
        let t2 = build_tree(&rev).unwrap();
        assert_eq!(t1.root, t2.root);
    }

    // 7. Prove and verify inclusion for a single-leaf tree
    #[test]
    fn test_prove_and_verify_inclusion_single() {
        let leaf = create_leaf(b"alice", 1_000, &nonce(0x01));
        let tree = build_tree(&[leaf.clone()]).unwrap();
        let proof = prove_inclusion(&tree, &leaf).unwrap();
        assert!(verify_inclusion(&proof));
    }

    // 8. Prove and verify each of 4 leaves in a 4-leaf tree
    #[test]
    fn test_prove_and_verify_inclusion_multi() {
        let leaves: Vec<AirdropLeaf> = (0u8..4)
            .map(|i| create_leaf(&[b'u', i], u64::from(i) * 100 + 1, &nonce(i + 10)))
            .collect();
        let tree = build_tree(&leaves).unwrap();
        for leaf in &leaves {
            let proof = prove_inclusion(&tree, leaf).unwrap();
            assert!(
                verify_inclusion(&proof),
                "failed for amount {}",
                leaf.amount
            );
        }
    }

    // 9. A leaf NOT in the tree returns LeafNotInTree
    #[test]
    fn test_wrong_leaf_fails_verification() {
        let la = create_leaf(b"alice", 1_000, &nonce(0x01));
        let lb = create_leaf(b"bob", 2_000, &nonce(0x02));
        let tree = build_tree(&[la]).unwrap();
        assert_eq!(
            prove_inclusion(&tree, &lb).unwrap_err(),
            AirdropError::LeafNotInTree
        );
    }

    // 10. Full claim succeeds for a valid proof and nullifier
    #[test]
    fn test_claim_succeeds() {
        let leaf = create_leaf(b"carol", 5_000, &nonce(0x10));
        let tree = build_tree(&[leaf.clone()]).unwrap();
        let proof = prove_inclusion(&tree, &leaf).unwrap();
        let nullifier = make_claim_nullifier(&leaf, &secret(0xFF));
        let receipt = claim(&tree, &leaf, &proof, &nullifier, 42).unwrap();
        assert_eq!(receipt.claimed_at_slot, 42);
        assert!(!receipt.mainnet_ready);
    }

    // 11. Claim receipt reveals the correct amount
    #[test]
    fn test_claim_reveals_amount() {
        let amount = 12_345_678u64;
        let leaf = create_leaf(b"dave", amount, &nonce(0x20));
        let tree = build_tree(&[leaf.clone()]).unwrap();
        let proof = prove_inclusion(&tree, &leaf).unwrap();
        let null = make_claim_nullifier(&leaf, &secret(0x01));
        assert_eq!(
            claim(&tree, &leaf, &proof, &null, 1).unwrap().amount,
            amount
        );
    }

    // 12. Different secrets produce different nullifiers for the same leaf
    #[test]
    fn test_nullifier_different_secrets_produce_different_nullifiers() {
        let leaf = create_leaf(b"eve", 999, &nonce(0x30));
        let n1 = make_claim_nullifier(&leaf, &secret(0xAA));
        let n2 = make_claim_nullifier(&leaf, &secret(0xBB));
        assert_ne!(n1.nullifier, n2.nullifier);
    }

    // 13. Empty recipient list returns EmptyRecipientList error
    #[test]
    fn test_empty_recipient_list_rejected() {
        assert_eq!(
            build_tree(&[]).unwrap_err(),
            AirdropError::EmptyRecipientList
        );
    }

    // 14. Claim with a proof for a different leaf fails
    #[test]
    fn test_claim_with_wrong_proof_fails() {
        let la = create_leaf(b"alice", 1_000, &nonce(0x01));
        let lb = create_leaf(b"bob", 2_000, &nonce(0x02));
        let tree = build_tree(&[la.clone(), lb.clone()]).unwrap();
        let proof_a = prove_inclusion(&tree, &la).unwrap();
        let null_b = make_claim_nullifier(&lb, &secret(0x01));
        // leaf_b's leaf_hash != proof_a.leaf_hash => InvalidProof
        assert!(claim(&tree, &lb, &proof_a, &null_b, 1).is_err());
    }

    // 15. Changing one leaf changes the tree root
    #[test]
    fn test_tree_root_changes_when_leaf_changes() {
        let la = create_leaf(b"alice", 1_000, &nonce(0x01));
        let lb = create_leaf(b"alice", 2_000, &nonce(0x01)); // different amount
        assert_ne!(
            build_tree(&[la]).unwrap().root,
            build_tree(&[lb]).unwrap().root
        );
    }
}
