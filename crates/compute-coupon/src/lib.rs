use ed25519_dalek::{Keypair, PublicKey, Signature, Signer, Verifier};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Serde helper for [u8; 64] arrays (not natively supported by serde 1.x).
mod bytes64 {
    use serde::de::{self, Visitor};
    use serde::{Deserializer, Serializer};
    use std::fmt;

    pub fn serialize<S: Serializer>(v: &[u8; 64], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bytes(v)
    }

    struct Bytes64Visitor;
    impl<'de> Visitor<'de> for Bytes64Visitor {
        type Value = [u8; 64];
        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            write!(f, "64 bytes")
        }
        fn visit_bytes<E: de::Error>(self, v: &[u8]) -> Result<[u8; 64], E> {
            v.try_into().map_err(|_| E::invalid_length(v.len(), &self))
        }
        fn visit_seq<A: de::SeqAccess<'de>>(self, mut seq: A) -> Result<[u8; 64], A::Error> {
            let mut arr = [0u8; 64];
            for (i, slot) in arr.iter_mut().enumerate() {
                *slot = seq
                    .next_element()?
                    .ok_or_else(|| de::Error::invalid_length(i, &self))?;
            }
            Ok(arr)
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 64], D::Error> {
        d.deserialize_bytes(Bytes64Visitor)
    }
}

/// A pre-purchased right to submit one priority-fee-capped private tx via a relayer.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ComputeCoupon {
    /// Unique coupon ID.
    pub id: [u8; 32],
    /// Maximum compute-unit price the relayer may charge (lamports / CU).
    pub max_cu_price_lamports: u64,
    /// Maximum CU limit for the transaction.
    pub max_cu_limit: u32,
    /// Bitmask of allowed relayer route classes.
    pub route_class: u8,
    /// Slot after which coupon is invalid.
    pub expires_at_slot: u64,
    /// Receipt hash binding prevents cross-session reuse.
    pub receipt_hash_binding: [u8; 32],
    /// Ed25519 signature by issuer.
    #[serde(with = "bytes64")]
    pub signature: [u8; 64],
    /// Issuer public key.
    pub issuer_pubkey: [u8; 32],
}

#[derive(Debug, PartialEq, Eq)]
pub enum CouponError {
    Expired,
    InvalidSignature,
    OverBudget,
    WrongRouteClass,
    WrongReceiptBinding,
}

fn coupon_signing_bytes(
    id: &[u8; 32],
    max_cu_price: u64,
    max_cu_limit: u32,
    route_class: u8,
    expires_at_slot: u64,
    receipt_hash: &[u8; 32],
) -> Vec<u8> {
    let mut b = Vec::with_capacity(32 + 8 + 4 + 1 + 8 + 32);
    b.extend_from_slice(id);
    b.extend_from_slice(&max_cu_price.to_le_bytes());
    b.extend_from_slice(&max_cu_limit.to_le_bytes());
    b.push(route_class);
    b.extend_from_slice(&expires_at_slot.to_le_bytes());
    b.extend_from_slice(receipt_hash);
    b
}

/// Generate a unique coupon ID from issuer pubkey + nonce.
pub fn coupon_id(issuer_pubkey: &[u8; 32], nonce: u64) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(issuer_pubkey);
    h.update(&nonce.to_le_bytes());
    h.finalize().into()
}

/// Issue a signed compute coupon.
pub fn issue(
    keypair: &Keypair,
    nonce: u64,
    max_cu_price_lamports: u64,
    max_cu_limit: u32,
    route_class: u8,
    expires_at_slot: u64,
    receipt_hash_binding: [u8; 32],
) -> ComputeCoupon {
    let pubkey_bytes = keypair.public.to_bytes();
    let id = coupon_id(&pubkey_bytes, nonce);
    let msg = coupon_signing_bytes(
        &id,
        max_cu_price_lamports,
        max_cu_limit,
        route_class,
        expires_at_slot,
        &receipt_hash_binding,
    );
    let sig = keypair.sign(&msg);
    ComputeCoupon {
        id,
        max_cu_price_lamports,
        max_cu_limit,
        route_class,
        expires_at_slot,
        receipt_hash_binding,
        signature: sig.to_bytes(),
        issuer_pubkey: pubkey_bytes,
    }
}

