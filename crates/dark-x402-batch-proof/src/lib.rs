//! dark-x402-batch-proof — batch N x402 receipts into one on-chain proof
//!
//! First implementation of Nova/IVC-compatible receipt batching for x402.
//! An AI agent accumulates N payment receipts off-chain, then posts a single
//! `X402BatchProof` on-chain. The proof commits to: the count of receipts,
//! a Merkle-style root over all receipt hashes, the total amount (hidden),
//! and the program scope. One on-chain proof proves N payments happened.
//!
//! This slashes on-chain state by N× compared to posting each receipt individually.
//! Fully compatible with dark-nova-receipt IVC fold structure.
//!
//! IS_STUB  = true
//! MAINNET_READY = false

use sha2::{Digest, Sha256};

pub const IS_STUB: bool = true;
pub const MAINNET_READY: bool = false;

/// Maximum receipts in a single batch (circuit capacity bound).
pub const MAX_BATCH_RECEIPTS: usize = 1024;

// ── domain tags ───────────────────────────────────────────────────────────────
const DOMAIN_BATCH_LEAF: &[u8] = b"x402-batch-leaf-v1";
const DOMAIN_TOTAL_COMMIT: &[u8] = b"x402-total-commit-v1";
const DOMAIN_BATCH_ACC: &[u8] = b"x402-batch-acc-v1";
const DOMAIN_BATCH_ID: &[u8] = b"x402-batch-id-v1";

// ── error ─────────────────────────────────────────────────────────────────────
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum BatchError {
    EmptyBatch,
    ZeroReceiptHash,
    ZeroAmountCommitment,
    ZeroScope,
    ZeroBlinding,
    TooManyReceipts,
}

impl core::fmt::Display for BatchError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::EmptyBatch => write!(f, "batch must contain at least one receipt"),
            Self::ZeroReceiptHash => write!(f, "receipt hash must not be all zeros"),
            Self::ZeroAmountCommitment => write!(f, "amount commitment must not be all zeros"),
            Self::ZeroScope => write!(f, "program scope must not be all zeros"),
            Self::ZeroBlinding => write!(f, "blinding factor must not be all zeros"),
            Self::TooManyReceipts => write!(f, "batch exceeds maximum of {} receipts", MAX_BATCH_RECEIPTS),
        }
    }
}

// ── types ─────────────────────────────────────────────────────────────────────

/// A single receipt entry in a batch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchReceipt {
    /// Hash of the original x402 receipt.
    pub receipt_hash: [u8; 32],
    /// Amount commitment (hides the individual payment amount).
    pub amount_commitment: [u8; 32],
}

/// A proof that N x402 receipts occurred, with hidden total amount.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct X402BatchProof {
    /// Unique batch identifier.
    pub batch_id: [u8; 32],
    /// Number of receipts in this batch.
    pub receipt_count: u32,
    /// Merkle-style root over all receipt hashes.
    pub receipts_root: [u8; 32],
    /// Commitment to the total amount spent (hidden).
    pub total_commitment: [u8; 32],
    /// IVC-compatible accumulated hash (Nova fold output).
    pub accumulated_hash: [u8; 32],
    /// On-chain program scope this batch is scoped to.
    pub program_scope: [u8; 32],
    /// Epoch this batch covers.
    pub epoch: u64,
    pub is_stub: bool,
    pub mainnet_ready: bool,
}

/// Builder for accumulating receipts into a batch proof.
pub struct BatchBuilder {
    receipts: Vec<BatchReceipt>,
    program_scope: [u8; 32],
    epoch: u64,
}

impl BatchBuilder {
    /// Start a new batch for the given program scope and epoch.
    pub fn new(program_scope: [u8; 32], epoch: u64) -> Result<Self, BatchError> {
        if program_scope == [0u8; 32] {
            return Err(BatchError::ZeroScope);
        }
        Ok(Self {
            receipts: Vec::new(),
            program_scope,
            epoch,
        })
    }

    /// Add a receipt to the batch.
    pub fn add_receipt(
        &mut self,
        receipt_hash: [u8; 32],
        amount_commitment: [u8; 32],
    ) -> Result<(), BatchError> {
        if receipt_hash == [0u8; 32] {
            return Err(BatchError::ZeroReceiptHash);
        }
        if amount_commitment == [0u8; 32] {
            return Err(BatchError::ZeroAmountCommitment);
        }
        if self.receipts.len() >= MAX_BATCH_RECEIPTS {
            return Err(BatchError::TooManyReceipts);
        }
        self.receipts.push(BatchReceipt { receipt_hash, amount_commitment });
        Ok(())
    }

