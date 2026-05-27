//! Amount-hiding receipt schema for Dark Null.
//!
//! Proves a payment occurred with a **private amount and recipient** without
//! requiring an anonymity mixing pool. The payer commits to the amount with a
//! blinding factor; only they can open the commitment. The nullifier is
//! program-scoped — the same spending key cannot produce the same nullifier
//! across different programs.
//!
//! This is the core x402 receipt privacy primitive: zero competitors on Solana.
//!
//! `IS_STUB = true`, `MAINNET_READY = false`.

use sha2::{Digest, Sha256};

pub const IS_STUB: bool = true;
pub const MAINNET_READY: bool = false;
/// Domain tag for amount commitments.
pub const DOMAIN_AMOUNT: &[u8] = b"dark-amount-commit-v1";
/// Domain tag for recipient commitments.
pub const DOMAIN_RECIPIENT: &[u8] = b"dark-recipient-commit-v1";
/// Domain tag for nullifier derivation.
pub const DOMAIN_NULLIFIER: &[u8] = b"dark-nullifier-v1";
/// Domain tag for receipt ID derivation.
pub const DOMAIN_RECEIPT_ID: &[u8] = b"dark-receipt-id-v1";

#[derive(Debug, Clone)]
pub struct AmountReceipt {
    /// Unique receipt identifier.
    pub receipt_id: [u8; 32],
    /// Pedersen-style commitment to the amount: H(DOMAIN_AMOUNT || amount_le || blinding).
    pub amount_commitment: [u8; 32],
    /// Commitment to the recipient: H(DOMAIN_RECIPIENT || recipient || blinding).
    pub recipient_commitment: [u8; 32],
    /// Program-scoped nullifier: H(DOMAIN_NULLIFIER || spending_key || program_id || epoch).
    pub nullifier: [u8; 32],
    /// The program that received the payment (public).
    pub program_id: [u8; 32],
    /// Epoch of the payment.
    pub epoch: u64,
    pub is_stub: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum AmountReceiptError {
    /// `spending_key` is all zeros.
    ZeroSpendingKey,
    /// Either `amount_blinding` or `recipient_blinding` is all zeros.
    ZeroBlinding,
    /// `recipient` is all zeros.
    ZeroRecipient,
    /// `amount` is zero (must be at least 1 lamport).
    ZeroAmount,
    /// `program_id` is all zeros.
    ZeroProgramId,
}

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// Create an amount-hiding receipt.
pub fn create_amount_receipt(
    spending_key: &[u8; 32],
    amount: u64,
    amount_blinding: &[u8; 32],
    recipient: &[u8; 32],
    recipient_blinding: &[u8; 32],
    program_id: &[u8; 32],
    epoch: u64,
) -> Result<AmountReceipt, AmountReceiptError> {
    if spending_key == &[0u8; 32] {
        return Err(AmountReceiptError::ZeroSpendingKey);
    }
    if amount_blinding == &[0u8; 32] || recipient_blinding == &[0u8; 32] {
        return Err(AmountReceiptError::ZeroBlinding);
    }
    if recipient == &[0u8; 32] {
        return Err(AmountReceiptError::ZeroRecipient);
    }
    if amount == 0 {
        return Err(AmountReceiptError::ZeroAmount);
    }
    if program_id == &[0u8; 32] {
        return Err(AmountReceiptError::ZeroProgramId);
    }

    let amount_commitment =
        sha256_multi(&[DOMAIN_AMOUNT, &amount.to_le_bytes(), amount_blinding]);
    let recipient_commitment =
        sha256_multi(&[DOMAIN_RECIPIENT, recipient, recipient_blinding]);
    let nullifier =
        sha256_multi(&[DOMAIN_NULLIFIER, spending_key, program_id, &epoch.to_le_bytes()]);
    let receipt_id =
        sha256_multi(&[DOMAIN_RECEIPT_ID, &amount_commitment, &recipient_commitment, &nullifier]);

    Ok(AmountReceipt {
        receipt_id,
        amount_commitment,
        recipient_commitment,
        nullifier,
        program_id: *program_id,
        epoch,
        is_stub: true,
        mainnet_ready: false,
    })
}

/// Verify that `commitment` opens to `(amount, blinding)`.
pub fn verify_amount_commitment(
    commitment: &[u8; 32],
    amount: u64,
    blinding: &[u8; 32],
) -> bool {
    let expected = sha256_multi(&[DOMAIN_AMOUNT, &amount.to_le_bytes(), blinding]);
    commitment == &expected
}

/// Verify that `commitment` opens to `(recipient, blinding)`.
pub fn verify_recipient_commitment(
    commitment: &[u8; 32],
    recipient: &[u8; 32],
    blinding: &[u8; 32],
) -> bool {
    let expected = sha256_multi(&[DOMAIN_RECIPIENT, recipient, blinding]);
    commitment == &expected
}

/// Verify that `nullifier` was derived from `(spending_key, program_id, epoch)`.
pub fn verify_nullifier(
    nullifier: &[u8; 32],
    spending_key: &[u8; 32],
    program_id: &[u8; 32],
    epoch: u64,
) -> bool {
    let expected =
        sha256_multi(&[DOMAIN_NULLIFIER, spending_key, program_id, &epoch.to_le_bytes()]);
    nullifier == &expected
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> [u8; 32] {
        [0xabu8; 32]
    }
    fn bl() -> [u8; 32] {
        [0x01u8; 32]
    }
    fn rec() -> [u8; 32] {
        [0xddu8; 32]
    }
    fn prog() -> [u8; 32] {
        [0xeeu8; 32]
    }

    fn make_receipt() -> AmountReceipt {
        create_amount_receipt(&key(), 1_000_000, &bl(), &rec(), &bl(), &prog(), 42).unwrap()
    }

    #[test]
    fn test_valid_receipt_created() {
        let r = make_receipt();
        assert!(r.is_stub);
        assert!(!r.mainnet_ready);
    }

    #[test]
    fn test_zero_spending_key_rejected() {
        let err = create_amount_receipt(
            &[0u8; 32], 1_000_000, &bl(), &rec(), &bl(), &prog(), 0,
        )
        .unwrap_err();
        assert_eq!(err, AmountReceiptError::ZeroSpendingKey);
    }

    #[test]
    fn test_zero_blinding_rejected() {
        let err = create_amount_receipt(
            &key(), 1_000_000, &[0u8; 32], &rec(), &bl(), &prog(), 0,
        )
        .unwrap_err();
        assert_eq!(err, AmountReceiptError::ZeroBlinding);
    }

    #[test]
    fn test_zero_recipient_rejected() {
        let err = create_amount_receipt(
            &key(), 1_000_000, &bl(), &[0u8; 32], &bl(), &prog(), 0,
        )
        .unwrap_err();
        assert_eq!(err, AmountReceiptError::ZeroRecipient);
    }

    #[test]
    fn test_zero_amount_rejected() {
        let err =
            create_amount_receipt(&key(), 0, &bl(), &rec(), &bl(), &prog(), 0).unwrap_err();
        assert_eq!(err, AmountReceiptError::ZeroAmount);
    }

    #[test]
    fn test_zero_program_id_rejected() {
        let err = create_amount_receipt(
            &key(), 1_000_000, &bl(), &rec(), &bl(), &[0u8; 32], 0,
        )
        .unwrap_err();
        assert_eq!(err, AmountReceiptError::ZeroProgramId);
    }

    #[test]
    fn test_receipt_id_nonzero() {
        let r = make_receipt();
        assert_ne!(r.receipt_id, [0u8; 32]);
    }

    #[test]
    fn test_amount_commitment_nonzero() {
        let r = make_receipt();
        assert_ne!(r.amount_commitment, [0u8; 32]);
    }

    #[test]
    fn test_recipient_commitment_nonzero() {
        let r = make_receipt();
        assert_ne!(r.recipient_commitment, [0u8; 32]);
    }

    #[test]
    fn test_nullifier_nonzero() {
        let r = make_receipt();
        assert_ne!(r.nullifier, [0u8; 32]);
    }

    #[test]
    fn test_verify_amount_commitment_correct() {
        let r = make_receipt();
        assert!(verify_amount_commitment(&r.amount_commitment, 1_000_000, &bl()));
    }

    #[test]
    fn test_verify_amount_commitment_wrong_amount() {
        let r = make_receipt();
        assert!(!verify_amount_commitment(&r.amount_commitment, 999_999, &bl()));
    }

    #[test]
    fn test_verify_recipient_commitment_correct() {
        let r = make_receipt();
        assert!(verify_recipient_commitment(&r.recipient_commitment, &rec(), &bl()));
    }

    #[test]
    fn test_verify_nullifier_correct() {
        let r = make_receipt();
        assert!(verify_nullifier(&r.nullifier, &key(), &prog(), 42));
    }

    #[test]
    fn test_mainnet_ready_false() {
        let r = make_receipt();
        assert!(!r.mainnet_ready);
    }

    #[test]
    fn test_is_stub_true() {
        let r = make_receipt();
        assert!(r.is_stub);
    }
}
