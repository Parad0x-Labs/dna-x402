//! dark-flash-loan-guard
//!
//! Flash loan atomic receipt proof — ensures borrow and repayment are
//! atomically committed to a single proof chain. If repayment amount <
//! borrow + fee, the proof is invalid.
//!
//! All hashing is pure SHA-256 with domain separation; no network I/O.
//! `mainnet_ready: false` on all outputs until audited.

use sha2::{Digest, Sha256};

// ──────────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────────

/// Represents an initiated flash-loan borrow.
#[derive(Debug, Clone)]
pub struct FlashLoanBorrow {
    /// SHA256("flash-borrow-v1" || amount_le || borrower_hash || slot_le)
    pub borrow_id: [u8; 32],
    /// SHA256("borrower-hash-v1" || borrower_secret)
    pub borrower_hash: [u8; 32],
    pub amount: u64,
    /// Basis points, e.g. 30 = 0.30 %
    pub fee_bps: u16,
    pub slot: u64,
    pub mainnet_ready: bool,
}

/// Represents a repayment proof for an outstanding flash-loan borrow.
#[derive(Debug, Clone)]
pub struct FlashLoanRepayment {
    pub borrow_id: [u8; 32],
    pub repaid_amount: u64,
    /// amount + fee
    pub required_amount: u64,
    /// SHA256("flash-repay-v1" || borrow_id || repaid_le)
    pub repayment_proof: [u8; 32],
    pub mainnet_ready: bool,
}

/// Final atomic receipt produced after a successful borrow + repayment cycle.
#[derive(Debug, Clone)]
pub struct FlashLoanReceipt {
    pub borrow_id: [u8; 32],
    /// SHA256("flash-receipt-v1" || borrow_id || repayment_proof)
    pub receipt_hash: [u8; 32],
    pub amount: u64,
    pub fee_paid: u64,
    pub mainnet_ready: bool,
}

