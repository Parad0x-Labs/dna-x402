//! dark-receipt-aggregator
//!
//! Aggregate N x402 payment receipts into a single compact Merkle commitment.
//! Useful for:
//! - Subscription billing (prove 30 receipts this month without revealing each)
//! - Batch settlement (one on-chain tx covers N payments)
//! - Privacy: membership proof for one receipt without revealing others
//!
//! # Domain constants (u8)
//! - `DOMAIN_LEAF       = 0x60`
//! - `DOMAIN_NODE       = 0x61`
//! - `DOMAIN_AGG        = 0x62`
//! - `DOMAIN_MEMBERSHIP = 0x63`
//!
//! # Leaf hash
//! `receipt_leaf_hash = SHA256(DOMAIN_LEAF || receipt_hash_32 || service_hash_32 || slot_le8)`
//!
//! # Aggregate root
//! `aggregate_root = SHA256(DOMAIN_AGG || count_le4 || merkle_root_of_sorted_leaves)`

use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Domain separation constants
// ---------------------------------------------------------------------------

const DOMAIN_LEAF: u8 = 0x60;
const DOMAIN_NODE: u8 = 0x61;
const DOMAIN_AGG: u8 = 0x62;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// A single x402 payment receipt to be included in an aggregate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReceiptEntry {
    /// 32-byte payment receipt identifier (opaque hash from the x402 protocol).
    pub receipt_hash: [u8; 32],
    /// 32-byte service identifier hash.
    pub service_hash: [u8; 32],
    /// Time-slot (e.g. billing period epoch or block slot). Used in leaf hash.
    pub slot: u64,
    /// Always `false` — mainnet deployment is not yet enabled.
    pub mainnet_ready: bool,
}

/// The result of aggregating one or more `ReceiptEntry` values.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReceiptAggregate {
    /// Top-level commitment: `SHA256(DOMAIN_AGG || count_le4 || merkle_root)`.
    pub agg_root: [u8; 32],
    /// Number of receipts included.
    pub count: u32,
    /// Root of the inner binary Merkle tree over sorted leaf hashes.
    pub merkle_root: [u8; 32],
    /// Always `false`.
    pub mainnet_ready: bool,
}

/// A Merkle membership proof asserting that one receipt is inside a
/// `ReceiptAggregate` without revealing any other receipt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MembershipProof {
    /// The leaf hash being proven.
    pub receipt_leaf: [u8; 32],
    /// Sibling hashes along the path from leaf to root.
    /// Each element is `(sibling_hash, is_right_sibling)`.
    pub siblings: Vec<([u8; 32], bool)>,
    /// The aggregate root this proof is against.
    pub agg_root: [u8; 32],
    /// Number of receipts in the aggregate (needed to re-derive `agg_root`).
    pub count: u32,
    /// Always `false`.
    pub mainnet_ready: bool,
}

