//! Shape Pool — ALT shape mixer for transaction camouflage.
//!
//! k-shape anonymity: number of transactions sharing the same account/compute
//! pattern. Higher k = harder chain analysis.
//!
//! How it works:
//! 1. Each "action class" has a canonical TxShape (account counts, CU budget).
//! 2. All transactions in a pool must conform to their assigned shape.
//! 3. An analyst cannot distinguish ReceiptSpend from ChaffClose if both
//!    produce the same account fingerprint.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use solana_sdk::pubkey::Pubkey;

/// Canonical shape of a transaction (account-count fingerprint).
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TxShape {
    pub num_writable_signers: u8,
    pub num_readonly_signers: u8,
    pub num_writable_unsigned: u8,
    pub num_readonly_unsigned: u8,
    pub instruction_count: u8,
    pub target_compute_units: u32,
}

impl TxShape {
    /// Total number of accounts referenced by this shape.
    pub fn total_accounts(&self) -> u8 {
        self.num_writable_signers
            + self.num_readonly_signers
            + self.num_writable_unsigned
            + self.num_readonly_unsigned
    }
}

/// Named pool of shapes for different action classes.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ShapeClass {
    ReceiptSpend,
    ChaffClose,
    QuoteSettle,
    NullifierInsert,
    Custom(u8),
}

/// Assign a canonical TxShape to a shape class.
pub fn canonical_shape(class: &ShapeClass) -> TxShape {
    match class {
        ShapeClass::ReceiptSpend => TxShape {
            num_writable_signers: 1,
            num_readonly_signers: 0,
            num_writable_unsigned: 3,
            num_readonly_unsigned: 1,
            instruction_count: 1,
            target_compute_units: 50_000,
        },
        ShapeClass::ChaffClose => TxShape {
            num_writable_signers: 1,
            num_readonly_signers: 0,
            num_writable_unsigned: 3,
            num_readonly_unsigned: 1,
            instruction_count: 1,
            target_compute_units: 50_000,
        },
        ShapeClass::QuoteSettle => TxShape {
            num_writable_signers: 1,
            num_readonly_signers: 1,
            num_writable_unsigned: 2,
            num_readonly_unsigned: 2,
            instruction_count: 2,
            target_compute_units: 100_000,
        },
        ShapeClass::NullifierInsert => TxShape {
            num_writable_signers: 1,
            num_readonly_signers: 0,
            num_writable_unsigned: 2,
            num_readonly_unsigned: 1,
            instruction_count: 1,
            target_compute_units: 30_000,
        },
        ShapeClass::Custom(n) => TxShape {
            num_writable_signers: 1,
            num_readonly_signers: 0,
            num_writable_unsigned: *n as u8,
            num_readonly_unsigned: 0,
            instruction_count: 1,
            target_compute_units: 50_000,
        },
    }
}

/// Compute a fingerprint hash for a set of account keys (ordering matters).
pub fn account_fingerprint(accounts: &[Pubkey]) -> [u8; 32] {
    let mut h = Sha256::new();
    for k in accounts {
        h.update(k.as_ref());
    }
    h.finalize().into()
}

/// k-anonymity score: how many shapes in a pool share the same TxShape.
pub fn k_anonymity(pool: &[ShapeClass]) -> usize {
    if pool.is_empty() {
        return 0;
    }
    let reference = canonical_shape(&pool[0]);
    pool.iter()
        .filter(|c| canonical_shape(c) == reference)
        .count()
}