/// Errors that can be returned by the flash-loan guard functions.
#[derive(Debug, PartialEq)]
pub enum FlashLoanError {
    ZeroAmount,
    InsufficientRepayment { required: u64, provided: u64 },
    BorrowIdMismatch,
    BorrowerSecretZero,
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

/// Domain-separated SHA-256: SHA256(domain_tag || rest)
fn sha256_domain(domain: &[u8], rest: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(domain);
    for chunk in rest {
        h.update(chunk);
    }
    h.finalize().into()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

/// Initiate a flash-loan borrow.
///
/// # Errors
/// - [`FlashLoanError::ZeroAmount`] if `amount == 0`.
/// - [`FlashLoanError::BorrowerSecretZero`] if `borrower_secret == [0; 32]`.
pub fn create_borrow(
    borrower_secret: &[u8; 32],
    amount: u64,
    fee_bps: u16,
    slot: u64,
) -> Result<FlashLoanBorrow, FlashLoanError> {
    if amount == 0 {
        return Err(FlashLoanError::ZeroAmount);
    }
    if borrower_secret == &[0u8; 32] {
        return Err(FlashLoanError::BorrowerSecretZero);
    }

    // borrower_hash = SHA256("borrower-hash-v1" || borrower_secret)
    let borrower_hash = sha256_domain(b"borrower-hash-v1", &[borrower_secret]);

    // borrow_id = SHA256("flash-borrow-v1" || amount_le || borrower_hash || slot_le)
    let amount_le = amount.to_le_bytes();
    let slot_le = slot.to_le_bytes();
    let borrow_id = sha256_domain(
        b"flash-borrow-v1",
        &[&amount_le, &borrower_hash, &slot_le],
    );

    Ok(FlashLoanBorrow {
        borrow_id,
        borrower_hash,
        amount,
        fee_bps,
        slot,
        mainnet_ready: false,
    })
}

/// Record a repayment against an existing borrow.
///
/// # Errors
/// - [`FlashLoanError::InsufficientRepayment`] if `repaid_amount < amount + fee`.
pub fn repay_loan(
    borrow: &FlashLoanBorrow,
    repaid_amount: u64,
) -> Result<FlashLoanRepayment, FlashLoanError> {
    // required_amount = amount + floor(amount * fee_bps / 10_000)
    let fee = borrow.amount * borrow.fee_bps as u64 / 10_000;
    let required_amount = borrow.amount + fee;

    if repaid_amount < required_amount {
        return Err(FlashLoanError::InsufficientRepayment {
            required: required_amount,
            provided: repaid_amount,
        });
    }

    // repayment_proof = SHA256("flash-repay-v1" || borrow_id || repaid_le)
    let repaid_le = repaid_amount.to_le_bytes();
    let repayment_proof =
        sha256_domain(b"flash-repay-v1", &[&borrow.borrow_id, &repaid_le]);

    Ok(FlashLoanRepayment {
        borrow_id: borrow.borrow_id,
        repaid_amount,
        required_amount,
        repayment_proof,
        mainnet_ready: false,
    })
}

/// Finalize a flash-loan cycle and produce an atomic receipt.
///
/// # Errors
/// - [`FlashLoanError::BorrowIdMismatch`] if `repayment.borrow_id != borrow.borrow_id`.
pub fn finalize_loan(
    borrow: &FlashLoanBorrow,
    repayment: &FlashLoanRepayment,
) -> Result<FlashLoanReceipt, FlashLoanError> {
    if repayment.borrow_id != borrow.borrow_id {
        return Err(FlashLoanError::BorrowIdMismatch);
    }

    let fee_paid = repayment.repaid_amount - borrow.amount;

    // receipt_hash = SHA256("flash-receipt-v1" || borrow_id || repayment_proof)
    let receipt_hash = sha256_domain(
        b"flash-receipt-v1",
        &[&borrow.borrow_id, &repayment.repayment_proof],
    );

    Ok(FlashLoanReceipt {
        borrow_id: borrow.borrow_id,
        receipt_hash,
        amount: borrow.amount,
        fee_paid,
        mainnet_ready: false,
    })
}

/// Produce a JSON public record of a finalized receipt.
///
/// Intentionally omits all borrower-identity information; only the
/// borrow_id (already a commitment) and receipt_hash are included.
pub fn loan_public_record(receipt: &FlashLoanReceipt) -> String {
    serde_json::json!({
        "borrow_id":    hex_encode(&receipt.borrow_id),
        "receipt_hash": hex_encode(&receipt.receipt_hash),
        "fee_paid":     receipt.fee_paid,
        "mainnet_ready": receipt.mainnet_ready,
    })
    .to_string()
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn test_secret() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xde;
        s[1] = 0xad;
        s[31] = 0xff;
        s
    }

    // 1. Happy path: 30 bps fee, exact repayment succeeds end-to-end.
    #[test]
    fn test_borrow_repay_finalize_happy_path() {
        let secret = test_secret();
        let amount: u64 = 1_000_000;
        let fee_bps: u16 = 30; // 0.30 %
        let slot: u64 = 42;

        let borrow = create_borrow(&secret, amount, fee_bps, slot)
            .expect("create_borrow should succeed");
        assert_eq!(borrow.amount, amount);
        assert_eq!(borrow.fee_bps, fee_bps);
        assert!(!borrow.mainnet_ready);

        // Exact repayment: 1_000_000 + 300 = 1_000_300
        let required = amount + amount * fee_bps as u64 / 10_000;
        let repayment = repay_loan(&borrow, required)
            .expect("repay_loan should succeed with exact amount");
        assert_eq!(repayment.required_amount, required);
        assert!(!repayment.mainnet_ready);

        let receipt = finalize_loan(&borrow, &repayment)
            .expect("finalize_loan should succeed");
        assert_eq!(receipt.borrow_id, borrow.borrow_id);
        assert_eq!(receipt.amount, amount);
        assert_eq!(receipt.fee_paid, required - amount);
        assert!(!receipt.mainnet_ready);
    }

    // 2. Repaid amount below required returns InsufficientRepayment.
    #[test]
    fn test_insufficient_repayment_rejected() {
        let secret = test_secret();
        let amount: u64 = 500_000;
        let fee_bps: u16 = 30;

        let borrow = create_borrow(&secret, amount, fee_bps, 1).unwrap();
        let required = amount + amount * fee_bps as u64 / 10_000;

        let err = repay_loan(&borrow, required - 1).unwrap_err();
        assert_eq!(
            err,
            FlashLoanError::InsufficientRepayment {
                required,
                provided: required - 1,
            }
        );
    }

    // 3. Zero amount is rejected.
    #[test]
    fn test_zero_amount_rejected() {
        let secret = test_secret();
        let err = create_borrow(&secret, 0, 30, 1).unwrap_err();
        assert_eq!(err, FlashLoanError::ZeroAmount);
    }

    // 4. Finalizing with a mismatched repayment returns BorrowIdMismatch.
    #[test]
    fn test_borrow_id_mismatch_rejected() {
        let secret = test_secret();

        let borrow_a = create_borrow(&secret, 1_000, 30, 1).unwrap();
        let borrow_b = create_borrow(&secret, 2_000, 30, 2).unwrap();

        // Repayment is valid against borrow_b
        let required_b = 2_000 + 2_000 * 30u64 / 10_000;
        let repayment_b = repay_loan(&borrow_b, required_b).unwrap();

        // Attempting to finalize borrow_a with borrow_b's repayment
        let err = finalize_loan(&borrow_a, &repayment_b).unwrap_err();
        assert_eq!(err, FlashLoanError::BorrowIdMismatch);
    }

    // 5. Fee calculation: 10_000 SOL at 30 bps = exactly 30 SOL fee.
    #[test]
    fn test_fee_calculation_correct() {
        let secret = test_secret();
        // Represent amounts in lamports (1 SOL = 1_000_000_000 lamports)
        let sol: u64 = 1_000_000_000;
        let amount = 10_000 * sol; // 10_000 SOL
        let fee_bps: u16 = 30;

        let borrow = create_borrow(&secret, amount, fee_bps, 7).unwrap();
        let required = amount + amount * fee_bps as u64 / 10_000;
        let fee = required - amount;

        // 10_000 SOL * 0.30% = 30 SOL = 30_000_000_000 lamports
        assert_eq!(fee, 30 * sol, "fee should be exactly 30 SOL");

        let repayment = repay_loan(&borrow, required).unwrap();
        let receipt = finalize_loan(&borrow, &repayment).unwrap();
        assert_eq!(receipt.fee_paid, fee);
    }

    // 6. loan_public_record does NOT leak borrower_hash.
    #[test]
    fn test_public_record_hides_borrower() {
        let secret = test_secret();
        let borrow = create_borrow(&secret, 1_000_000, 30, 99).unwrap();
        let required = 1_000_000 + 1_000_000 * 30u64 / 10_000;
        let repayment = repay_loan(&borrow, required).unwrap();
        let receipt = finalize_loan(&borrow, &repayment).unwrap();

        let record = loan_public_record(&receipt);

        // The borrower_hash must NOT appear in the public record.
        let borrower_hex = hex_encode(&borrow.borrower_hash);
        assert!(
            !record.contains(&borrower_hex),
            "public record must not contain borrower_hash; got: {record}"
        );

        // Sanity: the record is valid JSON containing the expected keys.
        let v: serde_json::Value =
            serde_json::from_str(&record).expect("record must be valid JSON");
        assert!(v.get("borrow_id").is_some());
        assert!(v.get("receipt_hash").is_some());
        assert!(v.get("fee_paid").is_some());
        assert_eq!(v["mainnet_ready"], false);
    }
}
