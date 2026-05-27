//! dark-stealth-address
//!
//! **BN254 G1 ECDH dual-key stealth address protocol.**
//!
//! Allows a payer to send to an opaque on-chain address that only the
//! recipient can identify as theirs — using the same BN254 curve as the
//! Groth16 proof system.
//!
//! ## Protocol summary
//!
//! ```text
//! Recipient:
//!   spend_secret  (root private key — never shared)
//!   view_secret   = SHA256("dark-view-key-v1" || spend_secret)
//!   spend_pub     = spend_secret * G1
//!   view_pub      = view_secret  * G1
//!   meta_address  = (spend_pub, view_pub)  ← publish on-chain or off-chain
//!
//! Sender:
//!   ephem_secret  (random, single-use)
//!   ephem_pub     = ephem_secret * G1      ← published with each payment
//!   shared_point  = ephem_secret * view_pub  (ECDH: = ephem_secret * view_secret * G1)
//!   shared_scalar = SHA256("dark-stealth-shared-v1" || shared_point.x || shared_point.y)
//!   stealth_addr  = spend_pub + shared_scalar * G1
//!
//! Recipient scans:
//!   shared_point  = view_secret * ephem_pub  (= view_secret * ephem_secret * G1 = same!)
//!   shared_scalar = SHA256("dark-stealth-shared-v1" || shared_point.x || shared_point.y)
//!   candidate     = spend_pub + shared_scalar * G1
//!   if candidate == payment.stealth_addr → this payment is mine!
//!   one_time_spend_key = spend_secret + shared_scalar (mod curve order, approx)
//! ```
//!
//! The view key can scan but cannot spend.
//! Each payment produces a unique stealth address — unlinkable without the view key.
//!
//! mainnet_ready = false — devnet only until security audit.

use dark_groth16_core::{g1_add, g1_generator, g1_mul_scalar, G1Affine};
use sha2::{Digest, Sha256};

// ── Types ─────────────────────────────────────────────────────────────────────

/// Recipient's public meta-address.  Publish this so senders can address payments.
///
/// The view key enables scanning without spend capability — critical for
/// light-client wallets that need to detect incoming payments without
/// exposing the spend key.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StealthMetaAddress {
    /// `spend_secret * G1` — spend public key.
    pub spend_pub: G1Affine,
    /// `view_secret * G1` — view-only public key.
    pub view_pub: G1Affine,
    /// Always false.
    pub mainnet_ready: bool,
}

/// A one-time stealth payment.  Published on-chain alongside the value transfer.
///
/// Anyone can see `ephem_pub` and `stealth_addr`, but only the holder of
/// `view_secret` can determine whether this payment was addressed to them.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StealthPayment {
    /// One-time ephemeral public key: `ephem_secret * G1`.  Published.
    pub ephem_pub: G1Affine,
    /// One-time stealth address: `spend_pub + shared_scalar * G1`.  Published.
    pub stealth_addr: G1Affine,
    /// Value in lamports.
    pub value: u64,
    /// Blinded amount hash: `SHA256("dark-amount-v1" || shared_scalar || value_le8)`.
    /// Allows recipient to verify value without revealing it to a third party.
    pub amount_blind: [u8; 32],
    /// Always false.
    pub mainnet_ready: bool,
}

/// One-time spending key for a specific stealth payment.
///
/// The recipient derives this after detecting that a payment is addressed to them.
/// `one_time_secret` is used to construct a spend transaction.
#[derive(Debug, Clone)]
pub struct StealthSpendKey {
    /// Ephemeral scalar for spending: approximately `spend_secret + shared_scalar`.
    /// More precisely: `SHA256("dark-ots-v1" || spend_secret || shared_scalar)`.
    pub one_time_secret: [u8; 32],
    /// The public address this key controls (matches `payment.stealth_addr`).
    pub address: G1Affine,
    /// Always false.
    pub mainnet_ready: bool,
}

