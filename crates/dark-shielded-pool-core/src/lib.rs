//! dark-shielded-pool-core — incremental Poseidon Merkle tree + recent-roots ring
//! for the Dark Null shielded pool (v2, matching `shielded_withdraw_v2.circom`).
//!
//! # What changed from the v1 stub
//!
//! The previous version hashed notes with SHA-256 and accumulated commitments
//! with `SHA256("pool-root-v1" || c0 || c1 || ...)` — a fold, not a tree. A real
//! circom proof (Poseidon, fixed-depth Merkle membership) could never verify
//! against that. This module now provides the REAL primitives:
//!
//!   * `commitment = Poseidon(3)(DOMAIN_COMMIT=1, secret, leaf_index)`
//!   * `nullifier  = Poseidon(3)(DOMAIN_NULLIF=2, secret, pool_key_field)`
//!   * a fixed-depth (`TREE_DEPTH = 20`) **incremental** Poseidon Merkle tree
//!     (Tornado-style `filled_subtrees` + `zeros`), whose root the circuit opens;
//!   * a ring of the last `RECENT_ROOTS` roots so a proof against a slightly
//!     stale root still verifies (deposits between proof-gen and submit).
//!
//! All hashing delegates to `dark-poseidon-real`, which byte-matches circomlib
//! and the `sol_poseidon` Bn254X5/BigEndian syscall. So a root computed here
//! equals a root the on-chain program computes with the syscall, which equals
//! the root the circuit proves membership against.
//!
//! `no_std`-friendly hashing (no host-only deps) so the on-chain program can use
//! the same insert logic via the syscall backend.
//!
//! NOT_PRODUCTION — devnet design only — no audit — `mainnet_ready = false`.

use dark_poseidon_real::{commitment as poseidon_commitment, merkle_node, nullifier as poseidon_nullifier};

/// Merkle tree depth — must equal the circuit's `ShieldedWithdraw(20)`.
pub const TREE_DEPTH: usize = 20;

/// Number of recent roots kept in the ring buffer. A withdrawal proof is
/// accepted if its root matches ANY of the last `RECENT_ROOTS` roots.
///
/// Kept modest (16) to bound on-chain `PoolConfig` size and the SBF stack frame
/// when (un)packing it; still a generous window for proofs generated against a
/// root that is a few deposits stale.
pub const RECENT_ROOTS: usize = 16;

/// `commitment = Poseidon(3)(DOMAIN_COMMIT=1, secret, leaf_index)`.
pub fn commitment(secret: &[u8; 32], leaf_index: u64) -> [u8; 32] {
    poseidon_commitment(secret, leaf_index)
}

/// `nullifier = Poseidon(3)(DOMAIN_NULLIF=2, secret, pool_key_field)`.
pub fn nullifier(secret: &[u8; 32], pool_key_field: &[u8; 32]) -> [u8; 32] {
    poseidon_nullifier(secret, pool_key_field)
}

/// The "zero subtree" hashes: `zeros[0] = 0`, `zeros[i] = Poseidon(zeros[i-1], zeros[i-1])`.
///
/// `zeros[i]` is the root of a fully-empty subtree of height `i`. Used to fill
/// the right side of the tree before real leaves arrive — identical convention
/// to the circuit's empty-leaf padding (leaf default = field 0).
pub fn zero_hashes() -> [[u8; 32]; TREE_DEPTH + 1] {
    let mut zeros = [[0u8; 32]; TREE_DEPTH + 1];
    for i in 1..=TREE_DEPTH {
        zeros[i] = merkle_node(&zeros[i - 1], &zeros[i - 1]);
    }
    zeros
}

/// Incremental fixed-depth Poseidon Merkle tree state.
///
/// Stores only `filled_subtrees[TREE_DEPTH]` and `next_index` — O(depth) state,
/// not O(2^depth). This is exactly what the on-chain `PoolConfig` would persist
/// (here we keep the full subtree array in one struct for the host helper; the
/// on-chain version stores the root + an analogous compact representation).
#[derive(Debug, Clone)]
pub struct IncrementalTree {
    /// Rightmost filled node at each level (Tornado convention).
    pub filled_subtrees: [[u8; 32]; TREE_DEPTH],
    /// Current root.
    pub root: [u8; 32],
    /// Number of leaves inserted so far (also the next leaf index).
    pub next_index: u64,
    zeros: [[u8; 32]; TREE_DEPTH + 1],
}

impl Default for IncrementalTree {
    fn default() -> Self {
        Self::new()
    }
}

