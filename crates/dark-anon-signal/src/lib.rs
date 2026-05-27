// dark-anon-signal — anonymous alpha signal purchase via commitment scheme
// Signal provider never learns buyer identity from the payment; only a commitment hash.
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false

use sha2::{Digest, Sha256};

// ── Local payment types (self-contained) ─────────────────────────────────────

/// Plain x402 payment record — buyer_hash is SHA256 of buyer identity, never raw.
#[derive(Debug, Clone)]
pub struct PlainX402Payment {
    pub buyer_hash: [u8; 32],
    pub amount_lamports: u64,
    pub service_hash: [u8; 32],
    pub payment_tx_hash: [u8; 32],
    pub slot: u64,
}

/// Shielded receipt: commitment_hash hides buyer identity; receipt_hash is public anchor.
#[derive(Debug, Clone, PartialEq)]
pub struct ShieldedPaymentReceipt {
    /// SHA256("receipt-v1" || payment_tx_hash || commitment_hash)
    pub receipt_hash: [u8; 32],
    /// SHA256("commitment-v1" || buyer_hash || amount_le8 || nonce)
    pub commitment_hash: [u8; 32],
}

/// Issue a shielded receipt binding buyer commitment to an on-chain payment.
fn issue_shielded_receipt(payment: &PlainX402Payment, nonce: &[u8; 32]) -> ShieldedPaymentReceipt {
    let mut h = Sha256::new();
    h.update(b"commitment-v1");
    h.update(payment.buyer_hash);
    h.update(payment.amount_lamports.to_le_bytes());
    h.update(nonce);
    let commitment_hash: [u8; 32] = h.finalize().into();

    let mut h = Sha256::new();
    h.update(b"receipt-v1");
    h.update(payment.payment_tx_hash);
    h.update(commitment_hash);
    let receipt_hash: [u8; 32] = h.finalize().into();

    ShieldedPaymentReceipt {
        receipt_hash,
        commitment_hash,
    }
}