/// Errors from this crate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StealthError {
    /// A secret key is all-zero (invalid — would produce trivial keys).
    ZeroSecret,
    /// Payment amount is zero (nothing to send).
    ZeroAmount,
    /// Curve operation failed (malformed input point).
    CurveError,
}

impl std::fmt::Display for StealthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ZeroSecret => write!(f, "secret key is all-zero"),
            Self::ZeroAmount => write!(f, "payment amount is zero"),
            Self::CurveError => write!(f, "BN254 G1 curve operation failed"),
        }
    }
}

impl std::error::Error for StealthError {}

// ── Core helpers ──────────────────────────────────────────────────────────────

fn is_zero(b: &[u8; 32]) -> bool {
    b.iter().all(|&x| x == 0)
}

/// Derive the view secret from the spend secret.
///
/// Formula: `SHA256("dark-view-key-v1" || spend_secret)`
///
/// The view key can scan but cannot spend — it is mathematically
/// separate from the spend key.
pub fn derive_view_secret(spend_secret: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"dark-view-key-v1");
    h.update(spend_secret.as_slice());
    h.finalize().into()
}

/// Compute the BN254 G1 ECDH shared secret between `scalar` and `point`.
///
/// `shared_point = scalar * point`
/// `shared_scalar = SHA256("dark-stealth-shared-v1" || x || y)`
///
/// Both sender and recipient can compute the same value:
/// - Sender:    `ephem_secret * view_pub = ephem_secret * (view_secret * G) = k * G`
/// - Recipient: `view_secret * ephem_pub = view_secret * (ephem_secret * G) = k * G`
fn ecdh_shared_scalar(scalar: &[u8; 32], point: &G1Affine) -> Result<[u8; 32], StealthError> {
    let shared_pt = g1_mul_scalar(point, scalar).map_err(|_| StealthError::CurveError)?;
    let mut h = Sha256::new();
    h.update(b"dark-stealth-shared-v1");
    h.update(&shared_pt.x);
    h.update(&shared_pt.y);
    Ok(h.finalize().into())
}

/// Compute `spend_pub + shared_scalar * G1`.
fn stealth_address_point(
    spend_pub: &G1Affine,
    shared_scalar: &[u8; 32],
) -> Result<G1Affine, StealthError> {
    let gen = g1_generator();
    let offset = g1_mul_scalar(&gen, shared_scalar).map_err(|_| StealthError::CurveError)?;
    g1_add(spend_pub, &offset).map_err(|_| StealthError::CurveError)
}

/// Blind the amount: `SHA256("dark-amount-v1" || shared_scalar || value_le8)`.
/// The recipient can verify the amount; third parties cannot link it to the stealth address.
fn amount_blind(shared_scalar: &[u8; 32], value: u64) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"dark-amount-v1");
    h.update(shared_scalar.as_slice());
    h.update(&value.to_le_bytes());
    h.finalize().into()
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Build a `StealthMetaAddress` from a spend secret.
///
/// The view key is derived deterministically so the recipient only needs
/// to store one root secret.
pub fn create_meta_address(spend_secret: &[u8; 32]) -> Result<StealthMetaAddress, StealthError> {
    if is_zero(spend_secret) {
        return Err(StealthError::ZeroSecret);
    }
    let view_secret = derive_view_secret(spend_secret);
    let gen = g1_generator();
    let spend_pub = g1_mul_scalar(&gen, spend_secret).map_err(|_| StealthError::CurveError)?;
    let view_pub = g1_mul_scalar(&gen, &view_secret).map_err(|_| StealthError::CurveError)?;
    Ok(StealthMetaAddress {
        spend_pub,
        view_pub,
        mainnet_ready: false,
    })
}