impl IncrementalTree {
    /// Empty tree: every level filled with the corresponding zero-subtree hash,
    /// root = `zeros[TREE_DEPTH]`.
    pub fn new() -> Self {
        let zeros = zero_hashes();
        let mut filled_subtrees = [[0u8; 32]; TREE_DEPTH];
        for i in 0..TREE_DEPTH {
            filled_subtrees[i] = zeros[i];
        }
        IncrementalTree {
            filled_subtrees,
            root: zeros[TREE_DEPTH],
            next_index: 0,
            zeros,
        }
    }

    /// Insert a leaf at `next_index`, update `filled_subtrees` and `root`.
    /// Returns the index the leaf was inserted at.
    pub fn insert(&mut self, leaf: [u8; 32]) -> u64 {
        let index = self.next_index;
        assert!(index < (1u64 << TREE_DEPTH), "tree is full");

        let mut current_index = index;
        let mut current_hash = leaf;

        for i in 0..TREE_DEPTH {
            let (left, right) = if current_index & 1 == 0 {
                // current node is a left child: sibling on the right is still empty
                self.filled_subtrees[i] = current_hash;
                (current_hash, self.zeros[i])
            } else {
                // current node is a right child: sibling on the left is filled
                (self.filled_subtrees[i], current_hash)
            };
            current_hash = merkle_node(&left, &right);
            current_index >>= 1;
        }

        self.root = current_hash;
        self.next_index += 1;
        index
    }

    /// Rebuild the full set of leaf commitments into a fresh tree and produce the
    /// Merkle authentication path (siblings + left/right bits) for `leaf_index`.
    ///
    /// `leaves` is the dense list of commitments in insertion order. Empty slots
    /// past `leaves.len()` are the zero leaf. Returns `(path_elements, path_index, root)`.
    pub fn path_for(
        leaves: &[[u8; 32]],
        leaf_index: u64,
    ) -> ([[u8; 32]; TREE_DEPTH], [u8; TREE_DEPTH], [u8; 32]) {
        let zeros = zero_hashes();
        // Build each level explicitly so we can read off siblings.
        // level 0 = leaves padded to a power that covers leaf_index.
        let mut level: Vec<[u8; 32]> = leaves.to_vec();

        let mut path_elements = [[0u8; 32]; TREE_DEPTH];
        let mut path_index = [0u8; TREE_DEPTH];
        let mut idx = leaf_index as usize;

        for depth in 0..TREE_DEPTH {
            // sibling of idx at this level
            let sibling_idx = idx ^ 1;
            let sibling = level
                .get(sibling_idx)
                .copied()
                .unwrap_or(zeros[depth]);
            path_elements[depth] = sibling;
            path_index[depth] = (idx & 1) as u8; // 0 = leaf on left, 1 = leaf on right
            // hash up to next level
            let next_len = (level.len() + 1) / 2;
            let mut next = Vec::with_capacity(next_len);
            for j in 0..next_len {
                let l = level.get(2 * j).copied().unwrap_or(zeros[depth]);
                let r = level.get(2 * j + 1).copied().unwrap_or(zeros[depth]);
                next.push(merkle_node(&l, &r));
            }
            level = next;
            idx /= 2;
        }
        let root = level.first().copied().unwrap_or(zeros[TREE_DEPTH]);
        (path_elements, path_index, root)
    }
}

/// Fixed-capacity ring of recent Merkle roots.
///
/// On every deposit the new root is pushed. A withdrawal is valid if its proof's
/// root matches the current root OR any of the last `RECENT_ROOTS` roots. This
/// mirrors what the on-chain `PoolConfig` stores (a `[[u8;32]; RECENT_ROOTS]`
/// ring + a head cursor).
#[derive(Debug, Clone)]
pub struct RecentRoots {
    pub roots: [[u8; 32]; RECENT_ROOTS],
    pub head: u8,
    pub count: u8,
}

impl Default for RecentRoots {
    fn default() -> Self {
        RecentRoots {
            roots: [[0u8; 32]; RECENT_ROOTS],
            head: 0,
            count: 0,
        }
    }
}

impl RecentRoots {
    pub fn push(&mut self, root: [u8; 32]) {
        self.roots[self.head as usize] = root;
        self.head = ((self.head as usize + 1) % RECENT_ROOTS) as u8;
        if (self.count as usize) < RECENT_ROOTS {
            self.count += 1;
        }
    }

