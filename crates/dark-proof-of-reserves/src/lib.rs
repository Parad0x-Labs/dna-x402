use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ReserveLeaf {
    /// SHA256("reserve-leaf-v1" || account_id[32] || balance_le[8] || nonce[32])
    pub leaf_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone)]
pub struct ReservesTree {
    /// XOR-fold of all leaf hashes (used as the accumulator root)
    pub root: [u8; 32],
    pub leaf_count: u32,
    /// Sum of all committed balances (internal — never exposed publicly)
    pub total_committed: u64,
    leaves: Vec<ReserveLeaf>,
    mainnet_ready: bool,
}

#[derive(Debug, Clone)]
pub struct InclusionProof {
    pub leaf_hash: [u8; 32],
    pub root: [u8; 32],
    /// True iff the leaf was found in the tree
    pub verified: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum ReservesError {
    ZeroBalance,
    LeafNotFound,
    EmptyTree,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Build a leaf commitment.
///
/// `leaf_hash` = SHA256("reserve-leaf-v1" || account_id || balance.to_le_bytes() || nonce)
///
/// Returns `ReservesError::ZeroBalance` when `balance == 0`.
pub fn create_leaf(
    account_id: &[u8; 32],
    balance: u64,
    nonce: &[u8; 32],
) -> Result<ReserveLeaf, ReservesError> {
    if balance == 0 {
        return Err(ReservesError::ZeroBalance);
    }

    let mut hasher = Sha256::new();
    hasher.update(b"reserve-leaf-v1");
    hasher.update(account_id);
    hasher.update(balance.to_le_bytes());
    hasher.update(nonce);
    let result = hasher.finalize();

    let mut leaf_hash = [0u8; 32];
    leaf_hash.copy_from_slice(&result);

    Ok(ReserveLeaf {
        leaf_hash,
        mainnet_ready: false,
    })
}

/// Create an empty reserves tree.
pub fn new_reserves_tree() -> ReservesTree {
    ReservesTree {
        root: [0u8; 32],
        leaf_count: 0,
        total_committed: 0,
        leaves: vec![],
        mainnet_ready: false,
    }
}

/// Add a leaf to the tree.
///
/// The root is updated by XOR-ing the new leaf hash into the running
/// accumulator byte-by-byte.
pub fn add_leaf(tree: &mut ReservesTree, leaf: ReserveLeaf, balance: u64) {
    // XOR accumulate
    for (r, &b) in tree.root.iter_mut().zip(leaf.leaf_hash.iter()) {
        *r ^= b;
    }
    tree.leaf_count += 1;
    tree.total_committed = tree.total_committed.saturating_add(balance);
    tree.leaves.push(leaf);
}

/// Prove that a leaf hash is contained in the tree.
///
/// Returns:
/// - `ReservesError::EmptyTree`   — tree has no leaves yet
/// - `ReservesError::LeafNotFound` — leaf hash is not in the tree
/// - `Ok(InclusionProof { verified: true, .. })` on success
pub fn prove_inclusion(
    tree: &ReservesTree,
    leaf_hash: &[u8; 32],
) -> Result<InclusionProof, ReservesError> {
    if tree.leaf_count == 0 {
        return Err(ReservesError::EmptyTree);
    }

    let found = tree.leaves.iter().any(|l| l.leaf_hash == *leaf_hash);
    if !found {
        return Err(ReservesError::LeafNotFound);
    }

    Ok(InclusionProof {
        leaf_hash: *leaf_hash,
        root: tree.root,
        verified: true,
        mainnet_ready: false,
    })
}

/// Produce a JSON public record for the reserves tree.
///
/// Exposes: root (hex), leaf_count, mainnet_ready=false.
/// Does NOT expose total_committed or any individual balance.
pub fn reserves_public_record(tree: &ReservesTree) -> String {
    let root_hex: String = tree.root.iter().map(|b| format!("{:02x}", b)).collect();
    serde_json::json!({
        "root": root_hex,
        "leaf_count": tree.leaf_count,
        "mainnet_ready": false
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_id(seed: u8) -> [u8; 32] {
        [seed; 32]
    }

    fn sample_nonce(seed: u8) -> [u8; 32] {
        [seed ^ 0xAB; 32]
    }

    // 1. Add 3 leaves and prove each is included.
    #[test]
    fn test_add_leaves_and_prove_inclusion() {
        let mut tree = new_reserves_tree();

        let leaf1 = create_leaf(&sample_id(1), 1_000, &sample_nonce(1)).unwrap();
        let leaf2 = create_leaf(&sample_id(2), 2_000, &sample_nonce(2)).unwrap();
        let leaf3 = create_leaf(&sample_id(3), 3_000, &sample_nonce(3)).unwrap();

        let h1 = leaf1.leaf_hash;
        let h2 = leaf2.leaf_hash;
        let h3 = leaf3.leaf_hash;

        add_leaf(&mut tree, leaf1, 1_000);
        add_leaf(&mut tree, leaf2, 2_000);
        add_leaf(&mut tree, leaf3, 3_000);

        assert_eq!(tree.leaf_count, 3);
        assert_eq!(tree.total_committed, 6_000);

        let p1 = prove_inclusion(&tree, &h1).unwrap();
        assert!(p1.verified);
        assert!(!p1.mainnet_ready);

        let p2 = prove_inclusion(&tree, &h2).unwrap();
        assert!(p2.verified);

        let p3 = prove_inclusion(&tree, &h3).unwrap();
        assert!(p3.verified);
    }

    // 2. prove_inclusion with an unknown leaf returns LeafNotFound.
    #[test]
    fn test_leaf_not_found_rejected() {
        let mut tree = new_reserves_tree();
        let leaf = create_leaf(&sample_id(10), 500, &sample_nonce(10)).unwrap();
        add_leaf(&mut tree, leaf, 500);

        let unknown_hash = [0xFFu8; 32];
        let err = prove_inclusion(&tree, &unknown_hash).unwrap_err();
        assert_eq!(err, ReservesError::LeafNotFound);
    }

    // 3. prove_inclusion on an empty tree returns EmptyTree.
    #[test]
    fn test_empty_tree_rejected() {
        let tree = new_reserves_tree();
        let hash = [0x01u8; 32];
        let err = prove_inclusion(&tree, &hash).unwrap_err();
        assert_eq!(err, ReservesError::EmptyTree);
    }

    // 4. create_leaf with balance == 0 returns ZeroBalance.
    #[test]
    fn test_zero_balance_leaf_rejected() {
        let err = create_leaf(&sample_id(99), 0, &sample_nonce(99)).unwrap_err();
        assert_eq!(err, ReservesError::ZeroBalance);
    }

    // 5. Root changes after each leaf addition.
    #[test]
    fn test_root_changes_on_add() {
        let mut tree = new_reserves_tree();
        let root0 = tree.root;

        let leaf1 = create_leaf(&sample_id(5), 100, &sample_nonce(5)).unwrap();
        add_leaf(&mut tree, leaf1, 100);
        let root1 = tree.root;
        assert_ne!(root0, root1, "root must change after first leaf");

        let leaf2 = create_leaf(&sample_id(6), 200, &sample_nonce(6)).unwrap();
        add_leaf(&mut tree, leaf2, 200);
        let root2 = tree.root;
        assert_ne!(root1, root2, "root must change after second leaf");

        let leaf3 = create_leaf(&sample_id(7), 300, &sample_nonce(7)).unwrap();
        add_leaf(&mut tree, leaf3, 300);
        let root3 = tree.root;
        assert_ne!(root2, root3, "root must change after third leaf");
    }

    // 6. reserves_public_record does not contain any balance amount as a string.
    #[test]
    fn test_public_record_hides_balances() {
        let mut tree = new_reserves_tree();

        let leaf1 = create_leaf(&sample_id(20), 99_999, &sample_nonce(20)).unwrap();
        let leaf2 = create_leaf(&sample_id(21), 12_345, &sample_nonce(21)).unwrap();
        add_leaf(&mut tree, leaf1, 99_999);
        add_leaf(&mut tree, leaf2, 12_345);

        let record = reserves_public_record(&tree);

        // Must not leak any individual or total balance as a plain number string
        assert!(
            !record.contains("99999"),
            "record must not contain individual balance 99999"
        );
        assert!(
            !record.contains("12345"),
            "record must not contain individual balance 12345"
        );
        assert!(
            !record.contains("112344"),
            "record must not contain total_committed"
        );

        // Sanity: the record must still carry a root and leaf_count
        assert!(record.contains("root"));
        assert!(record.contains("leaf_count"));
        assert!(record.contains("mainnet_ready"));
    }
}