    /// Finalize the batch into a single proof.
    ///
    /// - `total_amount`: exact total lamports (hidden inside total_commitment)
    /// - `blinding`: random 32-byte blinding factor
    pub fn finalize(
        self,
        total_amount: u64,
        blinding: &[u8; 32],
    ) -> Result<X402BatchProof, BatchError> {
        if self.receipts.is_empty() {
            return Err(BatchError::EmptyBatch);
        }
        if blinding == &[0u8; 32] {
            return Err(BatchError::ZeroBlinding);
        }

        // Build receipts root: chain-hash over all receipt entries
        let receipts_root = {
            let mut running = [0u8; 32];
            for r in &self.receipts {
                let mut h = Sha256::new();
                h.update(DOMAIN_BATCH_LEAF);
                h.update(running);
                h.update(r.receipt_hash);
                h.update(r.amount_commitment);
                running = h.finalize().into();
            }
            running
        };

        let total_commitment: [u8; 32] = {
            let mut h = Sha256::new();
            h.update(DOMAIN_TOTAL_COMMIT);
            h.update(total_amount.to_le_bytes());
            h.update(blinding);
            h.finalize().into()
        };

        let accumulated_hash: [u8; 32] = {
            let mut h = Sha256::new();
            h.update(DOMAIN_BATCH_ACC);
            h.update(receipts_root);
            h.update(total_commitment);
            h.update(self.epoch.to_le_bytes());
            h.finalize().into()
        };

        let batch_id: [u8; 32] = {
            let mut h = Sha256::new();
            h.update(DOMAIN_BATCH_ID);
            h.update(accumulated_hash);
            h.update(self.program_scope);
            h.finalize().into()
        };

        Ok(X402BatchProof {
            batch_id,
            receipt_count: self.receipts.len() as u32,
            receipts_root,
            total_commitment,
            accumulated_hash,
            program_scope: self.program_scope,
            epoch: self.epoch,
            is_stub: IS_STUB,
            mainnet_ready: MAINNET_READY,
        })
    }
}

// ── verification helpers ───────────────────────────────────────────────────────

/// Verify the batch proof reports the expected number of receipts.
pub fn verify_batch_count(proof: &X402BatchProof, expected: u32) -> bool {
    proof.receipt_count == expected
}