/// Verify and redeem a coupon for a given relay request.
pub fn redeem(
    coupon: &ComputeCoupon,
    current_slot: u64,
    requested_cu_price: u64,
    requested_route_class: u8,
    receipt_hash: &[u8; 32],
) -> Result<(), CouponError> {
    if current_slot > coupon.expires_at_slot {
        return Err(CouponError::Expired);
    }
    if requested_cu_price > coupon.max_cu_price_lamports {
        return Err(CouponError::OverBudget);
    }
    if coupon.route_class != 0 && requested_route_class != coupon.route_class {
        return Err(CouponError::WrongRouteClass);
    }
    if receipt_hash != &coupon.receipt_hash_binding {
        return Err(CouponError::WrongReceiptBinding);
    }
    // Verify signature
    let pk =
        PublicKey::from_bytes(&coupon.issuer_pubkey).map_err(|_| CouponError::InvalidSignature)?;
    let sig =
        Signature::from_bytes(&coupon.signature).map_err(|_| CouponError::InvalidSignature)?;
    let msg = coupon_signing_bytes(
        &coupon.id,
        coupon.max_cu_price_lamports,
        coupon.max_cu_limit,
        coupon.route_class,
        coupon.expires_at_slot,
        &coupon.receipt_hash_binding,
    );
    pk.verify(&msg, &sig)
        .map_err(|_| CouponError::InvalidSignature)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_keypair() -> Keypair {
        let secret = ed25519_dalek::SecretKey::from_bytes(&[0x99u8; 32]).unwrap();
        let public = PublicKey::from(&secret);
        Keypair { secret, public }
    }

    fn default_receipt() -> [u8; 32] {
        [0xAB; 32]
    }

    #[test]
    fn test_issue_and_redeem_ok() {
        let kp = test_keypair();
        let receipt = default_receipt();
        let coupon = issue(&kp, 1, 1000, 200_000, 1, 100, receipt);
        let result = redeem(&coupon, 50, 500, 1, &receipt);
        assert!(result.is_ok());
    }

    #[test]
    fn test_expired_coupon_rejected() {
        let kp = test_keypair();
        let receipt = default_receipt();
        let coupon = issue(&kp, 2, 1000, 200_000, 1, 10, receipt);
        // current_slot (11) > expires_at_slot (10)
        let result = redeem(&coupon, 11, 500, 1, &receipt);
        assert_eq!(result, Err(CouponError::Expired));
    }

    #[test]
    fn test_over_cu_price_rejected() {
        let kp = test_keypair();
        let receipt = default_receipt();
        let coupon = issue(&kp, 3, 1000, 200_000, 1, 100, receipt);
        // requested 1001 > max 1000
        let result = redeem(&coupon, 50, 1001, 1, &receipt);
        assert_eq!(result, Err(CouponError::OverBudget));
    }

    #[test]
    fn test_wrong_receipt_binding_rejected() {
        let kp = test_keypair();
        let receipt = default_receipt();
        let coupon = issue(&kp, 4, 1000, 200_000, 1, 100, receipt);
        let wrong_receipt = [0xCD; 32];
        let result = redeem(&coupon, 50, 500, 1, &wrong_receipt);
        assert_eq!(result, Err(CouponError::WrongReceiptBinding));
    }

    #[test]
    fn test_tampered_signature_rejected() {
        let kp = test_keypair();
        let receipt = default_receipt();
        let mut coupon = issue(&kp, 5, 1000, 200_000, 1, 100, receipt);
        // Flip a bit in the signature
        coupon.signature[0] ^= 0xFF;
        let result = redeem(&coupon, 50, 500, 1, &receipt);
        assert_eq!(result, Err(CouponError::InvalidSignature));
    }

    #[test]
    fn test_coupon_id_deterministic() {
        let pubkey = [0x42u8; 32];
        let id1 = coupon_id(&pubkey, 7);
        let id2 = coupon_id(&pubkey, 7);
        assert_eq!(id1, id2);

        // Different nonce → different id
        let id3 = coupon_id(&pubkey, 8);
        assert_ne!(id1, id3);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_coupon_id_pubkey_sensitive() {
        let pk1 = [0x11u8; 32];
        let pk2 = [0x22u8; 32];
        assert_ne!(coupon_id(&pk1, 0), coupon_id(&pk2, 0));
    }

    #[test]
    fn test_wrong_route_class_rejected() {
        let kp = test_keypair();
        let receipt = default_receipt();
        let coupon = issue(&kp, 10, 1000, 200_000, 2, 100, receipt);
        let result = redeem(&coupon, 50, 500, 1, &receipt);
        assert_eq!(result, Err(CouponError::WrongRouteClass));
    }

    #[test]
    fn test_any_route_class_allowed_when_zero() {
        let kp = test_keypair();
        let receipt = default_receipt();
        let coupon = issue(&kp, 11, 1000, 200_000, 0, 100, receipt);
        assert!(redeem(&coupon, 50, 500, 7, &receipt).is_ok());
    }

    #[test]
    fn test_redeem_at_expiry_slot_ok() {
        let kp = test_keypair();
        let receipt = default_receipt();
        let coupon = issue(&kp, 12, 1000, 200_000, 1, 100, receipt);
        // current_slot == expires_at_slot → ok (> check, not >=)
        assert!(redeem(&coupon, 100, 500, 1, &receipt).is_ok());
    }

    #[test]
    fn test_redeem_one_past_expiry_fails() {
        let kp = test_keypair();
        let receipt = default_receipt();
        let coupon = issue(&kp, 13, 1000, 200_000, 1, 100, receipt);
        let result = redeem(&coupon, 101, 500, 1, &receipt);
        assert_eq!(result, Err(CouponError::Expired));
    }

    #[test]
    fn test_max_cu_price_at_limit_ok() {
        let kp = test_keypair();
        let receipt = default_receipt();
        let coupon = issue(&kp, 14, 1000, 200_000, 1, 100, receipt);
        assert!(redeem(&coupon, 50, 1000, 1, &receipt).is_ok());
    }

    #[test]
    fn test_tampered_max_cu_price_invalid_sig() {
        let kp = test_keypair();
        let receipt = default_receipt();
        let mut coupon = issue(&kp, 15, 1000, 200_000, 1, 100, receipt);
        coupon.max_cu_price_lamports = 9999; // tamper: signing_bytes now mismatch
        let result = redeem(&coupon, 50, 500, 1, &receipt);
        assert_eq!(result, Err(CouponError::InvalidSignature));
    }

    #[test]
    fn test_coupon_fields_correct() {
        let kp = test_keypair();
        let receipt = default_receipt();
        let coupon = issue(&kp, 16, 1500, 300_000, 2, 200, receipt);
        assert_eq!(coupon.max_cu_price_lamports, 1500);
        assert_eq!(coupon.max_cu_limit, 300_000);
        assert_eq!(coupon.route_class, 2);
        assert_eq!(coupon.expires_at_slot, 200);
        assert_eq!(coupon.receipt_hash_binding, receipt);
    }

    #[test]
    fn test_different_nonce_different_coupon_id() {
        let kp = test_keypair();
        let receipt = default_receipt();
        let c1 = issue(&kp, 20, 1000, 200_000, 1, 100, receipt);
        let c2 = issue(&kp, 21, 1000, 200_000, 1, 100, receipt);
        assert_ne!(c1.id, c2.id);
    }

    #[test]
    fn test_wrong_receipt_correct_slot_fails() {
        let kp = test_keypair();
        let receipt = default_receipt();
        let coupon = issue(&kp, 22, 1000, 200_000, 1, 100, receipt);
        let result = redeem(&coupon, 50, 500, 1, &[0x00u8; 32]);
        assert_eq!(result, Err(CouponError::WrongReceiptBinding));
    }
}
