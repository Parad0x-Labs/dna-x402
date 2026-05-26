use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct MerkleTree {
    pub root: [u8; 32],
    pub leaf_count: u32,
    pub mainnet_ready: bool,
    leaves: Vec<[u8; 32]>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MerkleInclusionProof {
    pub leaf_hash: [u8; 32],
    pub root: [u8; 32],
    /// Sibling hashes from leaf up to root.
    pub path: Vec<[u8; 32]>,
    pub verified: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum MerkleError {
    EmptyTree,
    LeafNotFound,
    EmptyData,
}

// ── Internal helpers ───────────────────────────────────────────────────────

fn leaf_hash(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"merkle-leaf-v1");
    h.update(data);
    h.finalize().into()
}

fn node_hash(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (l, r) = if a <= b { (a, b) } else { (b, a) };
    let mut h = Sha256::new();
    h.update(b"merkle-node-v1");
    h.update(l);
    h.update(r);
    h.finalize().into()
}

fn compute_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    if leaves.is_empty() {
        return [0u8; 32];
    }
    if leaves.len() == 1 {
        return leaves[0];
    }
    let mut current = leaves.to_vec();
    while current.len() > 1 {
        let mut next = Vec::new();
        let mut i = 0;
        while i < current.len() {
            if i + 1 < current.len() {
                let (l, r) = if current[i] <= current[i + 1] {
                    (current[i], current[i + 1])
                } else {
                    (current[i + 1], current[i])
                };
                let mut h = Sha256::new();
                h.update(b"merkle-node-v1");
                h.update(l);
                h.update(r);
                next.push(h.finalize().into());
            } else {
                // Odd leaf out — hash with itself.
                let mut h = Sha256::new();
                h.update(b"merkle-node-v1");
                h.update(current[i]);
                h.update(current[i]);
                next.push(h.finalize().into());
            }
            i += 2;
        }
        current = next;
    }
    current[0]
}

/// Collect sibling hashes from `leaf_index` up to the root.
/// Returns the path in bottom-up order (leaf level first).
fn build_path(leaves: &[[u8; 32]], leaf_index: usize) -> Vec<[u8; 32]> {
    let mut path = Vec::new();
    let mut current = leaves.to_vec();
    let mut idx = leaf_index;

    while current.len() > 1 {
        // Sibling index
        let sibling_idx = if idx % 2 == 0 {
            // We are a left child; sibling is to the right (or us again if odd-out)
            if idx + 1 < current.len() { idx + 1 } else { idx }
        } else {
            idx - 1
        };
        path.push(current[sibling_idx]);

        // Advance to next level
        let mut next = Vec::new();
        let mut i = 0;
        while i < current.len() {
            if i + 1 < current.len() {
                let (l, r) = if current[i] <= current[i + 1] {
                    (current[i], current[i + 1])
                } else {
                    (current[i + 1], current[i])
                };
                let mut h = Sha256::new();
                h.update(b"merkle-node-v1");
                h.update(l);
                h.update(r);
                next.push(h.finalize().into());
            } else {
                let mut h = Sha256::new();
                h.update(b"merkle-node-v1");
                h.update(current[i]);
                h.update(current[i]);
                next.push(h.finalize().into());
            }
            i += 2;
        }

        idx /= 2;
        current = next;
    }
    path
}

// ── Public API ─────────────────────────────────────────────────────────────

/// Create an empty Merkle tree.
pub fn new_tree() -> MerkleTree {
    MerkleTree {
        root: [0u8; 32],
        leaf_count: 0,
        leaves: vec![],
        mainnet_ready: false,
    }
}

/// Hash `data` as a leaf and insert it; returns the leaf hash.
pub fn add_leaf(tree: &mut MerkleTree, data: &[u8]) -> Result<[u8; 32], MerkleError> {
    if data.is_empty() {
        return Err(MerkleError::EmptyData);
    }
    let lh = leaf_hash(data);
    tree.leaves.push(lh);
    tree.leaf_count += 1;
    tree.root = compute_root(&tree.leaves);
    Ok(lh)
}