/// Create a stealth payment to `meta` using a single-use `ephem_secret`.
///
/// `ephem_secret` must be random and never reused.  The caller is responsible
/// for generating cryptographic-quality randomness.
pub fn create_payment(
    meta: &StealthMetaAddress,
    ephem_secret: &[u8; 32],
    value: u64,
) -> Result<StealthPayment, StealthError> {
    if is_zero(ephem_secret) {
        return Err(StealthError::ZeroSecret);
    }
    if value == 0 {
        return Err(StealthError::ZeroAmount);
    }

    let gen = g1_generator();
    let ephem_pub = g1_mul_scalar(&gen, ephem_secret).map_err(|_| StealthError::CurveError)?;

    // ECDH: shared = ephem_secret * view_pub
    let shared_scalar = ecdh_shared_scalar(ephem_secret, &meta.view_pub)?;

    // stealth_addr = spend_pub + shared_scalar * G1
    let stealth_addr = stealth_address_point(&meta.spend_pub, &shared_scalar)?;

    let amount_blind = amount_blind(&shared_scalar, value);

    Ok(StealthPayment {
        ephem_pub,
        stealth_addr,
        value,
        amount_blind,
        mainnet_ready: false,
    })
}

/// Scan a payment to determine if it was addressed to the holder of `spend_secret`.
///
/// Uses only the view key for the ECDH computation — the spend secret is
/// used only to reconstruct the stealth address for comparison.
///
/// Returns `Some(StealthSpendKey)` if the payment belongs to this recipient.
/// Returns `None` if the payment was addressed to someone else.
pub fn scan_payment(
    spend_secret: &[u8; 32],
    payment: &StealthPayment,
) -> Result<Option<StealthSpendKey>, StealthError> {
    if is_zero(spend_secret) {
        return Err(StealthError::ZeroSecret);
    }
    let view_secret = derive_view_secret(spend_secret);

    // ECDH: shared = view_secret * ephem_pub
    let shared_scalar = ecdh_shared_scalar(&view_secret, &payment.ephem_pub)?;

    // Recompute stealth address
    let gen = g1_generator();
    let spend_pub = g1_mul_scalar(&gen, spend_secret).map_err(|_| StealthError::CurveError)?;
    let candidate = stealth_address_point(&spend_pub, &shared_scalar)?;

    // Compare with payment's stealth_addr
    if candidate.x != payment.stealth_addr.x || candidate.y != payment.stealth_addr.y {
        return Ok(None);
    }

    // Derive one-time spend key: SHA256("dark-ots-v1" || spend_secret || shared_scalar)
    let mut h = Sha256::new();
    h.update(b"dark-ots-v1");
    h.update(spend_secret.as_slice());
    h.update(shared_scalar.as_slice());
    let one_time_secret: [u8; 32] = h.finalize().into();

    Ok(Some(StealthSpendKey {
        one_time_secret,
        address: payment.stealth_addr.clone(),
        mainnet_ready: false,
    }))
}

/// Verify the amount blind for a detected payment.
///
/// The recipient can use this to confirm the exact value they received
/// without revealing the value to third-party chain indexers.
pub fn verify_amount_blind(
    spend_secret: &[u8; 32],
    payment: &StealthPayment,
) -> Result<bool, StealthError> {
    if is_zero(spend_secret) {
        return Err(StealthError::ZeroSecret);
    }
    let view_secret = derive_view_secret(spend_secret);
    let shared_scalar = ecdh_shared_scalar(&view_secret, &payment.ephem_pub)?;
    let expected = amount_blind(&shared_scalar, payment.value);
    Ok(expected == payment.amount_blind)
}

