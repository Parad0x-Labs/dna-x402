use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ReceiptLeafInput {
    pub leaf_hash: [u8; 32],
    pub is_poison: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DarkBatchInput {
    pub receipt_leaves: Vec<ReceiptLeafInput>,
    pub nullifiers: Vec<[u8; 32]>,
    pub session_spends: Vec<u64>,
    pub starting_balance_commitment: [u8; 32],
    pub ending_balance_commitment: [u8; 32],
    pub macaroon_caveat_hash: [u8; 32],
    pub model_output_hashes: Vec<[u8; 32]>,
    pub budget_lamports: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DarkBatchPublicOutput {
    pub batch_hash: [u8; 32],
    pub no_duplicate_nullifiers: bool,
    pub receipt_root: [u8; 32],
    pub net_settlement_hash: [u8; 32],
    pub caveat_hash: [u8; 32],
    pub model_output_root: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuditError {
    DuplicateNullifier([u8; 32]),
    BrokenReceiptRoot,
    OverBudget { spent: u64, budget: u64 },
    PoisonLeafInRedeemSet([u8; 32]),
    EmptyBatch,
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/// Returns the first duplicate nullifier found, or None if all are unique.
pub fn has_duplicate_nullifier(nullifiers: &[[u8; 32]]) -> Option<[u8; 32]> {
    let mut seen: std::collections::HashSet<[u8; 32]> = std::collections::HashSet::new();
    for &n in nullifiers {
        if !seen.insert(n) {
            return Some(n);
        }
    }
    None
}

/// Compute a Merkle root from a slice of 32-byte leaves using SHA-256 with
/// a domain-prefix at every interior node.
///
/// - Empty slice  → `[0u8; 32]`
/// - Single leaf  → the leaf itself (no hashing)
/// - Odd layer    → last leaf is duplicated to form a pair
pub fn merkle_root_from_leaves(leaves: &[[u8; 32]], domain: &[u8]) -> [u8; 32] {
    if leaves.is_empty() {
        return [0u8; 32];
    }
    if leaves.len() == 1 {
        return leaves[0];
    }
    let mut layer = leaves.to_vec();
    while layer.len() > 1 {
        let mut next: Vec<[u8; 32]> = Vec::new();
        let mut i = 0;
        while i < layer.len() {
            let left = layer[i];
            let right = if i + 1 < layer.len() {
                layer[i + 1]
            } else {
                layer[i] // duplicate last leaf for odd count
            };
            let mut h = Sha256::new();
            h.update(domain);
            h.update(left);
            h.update(right);
            next.push(h.finalize().into());
            i += 2;
        }
        layer = next;
    }
    layer[0]
}

/// Recompute the batch_hash from a `DarkBatchPublicOutput` (verify consistency).
pub fn compute_batch_hash(output: &DarkBatchPublicOutput) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"dark_null_v1_batch");
    h.update(output.receipt_root);
    h.update(output.net_settlement_hash);
    h.update(output.caveat_hash);
    h.finalize().into()
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/// Audit a batch of receipts and return a public output commitment, or an
/// error describing why the batch is invalid.
pub fn audit_batch(input: &DarkBatchInput) -> Result<DarkBatchPublicOutput, AuditError> {
    // 1. Reject empty batches
    if input.receipt_leaves.is_empty()
        && input.nullifiers.is_empty()
        && input.session_spends.is_empty()
        && input.model_output_hashes.is_empty()
    {
        return Err(AuditError::EmptyBatch);
    }

    // 2. Duplicate nullifier check
    if let Some(dup) = has_duplicate_nullifier(&input.nullifiers) {
        return Err(AuditError::DuplicateNullifier(dup));
    }

    // 3. Receipt root (non-poison leaves only).
    //    A poison leaf must NOT appear in the nullifier set (redeemable set).
    let poison_hashes: std::collections::HashSet<[u8; 32]> = input
        .receipt_leaves
        .iter()
        .filter(|l| l.is_poison)
        .map(|l| l.leaf_hash)
        .collect();

    for &n in &input.nullifiers {
        if poison_hashes.contains(&n) {
            return Err(AuditError::PoisonLeafInRedeemSet(n));
        }
    }

    let real_leaves: Vec<[u8; 32]> = input
        .receipt_leaves
        .iter()
        .filter(|l| !l.is_poison)
        .map(|l| l.leaf_hash)
        .collect();

    let receipt_root = merkle_root_from_leaves(&real_leaves, b"dark_null_v1_receipt_node");

    // 4. Budget check
    let total_spent: u64 = input.session_spends.iter().copied().sum();
    if total_spent > input.budget_lamports {
        return Err(AuditError::OverBudget {
            spent: total_spent,
            budget: input.budget_lamports,
        });
    }

    // 5. Net settlement hash
    let mut net_h = Sha256::new();
    net_h.update(b"dark_null_v1_net");
    net_h.update(total_spent.to_le_bytes());
    net_h.update(input.starting_balance_commitment);
    let net_settlement_hash: [u8; 32] = net_h.finalize().into();

    // 6. Model output root
    let model_output_root =
        merkle_root_from_leaves(&input.model_output_hashes, b"dark_null_v1_receipt_node");

    // 7. Batch hash
    let caveat_hash = input.macaroon_caveat_hash;
    let mut batch_h = Sha256::new();
    batch_h.update(b"dark_null_v1_batch");
    batch_h.update(receipt_root);
    batch_h.update(net_settlement_hash);
    batch_h.update(caveat_hash);
    let batch_hash: [u8; 32] = batch_h.finalize().into();

    Ok(DarkBatchPublicOutput {
        batch_hash,
        no_duplicate_nullifiers: true,
        receipt_root,
        net_settlement_hash,
        caveat_hash,
        model_output_root,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_leaf(byte: u8, poison: bool) -> ReceiptLeafInput {
        ReceiptLeafInput {
            leaf_hash: [byte; 32],
            is_poison: poison,
        }
    }

    fn minimal_valid_input() -> DarkBatchInput {
        DarkBatchInput {
            receipt_leaves: vec![make_leaf(1, false)],
            nullifiers: vec![[1u8; 32]],
            session_spends: vec![100],
            starting_balance_commitment: [0u8; 32],
            ending_balance_commitment: [0u8; 32],
            macaroon_caveat_hash: [42u8; 32],
            model_output_hashes: vec![[9u8; 32]],
            budget_lamports: 1000,
        }
    }

    // 1. A well-formed batch is accepted and produces a deterministic output.
    #[test]
    fn test_valid_batch_accepted() {
        let input = minimal_valid_input();
        let result = audit_batch(&input);
        assert!(result.is_ok(), "expected Ok, got {:?}", result);
        let out = result.unwrap();
        assert!(out.no_duplicate_nullifiers);
        assert_ne!(out.batch_hash, [0u8; 32]);
        // Recomputing the batch hash must match
        assert_eq!(compute_batch_hash(&out), out.batch_hash);
    }

    // 2. Duplicate nullifier is detected and rejected with the correct error.
    #[test]
    fn test_duplicate_nullifier_rejected() {
        let mut input = minimal_valid_input();
        input.nullifiers = vec![[7u8; 32], [7u8; 32]];
        match audit_batch(&input) {
            Err(AuditError::DuplicateNullifier(n)) => assert_eq!(n, [7u8; 32]),
            other => panic!("expected DuplicateNullifier, got {:?}", other),
        }
    }

    // 3. Mutating a receipt leaf changes batch_hash, exposing broken root.
    #[test]
    fn test_broken_receipt_root_detected() {
        let input = minimal_valid_input();
        let out1 = audit_batch(&input).unwrap();

        let mut input2 = input;
        input2.receipt_leaves[0].leaf_hash = [0xFFu8; 32];
        let out2 = audit_batch(&input2).unwrap();

        assert_ne!(out1.receipt_root, out2.receipt_root);
        assert_ne!(out1.batch_hash, out2.batch_hash);
    }

    // 4. Spending over budget is rejected.
    #[test]
    fn test_overspend_rejected() {
        let mut input = minimal_valid_input();
        input.session_spends = vec![500, 600]; // 1100 > 1000
        input.budget_lamports = 1000;
        match audit_batch(&input) {
            Err(AuditError::OverBudget {
                spent: 1100,
                budget: 1000,
            }) => {}
            other => panic!("expected OverBudget, got {:?}", other),
        }
    }

    // 5. Poison leaf is excluded from receipt root; root equals single-real-leaf root.
    #[test]
    fn test_poison_leaf_excluded_from_root() {
        let real_leaf = make_leaf(0xAA, false);
        let poison_leaf = make_leaf(0xBB, true);

        // Batch with both leaves (nullifier set uses only the real leaf hash)
        let input_with_poison = DarkBatchInput {
            receipt_leaves: vec![real_leaf.clone(), poison_leaf],
            nullifiers: vec![[0xAAu8; 32]],
            session_spends: vec![1],
            starting_balance_commitment: [0u8; 32],
            ending_balance_commitment: [0u8; 32],
            macaroon_caveat_hash: [0u8; 32],
            model_output_hashes: vec![[0u8; 32]],
            budget_lamports: 100,
        };

        // Batch with only the real leaf
        let input_real_only = DarkBatchInput {
            receipt_leaves: vec![real_leaf],
            nullifiers: vec![[0xAAu8; 32]],
            session_spends: vec![1],
            starting_balance_commitment: [0u8; 32],
            ending_balance_commitment: [0u8; 32],
            macaroon_caveat_hash: [0u8; 32],
            model_output_hashes: vec![[0u8; 32]],
            budget_lamports: 100,
        };

        let out_poison = audit_batch(&input_with_poison).unwrap();
        let out_real = audit_batch(&input_real_only).unwrap();

        assert_eq!(
            out_poison.receipt_root, out_real.receipt_root,
            "poison leaf must not affect receipt root"
        );
    }

    // 6. Mutating a model output hash changes model_output_root.
    #[test]
    fn test_model_output_root_changes_on_tamper() {
        let input = minimal_valid_input();
        let out1 = audit_batch(&input).unwrap();

        let mut input2 = input;
        input2.model_output_hashes[0] = [0xDEu8; 32];
        let out2 = audit_batch(&input2).unwrap();

        assert_ne!(out1.model_output_root, out2.model_output_root);
    }

    // 7. Single-leaf Merkle root is the leaf itself.
    #[test]
    fn test_merkle_root_single_leaf() {
        let leaf = [0x55u8; 32];
        let root = merkle_root_from_leaves(&[leaf], b"any_domain");
        assert_eq!(root, leaf);
    }

    // 8. Empty Merkle root is all-zeros.
    #[test]
    fn test_merkle_root_empty() {
        let root = merkle_root_from_leaves(&[], b"any_domain");
        assert_eq!(root, [0u8; 32]);
    }

    // 9. Net settlement hash is deterministic for same inputs.
    #[test]
    fn test_net_settlement_hash_deterministic() {
        let input = minimal_valid_input();
        let out1 = audit_batch(&input).unwrap();
        let out2 = audit_batch(&input).unwrap();
        assert_eq!(out1.net_settlement_hash, out2.net_settlement_hash);
        assert_ne!(out1.net_settlement_hash, [0u8; 32]);
    }

    // 10. Changing the caveat hash changes batch_hash.
    #[test]
    fn test_batch_hash_changes_on_caveat_tamper() {
        let input = minimal_valid_input();
        let out1 = audit_batch(&input).unwrap();

        let mut input2 = input;
        input2.macaroon_caveat_hash = [0xFFu8; 32];
        let out2 = audit_batch(&input2).unwrap();

        assert_ne!(out1.caveat_hash, out2.caveat_hash);
        assert_ne!(out1.batch_hash, out2.batch_hash);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_merkle_root_two_leaves_not_equal_to_either() {
        let l1 = [0x11u8; 32];
        let l2 = [0x22u8; 32];
        let root = merkle_root_from_leaves(&[l1, l2], b"domain");
        assert_ne!(root, l1);
        assert_ne!(root, l2);
    }

    #[test]
    fn test_has_duplicate_nullifier_none() {
        let nullifiers = vec![[0x01u8; 32], [0x02u8; 32], [0x03u8; 32]];
        assert!(has_duplicate_nullifier(&nullifiers).is_none());
    }

    #[test]
    fn test_has_duplicate_nullifier_found() {
        let dup = [0xABu8; 32];
        let nullifiers = vec![[0x01u8; 32], dup, [0x02u8; 32], dup];
        assert_eq!(has_duplicate_nullifier(&nullifiers), Some(dup));
    }

    #[test]
    fn test_empty_batch_rejected() {
        let empty = DarkBatchInput {
            receipt_leaves: vec![],
            nullifiers: vec![],
            session_spends: vec![],
            starting_balance_commitment: [0u8; 32],
            ending_balance_commitment: [0u8; 32],
            macaroon_caveat_hash: [0u8; 32],
            model_output_hashes: vec![],
            budget_lamports: 1000,
        };
        assert!(matches!(audit_batch(&empty), Err(AuditError::EmptyBatch)));
    }

    #[test]
    fn test_poison_leaf_in_redeem_set_rejected() {
        let poison_hash = [0xBBu8; 32];
        let input = DarkBatchInput {
            receipt_leaves: vec![
                make_leaf(0xAA, false),
                ReceiptLeafInput {
                    leaf_hash: poison_hash,
                    is_poison: true,
                },
            ],
            nullifiers: vec![poison_hash], // trying to redeem a poison leaf
            session_spends: vec![1],
            starting_balance_commitment: [0u8; 32],
            ending_balance_commitment: [0u8; 32],
            macaroon_caveat_hash: [0u8; 32],
            model_output_hashes: vec![[0u8; 32]],
            budget_lamports: 100,
        };
        assert!(matches!(
            audit_batch(&input),
            Err(AuditError::PoisonLeafInRedeemSet(_))
        ));
    }

    #[test]
    fn test_batch_hash_deterministic() {
        let input = minimal_valid_input();
        let out1 = audit_batch(&input).unwrap();
        let out2 = audit_batch(&input).unwrap();
        assert_eq!(out1.batch_hash, out2.batch_hash);
    }
}