/// Error type for all aggregator operations.
#[derive(Debug, PartialEq, Eq)]
pub enum AggregateError {
    /// Called `aggregate` or `prove_membership` with zero entries.
    EmptyReceipts,
    /// Two entries in the input produced the same leaf hash.
    DuplicateReceipt,
    /// The specified `entry` is not present in `agg`'s leaf set.
    ReceiptNotInAggregate,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Construct a `ReceiptEntry` from its components.
///
/// `mainnet_ready` is always `false`.
pub fn make_entry(receipt_hash: &[u8; 32], service_hash: &[u8; 32], slot: u64) -> ReceiptEntry {
    ReceiptEntry {
        receipt_hash: *receipt_hash,
        service_hash: *service_hash,
        slot,
        mainnet_ready: false,
    }
}

/// Aggregate a non-empty slice of `ReceiptEntry` values into a single
/// `ReceiptAggregate`.
///
/// # Errors
/// - `EmptyReceipts` – `entries` is empty.
/// - `DuplicateReceipt` – two entries produce the same leaf hash.
pub fn aggregate(entries: &[ReceiptEntry]) -> Result<ReceiptAggregate, AggregateError> {
    if entries.is_empty() {
        return Err(AggregateError::EmptyReceipts);
    }

    // Compute all leaf hashes.
    let mut leaves: Vec<[u8; 32]> = entries.iter().map(leaf_hash).collect();

    // Duplicate detection before sorting (O(n log n) de-dup).
    {
        let mut sorted = leaves.clone();
        sorted.sort_unstable();
        for w in sorted.windows(2) {
            if w[0] == w[1] {
                return Err(AggregateError::DuplicateReceipt);
            }
        }
    }

    // Sort for deterministic root.
    leaves.sort_unstable();

    let count = entries.len() as u32;
    let merkle_root = build_merkle_root(&leaves);
    let agg_root = compute_agg_root(count, &merkle_root);

    Ok(ReceiptAggregate {
        agg_root,
        count,
        merkle_root,
        mainnet_ready: false,
    })
}

/// Generate a `MembershipProof` showing that `entry` is contained in `agg`.
///
/// `all_entries` must be the same slice that was passed to `aggregate` when
/// `agg` was produced. The function re-derives the sorted leaf list
/// internally.
///
/// # Errors
/// - `EmptyReceipts` – `all_entries` is empty.
/// - `DuplicateReceipt` – `all_entries` contains duplicate leaf hashes.
/// - `ReceiptNotInAggregate` – `entry`'s leaf hash is not found in the sorted
///   leaf list or the recomputed aggregate root does not match `agg.agg_root`.
pub fn prove_membership(
    agg: &ReceiptAggregate,
    entry: &ReceiptEntry,
    all_entries: &[ReceiptEntry],
) -> Result<MembershipProof, AggregateError> {
    if all_entries.is_empty() {
        return Err(AggregateError::EmptyReceipts);
    }

    let target = leaf_hash(entry);

    // Build sorted leaves (same logic as `aggregate`).
    let mut leaves: Vec<[u8; 32]> = all_entries.iter().map(leaf_hash).collect();

    // Duplicate check.
    {
        let mut sorted_check = leaves.clone();
        sorted_check.sort_unstable();
        for w in sorted_check.windows(2) {
            if w[0] == w[1] {
                return Err(AggregateError::DuplicateReceipt);
            }
        }
    }

    leaves.sort_unstable();

    // Find target leaf position.
    let leaf_idx = leaves
        .iter()
        .position(|l| l == &target)
        .ok_or(AggregateError::ReceiptNotInAggregate)?;

    // Build Merkle path.
    let siblings = merkle_path(&leaves, leaf_idx);

    // Verify the rebuilt root matches the aggregate (sanity check).
    let rebuilt_merkle = recompute_merkle_root(&target, &siblings);
    let rebuilt_agg = compute_agg_root(agg.count, &rebuilt_merkle);
    if rebuilt_agg != agg.agg_root {
        return Err(AggregateError::ReceiptNotInAggregate);
    }

    Ok(MembershipProof {
        receipt_leaf: target,
        siblings,
        agg_root: agg.agg_root,
        count: agg.count,
        mainnet_ready: false,
    })
}

/// Verify a `MembershipProof` without access to any other receipt data.
///
/// Returns `true` iff the proof is internally consistent:
/// recomputing the Merkle root from the leaf + siblings, then wrapping with
/// `DOMAIN_AGG || count_le4`, yields `proof.agg_root`.
pub fn verify_membership(proof: &MembershipProof) -> bool {
    let merkle_root = recompute_merkle_root(&proof.receipt_leaf, &proof.siblings);
    let rebuilt_agg = compute_agg_root(proof.count, &merkle_root);
    rebuilt_agg == proof.agg_root
}

/// Serialise a `ReceiptAggregate` to a JSON string.
///
/// Only hashes (hex-encoded) and counts are included — no raw receipt bytes,
/// no slot values, no service identifiers.
pub fn aggregate_to_json(agg: &ReceiptAggregate) -> String {
    serde_json::json!({
        "agg_root":     hex_encode(&agg.agg_root),
        "merkle_root":  hex_encode(&agg.merkle_root),
        "count":        agg.count,
        "mainnet_ready": agg.mainnet_ready,
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Compute the leaf hash for a single `ReceiptEntry`.
///
/// `SHA256(DOMAIN_LEAF || receipt_hash_32 || service_hash_32 || slot_le8)`
fn leaf_hash(e: &ReceiptEntry) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([DOMAIN_LEAF]);
    h.update(e.receipt_hash);
    h.update(e.service_hash);
    h.update(e.slot.to_le_bytes());
    h.finalize().into()
}

/// Hash two child nodes together.
///
/// `SHA256(DOMAIN_NODE || left || right)`
fn node_hash(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([DOMAIN_NODE]);
    h.update(left);
    h.update(right);
    h.finalize().into()
}

/// Build the Merkle root over a pre-sorted, non-empty slice of leaf hashes.
///
/// Odd nodes are promoted by duplicating: the last node pairs with itself when
/// the layer has an odd count. This is a standard binary tree construction.
fn build_merkle_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    assert!(!leaves.is_empty(), "merkle root requires at least one leaf");

    if leaves.len() == 1 {
        return leaves[0];
    }

    let mut current: Vec<[u8; 32]> = leaves.to_vec();

    while current.len() > 1 {
        let mut next = Vec::with_capacity((current.len() + 1) / 2);
        let mut i = 0;
        while i < current.len() {
            let left = &current[i];
            let right = if i + 1 < current.len() {
                &current[i + 1]
            } else {
                // Odd node: pair with itself.
                &current[i]
            };
            next.push(node_hash(left, right));
            i += 2;
        }
        current = next;
    }

    current[0]
}

/// Compute the top-level aggregate root.
///
/// `SHA256(DOMAIN_AGG || count_le4 || merkle_root)`
fn compute_agg_root(count: u32, merkle_root: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([DOMAIN_AGG]);
    h.update(count.to_le_bytes());
    h.update(merkle_root);
    h.finalize().into()
}

/// Build the Merkle authentication path for the leaf at `leaf_idx` in the
/// sorted `leaves` slice.
///
/// Returns `Vec<(sibling_hash, is_right_sibling)>` ordered from leaf to root.
/// `is_right_sibling = true` means the sibling is to the right of the
/// current node at that level (i.e. current node is a left child).
fn merkle_path(leaves: &[[u8; 32]], leaf_idx: usize) -> Vec<([u8; 32], bool)> {
    let mut path = Vec::new();
    let mut current: Vec<[u8; 32]> = leaves.to_vec();
    let mut idx = leaf_idx;

    while current.len() > 1 {
        let sibling_idx = if idx % 2 == 0 {
            // Current node is a left child.
            if idx + 1 < current.len() {
                idx + 1
            } else {
                // Odd node promotes with itself.
                idx
            }
        } else {
            // Current node is a right child.
            idx - 1
        };

        let sibling = current[sibling_idx];
        // `is_right_sibling`: true when sibling is to the right of current.
        let is_right_sibling = sibling_idx > idx;
        path.push((sibling, is_right_sibling));

        // Build next layer.
        let mut next = Vec::with_capacity((current.len() + 1) / 2);
        let mut i = 0;
        while i < current.len() {
            let left = &current[i];
            let right = if i + 1 < current.len() {
                &current[i + 1]
            } else {
                &current[i]
            };
            next.push(node_hash(left, right));
            i += 2;
        }

        idx /= 2;
        current = next;
    }

    path
}

/// Recompute the Merkle root from a leaf hash and its authentication path.
fn recompute_merkle_root(leaf: &[u8; 32], siblings: &[([u8; 32], bool)]) -> [u8; 32] {
    let mut current = *leaf;
    for (sibling, is_right_sibling) in siblings {
        current = if *is_right_sibling {
            // current is left, sibling is right
            node_hash(&current, sibling)
        } else {
            // current is right, sibling is left
            node_hash(sibling, &current)
        };
    }
    current
}

/// Hex-encode a byte slice.
fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // Helper: build a zero-padded 32-byte array with a distinct byte at [0].
    fn h(seed: u8) -> [u8; 32] {
        let mut a = [0u8; 32];
        a[0] = seed;
        a
    }

    fn entry(receipt_seed: u8, service_seed: u8, slot: u64) -> ReceiptEntry {
        make_entry(&h(receipt_seed), &h(service_seed), slot)
    }

    // -----------------------------------------------------------------------
    // 1. make_entry always produces mainnet_ready = false
    // -----------------------------------------------------------------------
    #[test]
    fn test_make_entry_mainnet_ready_false() {
        let e = make_entry(&h(0x01), &h(0x02), 999);
        assert!(!e.mainnet_ready);
        assert_eq!(e.receipt_hash, h(0x01));
        assert_eq!(e.service_hash, h(0x02));
        assert_eq!(e.slot, 999);
    }

    // -----------------------------------------------------------------------
    // 2. aggregate with a single entry succeeds
    // -----------------------------------------------------------------------
    #[test]
    fn test_aggregate_single_entry() {
        let entries = [entry(0x11, 0xAA, 1)];
        let agg = aggregate(&entries).unwrap();
        assert_eq!(agg.count, 1);
        assert!(!agg.mainnet_ready);
        // merkle_root of a single leaf is the leaf itself
        assert_eq!(agg.merkle_root, leaf_hash(&entries[0]));
    }

    // -----------------------------------------------------------------------
    // 3. aggregate five distinct entries
    // -----------------------------------------------------------------------
    #[test]
    fn test_aggregate_five_entries() {
        let entries: Vec<_> = (1u8..=5).map(|i| entry(i, i + 0x10, i as u64)).collect();
        let agg = aggregate(&entries).unwrap();
        assert_eq!(agg.count, 5);
        assert_ne!(agg.agg_root, [0u8; 32]);
        assert_ne!(agg.merkle_root, [0u8; 32]);
        assert!(!agg.mainnet_ready);
    }

    // -----------------------------------------------------------------------
    // 4. empty slice is rejected
    // -----------------------------------------------------------------------
    #[test]
    fn test_aggregate_empty_rejected() {
        assert_eq!(aggregate(&[]), Err(AggregateError::EmptyReceipts));
    }

    // -----------------------------------------------------------------------
    // 5. duplicate entries (same leaf hash) are rejected
    // -----------------------------------------------------------------------
    #[test]
    fn test_aggregate_duplicate_rejected() {
        let e = entry(0x42, 0x99, 7);
        let entries = [e.clone(), e.clone()];
        assert_eq!(aggregate(&entries), Err(AggregateError::DuplicateReceipt));
    }

    // -----------------------------------------------------------------------
    // 6. changing one entry changes the aggregate root
    // -----------------------------------------------------------------------
    #[test]
    fn test_aggregate_root_changes_when_entry_changes() {
        let entries_a = [entry(0x01, 0x02, 10), entry(0x03, 0x04, 20)];
        let entries_b = [entry(0x01, 0x02, 10), entry(0x03, 0x04, 21)]; // slot changed
        let agg_a = aggregate(&entries_a).unwrap();
        let agg_b = aggregate(&entries_b).unwrap();
        assert_ne!(agg_a.agg_root, agg_b.agg_root);
    }

    // -----------------------------------------------------------------------
    // 7. same inputs always produce the same aggregate root (deterministic)
    // -----------------------------------------------------------------------
    #[test]
    fn test_aggregate_deterministic() {
        let entries: Vec<_> = (1u8..=4)
            .map(|i| entry(i, i + 0x20, i as u64 * 100))
            .collect();
        let agg1 = aggregate(&entries).unwrap();
        let agg2 = aggregate(&entries).unwrap();
        assert_eq!(agg1.agg_root, agg2.agg_root);
        assert_eq!(agg1.merkle_root, agg2.merkle_root);
    }

    // -----------------------------------------------------------------------
    // 8. prove_membership for a single entry
    // -----------------------------------------------------------------------
    #[test]
    fn test_prove_membership_single_entry() {
        let entries = [entry(0x55, 0x66, 5)];
        let agg = aggregate(&entries).unwrap();
        let proof = prove_membership(&agg, &entries[0], &entries).unwrap();
        assert_eq!(proof.receipt_leaf, leaf_hash(&entries[0]));
        assert!(proof.siblings.is_empty()); // single leaf → no siblings needed
        assert_eq!(proof.count, 1);
        assert!(!proof.mainnet_ready);
    }

    // -----------------------------------------------------------------------
    // 9. prove_membership works for each entry in a multi-entry aggregate
    // -----------------------------------------------------------------------
    #[test]
    fn test_prove_membership_multi_entry() {
        let entries: Vec<_> = (0u8..6).map(|i| entry(i + 1, i + 0x50, i as u64)).collect();
        let agg = aggregate(&entries).unwrap();
        for e in &entries {
            let proof = prove_membership(&agg, e, &entries).unwrap();
            assert_eq!(proof.agg_root, agg.agg_root);
        }
    }

    // -----------------------------------------------------------------------
    // 10. verify_membership returns true for a valid proof
    // -----------------------------------------------------------------------
    #[test]
    fn test_verify_membership_valid() {
        let entries: Vec<_> = (1u8..=8)
            .map(|i| entry(i, i + 0x40, i as u64 * 10))
            .collect();
        let agg = aggregate(&entries).unwrap();
        let proof = prove_membership(&agg, &entries[3], &entries).unwrap();
        assert!(verify_membership(&proof));
    }

    // -----------------------------------------------------------------------
    // 11. tampered leaf → verify_membership returns false
    // -----------------------------------------------------------------------
    #[test]
    fn test_verify_membership_wrong_leaf_fails() {
        let entries: Vec<_> = (1u8..=4).map(|i| entry(i, i + 0x30, i as u64)).collect();
        let agg = aggregate(&entries).unwrap();
        let mut proof = prove_membership(&agg, &entries[0], &entries).unwrap();
        // Flip one bit in the leaf hash.
        proof.receipt_leaf[0] ^= 0xFF;
        assert!(!verify_membership(&proof));
    }

    // -----------------------------------------------------------------------
    // 12. tampered agg_root → verify_membership returns false
    // -----------------------------------------------------------------------
    #[test]
    fn test_verify_membership_wrong_root_fails() {
        let entries: Vec<_> = (1u8..=4).map(|i| entry(i, i + 0x30, i as u64)).collect();
        let agg = aggregate(&entries).unwrap();
        let mut proof = prove_membership(&agg, &entries[1], &entries).unwrap();
        proof.agg_root[0] ^= 0xFF;
        assert!(!verify_membership(&proof));
    }

    // -----------------------------------------------------------------------
    // 13. entry not present in aggregate → ReceiptNotInAggregate
    // -----------------------------------------------------------------------
    #[test]
    fn test_entry_not_in_aggregate_rejected() {
        let entries: Vec<_> = (1u8..=3).map(|i| entry(i, i, i as u64)).collect();
        let agg = aggregate(&entries).unwrap();
        let outsider = entry(0xDE, 0xAD, 9999);
        assert_eq!(
            prove_membership(&agg, &outsider, &entries),
            Err(AggregateError::ReceiptNotInAggregate)
        );
    }

    // -----------------------------------------------------------------------
    // 14. aggregate_to_json must not contain raw slot values or receipt bytes
    // -----------------------------------------------------------------------
    #[test]
    fn test_aggregate_json_no_receipt_data_leak() {
        // Use recognisable slot and receipt byte patterns.
        let slot = 123456789u64;
        let receipt_byte = 0xCAu8;
        let entries = [make_entry(&[receipt_byte; 32], &h(0x01), slot)];
        let agg = aggregate(&entries).unwrap();
        let json = aggregate_to_json(&agg);

        // The JSON must not contain the raw slot number as a bare integer.
        let slot_str = slot.to_string();
        assert!(
            !json.contains(&slot_str),
            "JSON must not expose raw slot value, found {slot_str} in: {json}"
        );

        // The JSON must not contain the 32-byte receipt pattern as a raw
        // byte representation (e.g. "[202,202,...]" or "0xca" repeated).
        let receipt_hex_pattern: String = std::iter::repeat("ca").take(4).collect();
        // receipt_hex_pattern = "cacacaca" — check it's only present inside
        // a 64-char hex hash field, not as a standalone value.
        // The JSON keys we expect: agg_root, merkle_root, count, mainnet_ready.
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(parsed.get("agg_root").is_some());
        assert!(parsed.get("merkle_root").is_some());
        assert!(parsed.get("count").is_some());
        assert!(parsed.get("mainnet_ready").is_some());
        // No "slot" field allowed.
        assert!(
            parsed.get("slot").is_none(),
            "JSON must not expose slot field"
        );
        // No "receipt_hash" field allowed.
        assert!(
            parsed.get("receipt_hash").is_none(),
            "JSON must not expose receipt_hash field"
        );
        // The raw 64-char receipt hex "caca...ca" (32 bytes) must not appear
        // as a standalone JSON string value (it is hashed and unrecognisable).
        let raw_receipt_hex: String = std::iter::repeat("ca").take(32).collect();
        assert!(
            !json.contains(&raw_receipt_hex),
            "JSON must not contain raw receipt hex"
        );
        // Suppress unused-variable warning for helper.
        let _ = receipt_hex_pattern;
    }

    // -----------------------------------------------------------------------
    // 15. different slots produce different leaf hashes
    // -----------------------------------------------------------------------
    #[test]
    fn test_different_slots_different_leaves() {
        let rh = h(0x77);
        let sh = h(0x88);
        let e1 = make_entry(&rh, &sh, 100);
        let e2 = make_entry(&rh, &sh, 101);
        assert_ne!(leaf_hash(&e1), leaf_hash(&e2));
    }

    // -----------------------------------------------------------------------
    // 16. different service hashes produce different leaf hashes
    // -----------------------------------------------------------------------
    #[test]
    fn test_different_service_different_leaves() {
        let rh = h(0x33);
        let e1 = make_entry(&rh, &h(0xAA), 50);
        let e2 = make_entry(&rh, &h(0xBB), 50);
        assert_ne!(leaf_hash(&e1), leaf_hash(&e2));
    }
}