#[derive(Debug, Clone)]
pub struct SignalListing {
    pub signal_hash: [u8; 32], // SHA256 of signal content
    pub price_lamports: u64,
    pub seller_hash: [u8; 32], // SHA256 of seller wallet — never raw
    pub expiry_slot: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AnonSignalPurchase {
    pub receipt: ShieldedPaymentReceipt,
    pub signal_hash: [u8; 32],
    pub access_token: [u8; 32], // SHA256(commitment_key.nonce || signal_hash) — unlocks the signal
    pub purchased_at_slot: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SignalError {
    Expired,
    Underpaid,
    InvalidListing,
}

/// Buyer provides payment (already made), nonce, slot → returns AnonSignalPurchase.
pub fn purchase_signal(
    listing: &SignalListing,
    payment: &PlainX402Payment,
    nonce: &[u8; 32],
    slot: u64,
) -> Result<AnonSignalPurchase, SignalError> {
    if is_listing_expired(listing, slot) {
        return Err(SignalError::Expired);
    }
    if payment.amount_lamports < listing.price_lamports {
        return Err(SignalError::Underpaid);
    }

    let receipt = issue_shielded_receipt(payment, nonce);

    // access_token = SHA256(nonce || signal_hash)
    let mut h = Sha256::new();
    h.update(nonce);
    h.update(listing.signal_hash);
    let access_token: [u8; 32] = h.finalize().into();

    Ok(AnonSignalPurchase {
        receipt,
        signal_hash: listing.signal_hash,
        access_token,
        purchased_at_slot: slot,
    })
}

/// Signal content + purchase → prove buyer has valid access.
pub fn verify_access_token(purchase: &AnonSignalPurchase, nonce: &[u8; 32]) -> bool {
    let mut h = Sha256::new();
    h.update(nonce);
    h.update(purchase.signal_hash);
    let expected: [u8; 32] = h.finalize().into();
    expected == purchase.access_token
}

/// Seller-facing view — returns JSON with ONLY commitment_hash, signal_hash, slot.
pub fn seller_sees_only_commitment(purchase: &AnonSignalPurchase) -> serde_json::Value {
    serde_json::json!({
        "commitment_hash": hex_encode(&purchase.receipt.commitment_hash),
        "signal_hash": hex_encode(&purchase.signal_hash),
        "slot": purchase.purchased_at_slot,
    })
}

/// Returns true when current_slot > listing.expiry_slot.
pub fn is_listing_expired(listing: &SignalListing, current_slot: u64) -> bool {
    current_slot > listing.expiry_slot
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_listing() -> SignalListing {
        SignalListing {
            signal_hash: [0xAA; 32],
            price_lamports: 500_000,
            seller_hash: [0xBB; 32],
            expiry_slot: 1000,
        }
    }

    fn sample_payment(amount: u64) -> PlainX402Payment {
        PlainX402Payment {
            buyer_hash: [0xCC; 32],
            amount_lamports: amount,
            service_hash: [0xAA; 32], // matches signal_hash conceptually
            payment_tx_hash: [0xDD; 32],
            slot: 500,
        }
    }

    fn sample_nonce() -> [u8; 32] {
        [0x11; 32]
    }

    #[test]
    fn test_purchase_happy_path() {
        let listing = sample_listing();
        let payment = sample_payment(500_000);
        let nonce = sample_nonce();
        let result = purchase_signal(&listing, &payment, &nonce, 500);
        assert!(result.is_ok());
    }

    #[test]
    fn test_expired_listing_rejected() {
        let listing = sample_listing(); // expiry_slot = 1000
        let payment = sample_payment(500_000);
        let nonce = sample_nonce();
        let result = purchase_signal(&listing, &payment, &nonce, 1001);
        assert_eq!(result, Err(SignalError::Expired));
    }

    #[test]
    fn test_access_token_verifies() {
        let listing = sample_listing();
        let payment = sample_payment(500_000);
        let nonce = sample_nonce();
        let purchase = purchase_signal(&listing, &payment, &nonce, 500).unwrap();
        assert!(verify_access_token(&purchase, &nonce));
    }

    #[test]
    fn test_wrong_nonce_fails_access() {
        let listing = sample_listing();
        let payment = sample_payment(500_000);
        let nonce = sample_nonce();
        let purchase = purchase_signal(&listing, &payment, &nonce, 500).unwrap();
        let wrong_nonce = [0xFF; 32];
        assert!(!verify_access_token(&purchase, &wrong_nonce));
    }

    #[test]
    fn test_seller_view_hides_buyer() {
        let listing = sample_listing();
        let payment = sample_payment(500_000);
        let nonce = sample_nonce();
        let purchase = purchase_signal(&listing, &payment, &nonce, 500).unwrap();
        let view = seller_sees_only_commitment(&purchase);
        let json_str = view.to_string();

        let buyer_hex: String = payment
            .buyer_hash
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();
        assert!(!json_str.contains(&buyer_hex));

        // Confirm expected fields present
        assert!(json_str.contains("commitment_hash"));
        assert!(json_str.contains("signal_hash"));
        assert!(json_str.contains("slot"));
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_underpaid_listing_rejected() {
        let listing = sample_listing(); // price = 500_000
        let payment = sample_payment(499_999);
        let result = purchase_signal(&listing, &payment, &sample_nonce(), 500);
        assert_eq!(result, Err(SignalError::Underpaid));
    }

    #[test]
    fn test_listing_at_exact_expiry_ok() {
        let listing = sample_listing(); // expiry_slot = 1000
        let payment = sample_payment(500_000);
        // slot == expiry_slot → NOT expired (strict > check)
        assert!(!is_listing_expired(&listing, 1000));
        let result = purchase_signal(&listing, &payment, &sample_nonce(), 1000);
        assert!(result.is_ok());
    }

    #[test]
    fn test_access_token_deterministic() {
        let listing = sample_listing();
        let payment = sample_payment(500_000);
        let nonce = sample_nonce();
        let p1 = purchase_signal(&listing, &payment, &nonce, 500).unwrap();
        let p2 = purchase_signal(&listing, &payment, &nonce, 500).unwrap();
        assert_eq!(p1.access_token, p2.access_token);
    }

    #[test]
    fn test_access_token_signal_sensitive() {
        let mut listing2 = sample_listing();
        listing2.signal_hash[0] ^= 0xFF;
        let payment = sample_payment(500_000);
        let nonce = sample_nonce();
        let p1 = purchase_signal(&sample_listing(), &payment, &nonce, 500).unwrap();
        let p2 = purchase_signal(&listing2, &payment, &nonce, 500).unwrap();
        assert_ne!(p1.access_token, p2.access_token);
    }

    #[test]
    fn test_access_token_nonce_sensitive() {
        let listing = sample_listing();
        let payment = sample_payment(500_000);
        let nonce2 = [0xFF; 32];
        let p1 = purchase_signal(&listing, &payment, &sample_nonce(), 500).unwrap();
        let p2 = purchase_signal(&listing, &payment, &nonce2, 500).unwrap();
        assert_ne!(p1.access_token, p2.access_token);
    }

    #[test]
    fn test_receipt_commitment_buyer_sensitive() {
        let mut payment2 = sample_payment(500_000);
        payment2.buyer_hash[0] ^= 0xFF;
        let p1 = purchase_signal(
            &sample_listing(),
            &sample_payment(500_000),
            &sample_nonce(),
            500,
        )
        .unwrap();
        let p2 = purchase_signal(&sample_listing(), &payment2, &sample_nonce(), 500).unwrap();
        assert_ne!(p1.receipt.commitment_hash, p2.receipt.commitment_hash);
    }

    #[test]
    fn test_receipt_commitment_amount_sensitive() {
        let p1 = purchase_signal(
            &sample_listing(),
            &sample_payment(500_000),
            &sample_nonce(),
            500,
        )
        .unwrap();
        let p2 = purchase_signal(
            &sample_listing(),
            &sample_payment(600_000),
            &sample_nonce(),
            500,
        )
        .unwrap();
        assert_ne!(p1.receipt.commitment_hash, p2.receipt.commitment_hash);
    }

    #[test]
    fn test_receipt_nonce_sensitive() {
        let nonce2 = [0xEE; 32];
        let p1 = purchase_signal(
            &sample_listing(),
            &sample_payment(500_000),
            &sample_nonce(),
            500,
        )
        .unwrap();
        let p2 =
            purchase_signal(&sample_listing(), &sample_payment(500_000), &nonce2, 500).unwrap();
        assert_ne!(p1.receipt.commitment_hash, p2.receipt.commitment_hash);
    }

    #[test]
    fn test_seller_view_contains_expected_fields() {
        let purchase = purchase_signal(
            &sample_listing(),
            &sample_payment(500_000),
            &sample_nonce(),
            500,
        )
        .unwrap();
        let view = seller_sees_only_commitment(&purchase);
        assert!(view["commitment_hash"].is_string());
        assert!(view["signal_hash"].is_string());
        assert!(view["slot"].is_number());
    }

    #[test]
    fn test_purchase_slot_stored() {
        let purchase = purchase_signal(
            &sample_listing(),
            &sample_payment(500_000),
            &sample_nonce(),
            750,
        )
        .unwrap();
        assert_eq!(purchase.purchased_at_slot, 750);
    }

    #[test]
    fn test_receipt_hash_nonzero() {
        let purchase = purchase_signal(
            &sample_listing(),
            &sample_payment(500_000),
            &sample_nonce(),
            500,
        )
        .unwrap();
        assert_ne!(purchase.receipt.receipt_hash, [0u8; 32]);
    }
}