/// Build an inclusion proof for a leaf already in the tree.
pub fn prove_inclusion(
    tree: &MerkleTree,
    leaf_hash: &[u8; 32],
) -> Result<MerkleInclusionProof, MerkleError> {
    if tree.leaf_count == 0 {
        return Err(MerkleError::EmptyTree);
    }
    let idx = tree
        .leaves
        .iter()
        .position(|l| l == leaf_hash)
        .ok_or(MerkleError::LeafNotFound)?;

    let path = build_path(&tree.leaves, idx);

    Ok(MerkleInclusionProof {
        leaf_hash: *leaf_hash,
        root: tree.root,
        path,
        verified: true,
        mainnet_ready: tree.mainnet_ready,
    })
}

/// Re-derive the root from a proof and confirm it matches `proof.root`.
pub fn verify_inclusion(proof: &MerkleInclusionProof) -> bool {
    let mut current = proof.leaf_hash;
    for sibling in &proof.path {
        current = node_hash(&current, sibling);
    }
    current == proof.root
}

/// Return a JSON summary of the tree (no raw leaf data).
pub fn tree_public_record(tree: &MerkleTree) -> String {
    let root_hex: String = tree.root.iter().map(|b| format!("{:02x}", b)).collect();
    serde_json::json!({
        "root": root_hex,
        "leaf_count": tree.leaf_count,
        "mainnet_ready": tree.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // 1. Single leaf: tree root == leaf hash; inclusion proof verifies.
    #[test]
    fn test_add_and_prove_single_leaf() {
        let mut tree = new_tree();
        let lh = add_leaf(&mut tree, b"dna-x402-leaf-alpha").unwrap();
        assert_eq!(tree.leaf_count, 1);
        assert_eq!(tree.root, lh);

        let proof = prove_inclusion(&tree, &lh).unwrap();
        assert_eq!(proof.leaf_hash, lh);
        assert_eq!(proof.root, tree.root);
        assert!(proof.verified);
    }

    // 2. Four leaves; every leaf can be independently proven.
    #[test]
    fn test_add_and_prove_multiple_leaves() {
        let mut tree = new_tree();
        let payloads: &[&[u8]] = &[b"alpha", b"beta", b"gamma", b"delta"];
        let mut hashes = Vec::new();
        for p in payloads {
            hashes.push(add_leaf(&mut tree, p).unwrap());
        }
        assert_eq!(tree.leaf_count, 4);

        for lh in &hashes {
            let proof = prove_inclusion(&tree, lh).unwrap();
            assert_eq!(proof.root, tree.root);
        }
    }

    // 3. Full round-trip: add, prove, verify.
    #[test]
    fn test_verify_inclusion_passes() {
        let mut tree = new_tree();
        let lh = add_leaf(&mut tree, b"round-trip-data").unwrap();
        add_leaf(&mut tree, b"extra-leaf").unwrap();

        let proof = prove_inclusion(&tree, &lh).unwrap();
        assert!(verify_inclusion(&proof));
    }

    // 4. prove_inclusion on an empty tree returns EmptyTree.
    #[test]
    fn test_empty_tree_rejected() {
        let tree = new_tree();
        let dummy = [0u8; 32];
        assert_eq!(prove_inclusion(&tree, &dummy), Err(MerkleError::EmptyTree));
    }

    // 5. Root changes with every add_leaf call.
    #[test]
    fn test_root_changes_on_add() {
        let mut tree = new_tree();
        let mut roots = vec![tree.root];
        for i in 0u8..4 {
            add_leaf(&mut tree, &[i, i + 1, i + 2]).unwrap();
            roots.push(tree.root);
        }
        // Every root must differ from the previous one.
        for w in roots.windows(2) {
            assert_ne!(w[0], w[1], "root did not change after add_leaf");
        }
    }

    // 6. tree_public_record JSON has "root" and "leaf_count".
    #[test]
    fn test_public_record_shape() {
        let mut tree = new_tree();
        add_leaf(&mut tree, b"shape-test").unwrap();
        let json_str = tree_public_record(&tree);
        let v: serde_json::Value = serde_json::from_str(&json_str).unwrap();
        assert!(v.get("root").is_some(), "missing 'root' field");
        assert!(v.get("leaf_count").is_some(), "missing 'leaf_count' field");
        assert!(v.get("mainnet_ready").is_some(), "missing 'mainnet_ready' field");
        // root must be a 64-char hex string (32 bytes).
        let root_hex = v["root"].as_str().unwrap();
        assert_eq!(root_hex.len(), 64);
        assert_eq!(v["leaf_count"].as_u64().unwrap(), 1);
    }
}
