// dark-anon-signal — anonymous alpha signal purchase via commitment scheme
// Signal provider never learns buyer identity from the payment; only a commitment hash.
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false

use sha2::{Digest, Sha256};

pub use dark_private_x402::{PlainX402Payment, ShieldedPaymentReceipt};

#[derive(Debug, Clone)]
pub struct SignalListing {
    pub signal_hash: [u8; 32],   // SHA256 of signal content
    pub price_lamports: u64,
    pub seller_hash: [u8; 32],   // SHA256 of seller wallet — never raw
    pub expiry_slot: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AnonSignalPurchase {
    pub receipt: ShieldedPaymentReceipt,
    pub signal_hash: [u8; 32],
    pub access_token: [u8; 32],  // SHA256(commitment_key.nonce || signal_hash) — unlocks the signal
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

    let receipt = dark_private_x402::issue_shielded_receipt(payment, nonce);

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

        let buyer_hex: String = payment.buyer_hash.iter().map(|b| format!("{:02x}", b)).collect();
        assert!(!json_str.contains(&buyer_hex));

        // Confirm expected fields present
        assert!(json_str.contains("commitment_hash"));
        assert!(json_str.contains("signal_hash"));
        assert!(json_str.contains("slot"));
    }
}