    pub fn contains(&self, root: &[u8; 32]) -> bool {
        if *root == [0u8; 32] {
            return false;
        }
        self.roots[..self.count as usize].iter().any(|r| r == root)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn secret(byte: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0x01;
        s[31] = byte;
        s
    }

    #[test]
    fn zero_hashes_chain_is_deterministic_and_nonzero_above_0() {
        let z = zero_hashes();
        assert_eq!(z[0], [0u8; 32], "zeros[0] is the zero leaf");
        for i in 1..=TREE_DEPTH {
            assert_ne!(z[i], [0u8; 32], "zeros[{}] must be nonzero", i);
            assert_eq!(z[i], merkle_node(&z[i - 1], &z[i - 1]));
        }
    }

    #[test]
    fn empty_tree_root_equals_zeros_top() {
        let t = IncrementalTree::new();
        let z = zero_hashes();
        assert_eq!(t.root, z[TREE_DEPTH]);
        assert_eq!(t.next_index, 0);
    }

    #[test]
    fn insert_changes_root_and_advances_index() {
        let mut t = IncrementalTree::new();
        let r0 = t.root;
        let c0 = commitment(&secret(0xAA), 0);
        let idx = t.insert(c0);
        assert_eq!(idx, 0);
        assert_eq!(t.next_index, 1);
        assert_ne!(t.root, r0, "root must change after first insert");
    }

    #[test]
    fn incremental_root_matches_full_rebuild() {
        // Insert N leaves incrementally; independently rebuild via path_for and
        // compare the root. They MUST agree (same Poseidon, same tree shape).
        let mut t = IncrementalTree::new();
        let mut leaves = Vec::new();
        for i in 0..5u64 {
            let c = commitment(&secret(i as u8 + 1), i);
            leaves.push(c);
            t.insert(c);
        }
        let (_pe, _pi, rebuilt_root) = IncrementalTree::path_for(&leaves, 0);
        assert_eq!(
            t.root, rebuilt_root,
            "incremental root must equal full-rebuild root"
        );
    }

    #[test]
    fn merkle_path_verifies_against_root() {
        // Build a tree, get the path for a specific leaf, then re-walk the path
        // by hand exactly as the circuit's MerkleProof gadget does, and confirm
        // it lands on the tree root.
        let mut leaves = Vec::new();
        let mut t = IncrementalTree::new();
        for i in 0..7u64 {
            let c = commitment(&secret(i as u8 + 10), i);
            leaves.push(c);
            t.insert(c);
        }
        let target = 3u64;
        let (path_elements, path_index, root) = IncrementalTree::path_for(&leaves, target);
        assert_eq!(root, t.root);

        // Re-walk: hashes[0] = leaf; at each level mux on path_index then hash.
        let mut cur = leaves[target as usize];
        for d in 0..TREE_DEPTH {
            let sib = path_elements[d];
            cur = if path_index[d] == 0 {
                merkle_node(&cur, &sib) // leaf on left
            } else {
                merkle_node(&sib, &cur) // leaf on right
            };
        }
        assert_eq!(cur, root, "hand-walked path must reach the root");
    }

    #[test]
    fn recent_roots_ring_contains_pushed() {
        let mut rr = RecentRoots::default();
        let a = [1u8; 32];
        let b = [2u8; 32];
        rr.push(a);
        rr.push(b);
        assert!(rr.contains(&a));
        assert!(rr.contains(&b));
        assert!(!rr.contains(&[3u8; 32]));
        assert!(!rr.contains(&[0u8; 32]), "zero root never matches");
    }

    #[test]
    fn recent_roots_ring_evicts_oldest() {
        let mut rr = RecentRoots::default();
        for i in 0..(RECENT_ROOTS as u8 + 5) {
            let mut r = [0u8; 32];
            r[0] = i + 1; // never zero
            rr.push(r);
        }
        // first 5 pushed roots evicted
        let mut oldest = [0u8; 32];
        oldest[0] = 1;
        assert!(!rr.contains(&oldest), "oldest root should be evicted");
        let mut newest = [0u8; 32];
        newest[0] = RECENT_ROOTS as u8 + 5;
        assert!(rr.contains(&newest));
    }

    #[test]
    fn commitment_and_nullifier_match_poseidon_real() {
        let s = secret(0x7E);
        assert_eq!(commitment(&s, 9), poseidon_commitment(&s, 9));
        // pool_key_field MUST be a canonical BN254 Fr element (< r). High byte
        // 0x10 keeps 0x1010..10 well under the modulus r ~= 0x3064...
        let pk = [0x10u8; 32];
        assert_eq!(nullifier(&s, &pk), poseidon_nullifier(&s, &pk));
    }
}