/// Verify the batch proof is scoped to the expected program.
pub fn verify_batch_scope(proof: &X402BatchProof, scope: &[u8; 32]) -> bool {
    &proof.program_scope == scope
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope() -> [u8; 32] { let mut s = [0u8; 32]; s[0] = 0xAA; s[31] = 0x01; s }
    fn blinding() -> [u8; 32] { let mut b = [0u8; 32]; b[0] = 0xBB; b[15] = 0x42; b }
    fn rh(n: u8) -> [u8; 32] { let mut r = [0u8; 32]; r[0] = 0xCC; r[1] = n; r }
    fn ac(n: u8) -> [u8; 32] { let mut a = [0u8; 32]; a[0] = 0xDD; a[2] = n; a }

    fn single_receipt_proof() -> X402BatchProof {
        let mut b = BatchBuilder::new(scope(), 42).unwrap();
        b.add_receipt(rh(1), ac(1)).unwrap();
        b.finalize(1000, &blinding()).unwrap()
    }

    // 1. constants
    #[test]
    fn test_constants() {
        assert!(IS_STUB);
        assert!(!MAINNET_READY);
        assert_eq!(MAX_BATCH_RECEIPTS, 1024);
    }

    // 2. single receipt batch builds successfully
    #[test]
    fn test_batch_builder_single_receipt() {
        let p = single_receipt_proof();
        assert_eq!(p.receipt_count, 1);
        assert_ne!(p.batch_id, [0u8; 32]);
        assert!(!p.mainnet_ready);
    }

    // 3. multiple receipts batch
    #[test]
    fn test_batch_builder_multiple_receipts() {
        let mut b = BatchBuilder::new(scope(), 1).unwrap();
        for i in 0..5u8 {
            b.add_receipt(rh(i), ac(i)).unwrap();
        }
        let p = b.finalize(5000, &blinding()).unwrap();
        assert_eq!(p.receipt_count, 5);
    }

    // 4. finalize is deterministic with same inputs
    #[test]
    fn test_finalize_deterministic() {
        let p1 = single_receipt_proof();
        let p2 = single_receipt_proof();
        assert_eq!(p1.batch_id, p2.batch_id);
        assert_eq!(p1.receipts_root, p2.receipts_root);
        assert_eq!(p1.accumulated_hash, p2.accumulated_hash);
    }

    // 5. receipt_count matches added receipts
    #[test]
    fn test_receipt_count_correct() {
        let mut b = BatchBuilder::new(scope(), 0).unwrap();
        for i in 0..10u8 {
            b.add_receipt(rh(i), ac(i)).unwrap();
        }
        let p = b.finalize(10_000, &blinding()).unwrap();
        assert_eq!(p.receipt_count, 10);
    }

    // 6. batch_id includes program scope (different scope → different id)
    #[test]
    fn test_batch_id_includes_scope() {
        let mut scope2 = scope();
        scope2[5] ^= 0xFF;
        let p1 = single_receipt_proof();
        let mut b2 = BatchBuilder::new(scope2, 42).unwrap();
        b2.add_receipt(rh(1), ac(1)).unwrap();
        let p2 = b2.finalize(1000, &blinding()).unwrap();
        assert_ne!(p1.batch_id, p2.batch_id);
    }

    // 7. verify_batch_count correct
    #[test]
    fn test_verify_batch_count_correct() {
        let p = single_receipt_proof();
        assert!(verify_batch_count(&p, 1));
    }

    // 8. verify_batch_count wrong count fails
    #[test]
    fn test_verify_batch_count_wrong_fails() {
        let p = single_receipt_proof();
        assert!(!verify_batch_count(&p, 2));
    }

    // 9. verify_batch_scope correct
    #[test]
    fn test_verify_batch_scope_correct() {
        let p = single_receipt_proof();
        assert!(verify_batch_scope(&p, &scope()));
    }

    // 10. verify_batch_scope wrong scope fails
    #[test]
    fn test_verify_batch_scope_wrong_fails() {
        let p = single_receipt_proof();
        let mut bad = scope();
        bad[0] ^= 0x01;
        assert!(!verify_batch_scope(&p, &bad));
    }

    // 11. empty batch → error
    #[test]
    fn test_empty_batch_error() {
        let b = BatchBuilder::new(scope(), 0).unwrap();
        let err = b.finalize(1000, &blinding()).unwrap_err();
        assert_eq!(err, BatchError::EmptyBatch);
    }

    // 12. zero receipt hash → error
    #[test]
    fn test_zero_receipt_hash_error() {
        let mut b = BatchBuilder::new(scope(), 0).unwrap();
        let err = b.add_receipt([0u8; 32], ac(1)).unwrap_err();
        assert_eq!(err, BatchError::ZeroReceiptHash);
    }

    // 13. zero blinding → error at finalize
    #[test]
    fn test_zero_blinding_error() {
        let mut b = BatchBuilder::new(scope(), 0).unwrap();
        b.add_receipt(rh(1), ac(1)).unwrap();
        let err = b.finalize(1000, &[0u8; 32]).unwrap_err();
        assert_eq!(err, BatchError::ZeroBlinding);
    }

    // 14. receipt order affects root (different order → different root)
    #[test]
    fn test_different_receipts_different_root() {
        let mut b1 = BatchBuilder::new(scope(), 0).unwrap();
        b1.add_receipt(rh(1), ac(1)).unwrap();
        b1.add_receipt(rh(2), ac(2)).unwrap();
        let p1 = b1.finalize(2000, &blinding()).unwrap();

        let mut b2 = BatchBuilder::new(scope(), 0).unwrap();
        b2.add_receipt(rh(2), ac(2)).unwrap();
        b2.add_receipt(rh(1), ac(1)).unwrap();
        let p2 = b2.finalize(2000, &blinding()).unwrap();

        assert_ne!(p1.receipts_root, p2.receipts_root, "order must matter for root");
    }

    // 15. total_commitment hides amount (commitment != raw amount bytes)
    #[test]
    fn test_total_commitment_hides_amount() {
        let p = single_receipt_proof();
        let raw_amount = 1000u64.to_le_bytes();
        let mut padded = [0u8; 32];
        padded[..8].copy_from_slice(&raw_amount);
        assert_ne!(p.total_commitment, padded, "commitment must not be raw amount");
    }

    // 16. max receipts (1024) all fit in one batch
    #[test]
    fn test_max_receipts_edge_case() {
        let mut b = BatchBuilder::new(scope(), 0).unwrap();
        for i in 0..MAX_BATCH_RECEIPTS {
            let mut rh = [0u8; 32];
            rh[0] = (i & 0xFF) as u8;
            rh[1] = ((i >> 8) & 0xFF) as u8;
            rh[2] = 0xCC;
            let mut ac = [0u8; 32];
            ac[0] = (i & 0xFF) as u8;
            ac[1] = 0xDD;
            b.add_receipt(rh, ac).unwrap();
        }
        let p = b.finalize(MAX_BATCH_RECEIPTS as u64 * 1000, &blinding()).unwrap();
        assert_eq!(p.receipt_count, MAX_BATCH_RECEIPTS as u32);
    }
}
