// dark-private-x402 — x402 payment with shielded receipt output
// Pay for a service; chain records only a commitment hash, not the buyer identity.
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false

use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct PlainX402Payment {
    pub buyer_hash: [u8; 32],      // SHA256 of buyer wallet pubkey
    pub amount_lamports: u64,
    pub service_hash: [u8; 32],    // SHA256 of service URL/ID
    pub payment_tx_hash: [u8; 32],
    pub slot: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ShieldedPaymentReceipt {
    pub commitment_hash: [u8; 32], // commitment to (buyer_hash, amount, service, nonce)
    pub payment_tx_hash: [u8; 32], // the actual on-chain tx — public but unlinkable without commitment key
    pub receipt_hash: [u8; 32],    // SHA256 of the whole receipt
    pub epoch: u64,
    pub mainnet_ready: bool,       // always false
}

#[derive(Debug, Clone)]
pub struct CommitmentKey {
    pub nonce: [u8; 32],
    pub buyer_hash: [u8; 32],
}

#[derive(Debug, Clone, PartialEq)]
pub enum ShieldedX402Error {
    InvalidPayment,
    CommitmentMismatch,
    ZeroAmount,
}

/// SHA256("x402-commitment-v1" || buyer_hash || amount.to_le || service_hash || nonce)
pub fn create_payment_commitment(payment: &PlainX402Payment, nonce: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"x402-commitment-v1");
    h.update(payment.buyer_hash);
    h.update(payment.amount_lamports.to_le_bytes());
    h.update(payment.service_hash);
    h.update(nonce);
    h.finalize().into()
}

/// Converts a plain payment into a shielded receipt.
/// Buyer gets CommitmentKey (proof they paid); chain sees only commitment_hash.
pub fn issue_shielded_receipt(payment: &PlainX402Payment, nonce: &[u8; 32]) -> ShieldedPaymentReceipt {
    let commitment_hash = create_payment_commitment(payment, nonce);

    // receipt_hash = SHA256(commitment_hash || payment_tx_hash || slot.to_le)
    let mut rh = Sha256::new();
    rh.update(commitment_hash);
    rh.update(payment.payment_tx_hash);
    rh.update(payment.slot.to_le_bytes());
    let receipt_hash: [u8; 32] = rh.finalize().into();

    ShieldedPaymentReceipt {
        commitment_hash,
        payment_tx_hash: payment.payment_tx_hash,
        receipt_hash,
        epoch: payment.slot,
        mainnet_ready: false,
    }
}

/// Given CommitmentKey + receipt, prove payment is valid.
pub fn verify_shielded_receipt(
    receipt: &ShieldedPaymentReceipt,
    payment: &PlainX402Payment,
    nonce: &[u8; 32],
) -> bool {
    let expected_commitment = create_payment_commitment(payment, nonce);
    expected_commitment == receipt.commitment_hash
}

/// JSON safe for on-chain/public — contains ONLY commitment_hash, receipt_hash, epoch.
/// NO buyer_hash, NO amount, NO service_hash.
pub fn redacted_public_record(receipt: &ShieldedPaymentReceipt) -> serde_json::Value {
    serde_json::json!({
        "commitment_hash": hex::encode_bytes(&receipt.commitment_hash),
        "receipt_hash": hex::encode_bytes(&receipt.receipt_hash),
        "epoch": receipt.epoch,
    })
}

/// Checks JSON string doesn't contain buyer_hash hex.
pub fn buyer_hash_absent_from_receipt(receipt_json: &str, buyer_hash: &[u8; 32]) -> bool {
    let hex_str = hex::encode_bytes(buyer_hash);
    !receipt_json.contains(&hex_str)
}

/// Validate that a payment has a non-zero amount.
pub fn validate_payment(payment: &PlainX402Payment) -> Result<(), ShieldedX402Error> {
    if payment.amount_lamports == 0 {
        return Err(ShieldedX402Error::ZeroAmount);
    }
    Ok(())
}

// Internal hex encoding helper — avoids adding a hex crate dependency.
mod hex {
    pub fn encode_bytes(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_payment() -> PlainX402Payment {
        PlainX402Payment {
            buyer_hash: [0xAA; 32],
            amount_lamports: 1_000_000,
            service_hash: [0xBB; 32],
            payment_tx_hash: [0xCC; 32],
            slot: 42,
        }
    }

    fn sample_nonce() -> [u8; 32] {
        [0x11; 32]
    }

    #[test]
    fn test_shielded_receipt_mainnet_ready_false() {
        let payment = sample_payment();
        let nonce = sample_nonce();
        let receipt = issue_shielded_receipt(&payment, &nonce);
        assert!(!receipt.mainnet_ready);
    }

    #[test]
    fn test_commitment_covers_all_fields() {
        let payment = sample_payment();
        let nonce = sample_nonce();
        let base = create_payment_commitment(&payment, &nonce);

        // Different buyer_hash
        let mut p2 = payment.clone();
        p2.buyer_hash = [0x01; 32];
        assert_ne!(base, create_payment_commitment(&p2, &nonce));

        // Different amount
        let mut p3 = payment.clone();
        p3.amount_lamports = 999;
        assert_ne!(base, create_payment_commitment(&p3, &nonce));

        // Different service_hash
        let mut p4 = payment.clone();
        p4.service_hash = [0x02; 32];
        assert_ne!(base, create_payment_commitment(&p4, &nonce));

        // Different nonce
        let nonce2 = [0x22; 32];
        assert_ne!(base, create_payment_commitment(&payment, &nonce2));
    }

    #[test]
    fn test_verify_shielded_receipt_roundtrip() {
        let payment = sample_payment();
        let nonce = sample_nonce();
        let receipt = issue_shielded_receipt(&payment, &nonce);
        assert!(verify_shielded_receipt(&receipt, &payment, &nonce));
    }

    #[test]
    fn test_wrong_nonce_fails_verification() {
        let payment = sample_payment();
        let nonce = sample_nonce();
        let receipt = issue_shielded_receipt(&payment, &nonce);
        let wrong_nonce = [0xFF; 32];
        assert!(!verify_shielded_receipt(&receipt, &payment, &wrong_nonce));
    }

    #[test]
    fn test_redacted_record_hides_buyer() {
        let payment = sample_payment();
        let nonce = sample_nonce();
        let receipt = issue_shielded_receipt(&payment, &nonce);
        let record = redacted_public_record(&receipt);
        let json_str = record.to_string();
        assert!(buyer_hash_absent_from_receipt(&json_str, &payment.buyer_hash));
        // Also confirm the expected keys are present
        assert!(json_str.contains("commitment_hash"));
        assert!(json_str.contains("receipt_hash"));
        assert!(json_str.contains("epoch"));
    }

    #[test]
    fn test_zero_amount_error() {
        let mut payment = sample_payment();
        payment.amount_lamports = 0;
        let nonce = sample_nonce();

        // Structural issue: zero-amount receipt can be issued (no panic)
        let receipt = issue_shielded_receipt(&payment, &nonce);
        assert!(!receipt.mainnet_ready);

        // But validate_payment must catch it
        assert_eq!(validate_payment(&payment), Err(ShieldedX402Error::ZeroAmount));

        // Non-zero passes
        payment.amount_lamports = 1;
        assert!(validate_payment(&payment).is_ok());
    }
}