/// Check if two shape classes are indistinguishable (same canonical shape).
pub fn is_indistinguishable(a: &ShapeClass, b: &ShapeClass) -> bool {
    canonical_shape(a) == canonical_shape(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_receipt_spend_and_chaff_close_indistinguishable() {
        assert!(is_indistinguishable(
            &ShapeClass::ReceiptSpend,
            &ShapeClass::ChaffClose
        ));
    }

    #[test]
    fn test_quote_settle_distinguishable_from_receipt_spend() {
        assert!(!is_indistinguishable(
            &ShapeClass::QuoteSettle,
            &ShapeClass::ReceiptSpend
        ));
    }

    #[test]
    fn test_total_accounts_correct() {
        let shape = canonical_shape(&ShapeClass::QuoteSettle);
        // 1 writable_signer + 1 readonly_signer + 2 writable_unsigned + 2 readonly_unsigned = 6
        assert_eq!(shape.total_accounts(), 6);

        let shape2 = canonical_shape(&ShapeClass::ReceiptSpend);
        // 1 + 0 + 3 + 1 = 5
        assert_eq!(shape2.total_accounts(), 5);
    }

    #[test]
    fn test_k_anonymity_pool() {
        // ReceiptSpend and ChaffClose share the same shape; QuoteSettle does not
        let pool = vec![
            ShapeClass::ReceiptSpend,
            ShapeClass::ChaffClose,
            ShapeClass::ReceiptSpend,
            ShapeClass::QuoteSettle,
        ];
        // k_anonymity counts how many share the shape of pool[0] (ReceiptSpend)
        // pool[0]=ReceiptSpend, pool[1]=ChaffClose (same shape), pool[2]=ReceiptSpend (same), pool[3]=QuoteSettle (different)
        assert_eq!(k_anonymity(&pool), 3);
    }

    #[test]
    fn test_account_fingerprint_deterministic() {
        let keys = vec![Pubkey::new_unique(), Pubkey::new_unique()];
        let fp1 = account_fingerprint(&keys);
        let fp2 = account_fingerprint(&keys);
        assert_eq!(fp1, fp2);
    }

    #[test]
    fn test_account_fingerprint_order_sensitive() {
        let k1 = Pubkey::new_unique();
        let k2 = Pubkey::new_unique();
        let fp_ab = account_fingerprint(&[k1, k2]);
        let fp_ba = account_fingerprint(&[k2, k1]);
        assert_ne!(fp_ab, fp_ba);
    }

    #[test]
    fn test_json_roundtrip() {
        let shape = canonical_shape(&ShapeClass::NullifierInsert);
        let json = serde_json::to_string(&shape).unwrap();
        let decoded: TxShape = serde_json::from_str(&json).unwrap();
        assert_eq!(shape, decoded);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_fingerprint_nonzero_single_key() {
        let key = Pubkey::new_unique();
        assert_ne!(account_fingerprint(&[key]), [0u8; 32]);
    }

    #[test]
    fn test_empty_pool_k_anonymity_zero() {
        assert_eq!(k_anonymity(&[]), 0);
    }

    #[test]
    fn test_k_anonymity_all_same_shape() {
        let pool = vec![
            ShapeClass::ReceiptSpend,
            ShapeClass::ReceiptSpend,
            ShapeClass::ReceiptSpend,
            ShapeClass::ReceiptSpend,
        ];
        assert_eq!(k_anonymity(&pool), 4);
    }

    #[test]
    fn test_nullifier_insert_cu_thirty_k() {
        let shape = canonical_shape(&ShapeClass::NullifierInsert);
        assert_eq!(shape.target_compute_units, 30_000);
    }

    #[test]
    fn test_custom_shape_writable_count() {
        let shape = canonical_shape(&ShapeClass::Custom(7));
        assert_eq!(shape.num_writable_unsigned, 7);
    }

    #[test]
    fn test_is_indistinguishable_reflexive() {
        // Every class is indistinguishable from itself
        for class in &[
            ShapeClass::ReceiptSpend,
            ShapeClass::QuoteSettle,
            ShapeClass::NullifierInsert,
        ] {
            assert!(is_indistinguishable(class, class));
        }
    }

    #[test]
    fn test_chaff_close_receipt_spend_same_cu() {
        let s1 = canonical_shape(&ShapeClass::ReceiptSpend);
        let s2 = canonical_shape(&ShapeClass::ChaffClose);
        assert_eq!(s1.target_compute_units, s2.target_compute_units);
    }

    #[test]
    fn test_k_anonymity_single_element() {
        let pool = vec![ShapeClass::QuoteSettle];
        assert_eq!(k_anonymity(&pool), 1);
    }

    #[test]
    fn test_fingerprint_empty_input_deterministic() {
        let fp1 = account_fingerprint(&[]);
        let fp2 = account_fingerprint(&[]);
        assert_eq!(fp1, fp2);
    }
}