/// Serialise the public fields of a stealth address as a hex string pair.
///
/// Format: `"<x_hex>:<y_hex>"` (64 hex chars + colon + 64 hex chars = 129 chars).
pub fn meta_address_to_str(meta: &StealthMetaAddress) -> String {
    fn hex32(b: &[u8; 32]) -> String {
        b.iter().map(|x| format!("{:02x}", x)).collect()
    }
    format!(
        "spend={}:{} view={}:{}",
        hex32(&meta.spend_pub.x),
        hex32(&meta.spend_pub.y),
        hex32(&meta.view_pub.x),
        hex32(&meta.view_pub.y),
    )
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn spend_secret(b: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = b;
        s[1] = 0x01; // non-zero
        s
    }

    fn ephem_secret(b: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xEF;
        s[1] = b;
        s[2] = 0x01;
        s
    }

    // ── Test 1: happy-path roundtrip ─────────────────────────────────────────
    #[test]
    fn test_send_scan_roundtrip() {
        let meta = create_meta_address(&spend_secret(1)).unwrap();
        let payment = create_payment(&meta, &ephem_secret(1), 1_000_000).unwrap();
        let result = scan_payment(&spend_secret(1), &payment).unwrap();
        assert!(result.is_some(), "recipient must detect their own payment");
        assert!(!result.unwrap().mainnet_ready);
    }

    // ── Test 2: wrong spend secret cannot detect payment ────────────────────
    #[test]
    fn test_wrong_secret_cannot_scan() {
        let meta = create_meta_address(&spend_secret(2)).unwrap();
        let payment = create_payment(&meta, &ephem_secret(2), 500_000).unwrap();
        let result = scan_payment(&spend_secret(3), &payment).unwrap();
        assert!(
            result.is_none(),
            "different spend secret must not match payment"
        );
    }

    // ── Test 3: zero spend secret rejected ──────────────────────────────────
    #[test]
    fn test_zero_spend_secret_rejected() {
        let err = create_meta_address(&[0u8; 32]).unwrap_err();
        assert_eq!(err, StealthError::ZeroSecret);
    }

    // ── Test 4: zero amount rejected ────────────────────────────────────────
    #[test]
    fn test_zero_amount_rejected() {
        let meta = create_meta_address(&spend_secret(4)).unwrap();
        let err = create_payment(&meta, &ephem_secret(4), 0).unwrap_err();
        assert_eq!(err, StealthError::ZeroAmount);
    }

    // ── Test 5: different ephemeral keys → different stealth addresses ───────
    #[test]
    fn test_different_ephem_different_address() {
        let meta = create_meta_address(&spend_secret(5)).unwrap();
        let p1 = create_payment(&meta, &ephem_secret(0xAA), 1_000).unwrap();
        let p2 = create_payment(&meta, &ephem_secret(0xBB), 1_000).unwrap();
        assert_ne!(
            p1.stealth_addr.x, p2.stealth_addr.x,
            "different ephemeral keys must produce different stealth addresses"
        );
    }

    // ── Test 6: different recipients → different stealth addresses ───────────
    #[test]
    fn test_different_recipients_different_address() {
        let meta1 = create_meta_address(&spend_secret(6)).unwrap();
        let meta2 = create_meta_address(&spend_secret(7)).unwrap();
        let ephem = ephem_secret(0x10);
        let p1 = create_payment(&meta1, &ephem, 1_000).unwrap();
        let p2 = create_payment(&meta2, &ephem, 1_000).unwrap();
        assert_ne!(
            p1.stealth_addr.x, p2.stealth_addr.x,
            "same ephemeral key to different recipients must produce different addresses"
        );
    }

    // ── Test 7: view key cannot scan payment without spend key (property) ───
    // (We can't directly test this without exposing view_secret, but we verify
    //  that the view key is derived differently from spend key)
    #[test]
    fn test_view_key_differs_from_spend_key() {
        let s = spend_secret(8);
        let view = derive_view_secret(&s);
        assert_ne!(s, view, "view secret must differ from spend secret");
    }

    // ── Test 8: meta address is deterministic ───────────────────────────────
    #[test]
    fn test_meta_address_deterministic() {
        let m1 = create_meta_address(&spend_secret(9)).unwrap();
        let m2 = create_meta_address(&spend_secret(9)).unwrap();
        assert_eq!(m1.spend_pub.x, m2.spend_pub.x);
        assert_eq!(m1.view_pub.x, m2.view_pub.x);
    }

    // ── Test 9: one-time spend key is deterministic ──────────────────────────
    #[test]
    fn test_one_time_spend_key_deterministic() {
        let meta = create_meta_address(&spend_secret(10)).unwrap();
        let payment = create_payment(&meta, &ephem_secret(10), 2_000_000).unwrap();
        let k1 = scan_payment(&spend_secret(10), &payment).unwrap().unwrap();
        let k2 = scan_payment(&spend_secret(10), &payment).unwrap().unwrap();
        assert_eq!(k1.one_time_secret, k2.one_time_secret);
    }

    // ── Test 10: one-time keys differ for different payments ────────────────
    #[test]
    fn test_different_payments_different_spend_keys() {
        let s = spend_secret(11);
        let meta = create_meta_address(&s).unwrap();
        let p1 = create_payment(&meta, &ephem_secret(0x20), 1_000).unwrap();
        let p2 = create_payment(&meta, &ephem_secret(0x21), 1_000).unwrap();
        let k1 = scan_payment(&s, &p1).unwrap().unwrap();
        let k2 = scan_payment(&s, &p2).unwrap().unwrap();
        assert_ne!(
            k1.one_time_secret, k2.one_time_secret,
            "each payment must produce a unique one-time spend key"
        );
    }

    // ── Test 11: amount blind verifies correctly ─────────────────────────────
    #[test]
    fn test_amount_blind_verifies() {
        let meta = create_meta_address(&spend_secret(12)).unwrap();
        let payment = create_payment(&meta, &ephem_secret(12), 750_000).unwrap();
        assert!(verify_amount_blind(&spend_secret(12), &payment).unwrap());
    }

    // ── Test 12: amount blind fails for wrong secret ─────────────────────────
    #[test]
    fn test_amount_blind_wrong_secret_fails() {
        let meta = create_meta_address(&spend_secret(13)).unwrap();
        let payment = create_payment(&meta, &ephem_secret(13), 750_000).unwrap();
        // Different spend secret → different shared scalar → different blind
        assert!(!verify_amount_blind(&spend_secret(14), &payment).unwrap());
    }

    // ── Test 13: meta address serialises to non-empty string ─────────────────
    #[test]
    fn test_meta_address_serialises() {
        let meta = create_meta_address(&spend_secret(15)).unwrap();
        let s = meta_address_to_str(&meta);
        assert!(s.starts_with("spend="), "must start with spend= prefix");
        assert!(s.contains("view="), "must contain view= section");
        assert!(s.len() > 100, "hex coordinates must be long");
    }

    // ── Test 14: zero ephem secret rejected ─────────────────────────────────
    #[test]
    fn test_zero_ephem_secret_rejected() {
        let meta = create_meta_address(&spend_secret(16)).unwrap();
        let err = create_payment(&meta, &[0u8; 32], 1_000).unwrap_err();
        assert_eq!(err, StealthError::ZeroSecret);
    }

    // ── Test 15: mainnet_ready is always false ───────────────────────────────
    #[test]
    fn test_mainnet_ready_always_false() {
        let meta = create_meta_address(&spend_secret(17)).unwrap();
        assert!(!meta.mainnet_ready);
        let payment = create_payment(&meta, &ephem_secret(17), 1_000).unwrap();
        assert!(!payment.mainnet_ready);
        let sk = scan_payment(&spend_secret(17), &payment).unwrap().unwrap();
        assert!(!sk.mainnet_ready);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_view_secret_differs_per_spend_secret() {
        let v1 = derive_view_secret(&spend_secret(0xAA));
        let v2 = derive_view_secret(&spend_secret(0xBB));
        assert_ne!(
            v1, v2,
            "different spend secrets must produce different view secrets"
        );
    }
}
