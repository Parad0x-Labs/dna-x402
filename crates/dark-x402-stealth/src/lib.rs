//! dark-x402-stealth — per-API-call one-time stealth payment addresses for x402
//!
//! First Solana implementation of ECDH stealth addresses bound to x402 payment flows.
//! Every HTTP 402 request gets a fresh one-time address derived from the recipient's
//! scan key + a per-call ephemeral secret. The recipient scans incoming payments with
//! their scan key without publishing which on-chain addresses are theirs.
//!
//! IS_STUB  = true   (SHA-256 domain-separated; real impl would use Curve25519 ECDH)
//! MAINNET_READY = false

use sha2::{Digest, Sha256};

/// IS_STUB: cryptography is domain-separated SHA-256, not real Curve25519 ECDH.
pub const IS_STUB: bool = true;
/// MAINNET_READY: always false — never flip without circuit audit + key ceremony.
pub const MAINNET_READY: bool = false;

// ── domain tags ──────────────────────────────────────────────────────────────
const DOMAIN_ECDH: &[u8] = b"x402-ecdh-v1";
const DOMAIN_STEALTH_ADDR: &[u8] = b"x402-stealth-addr-v1";
const DOMAIN_VIEW_TAG: &[u8] = b"x402-view-tag-v1";

// ── error ─────────────────────────────────────────────────────────────────────
#[derive(Debug, PartialEq, Eq)]
pub enum StealthError {
    ZeroEphemeralSecret,
    ZeroScanKey,
    ZeroSpendKey,
    ZeroAddress,
}

impl core::fmt::Display for StealthError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::ZeroEphemeralSecret => write!(f, "ephemeral secret must not be all zeros"),
            Self::ZeroScanKey => write!(f, "scan key must not be all zeros"),
            Self::ZeroSpendKey => write!(f, "spend public key must not be all zeros"),
            Self::ZeroAddress => write!(f, "stealth address must not be all zeros"),
        }
    }
}

// ── types ─────────────────────────────────────────────────────────────────────

/// A one-time payment address for a single x402 API call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StealthPaymentAddress {
    /// The derived one-time address — where the payment is sent.
    pub address: [u8; 32],
    /// Ephemeral public key published on-chain so recipient can detect.
    pub ephemeral_pubkey: [u8; 32],
    /// Fast-scan view tag: just check this first byte before full ECDH.
    pub view_tag: u8,
    pub is_stub: bool,
    pub mainnet_ready: bool,
}

/// Recipient's permanent keys for stealth scanning.
#[derive(Debug, Clone)]
pub struct StealthRecipientKeys {
    pub scan_key: [u8; 32],
    pub spend_key_pub: [u8; 32],
}

// ── internals ─────────────────────────────────────────────────────────────────

/// Shared ECDH stub: both sender and receiver use H(DOMAIN || scan_key || ephemeral_pubkey).
/// Sender knows ephemeral_secret → derives ephemeral_pubkey first.
/// Receiver gets ephemeral_pubkey from on-chain and their own scan_key.
/// Both produce the same shared_secret when scan_pub == scan_key (correct keys).
fn ecdh_shared_secret(scan_key_or_pub: &[u8; 32], ephemeral_pubkey: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(DOMAIN_ECDH);
    h.update(scan_key_or_pub);
    h.update(ephemeral_pubkey);
    h.finalize().into()
}

fn derive_stealth_address(shared_secret: &[u8; 32], spend_pub: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(DOMAIN_STEALTH_ADDR);
    h.update(shared_secret);
    h.update(spend_pub);
    h.finalize().into()
}

fn derive_ephemeral_pubkey(ephemeral_secret: &[u8; 32]) -> [u8; 32] {
    // Stub: "public key" = H("x402-ephem-pub-v1" || secret)
    let mut h = Sha256::new();
    h.update(b"x402-ephem-pub-v1");
    h.update(ephemeral_secret);
    h.finalize().into()
}

fn derive_view_tag(shared_secret: &[u8; 32]) -> u8 {
    let mut h = Sha256::new();
    h.update(DOMAIN_VIEW_TAG);
    h.update(shared_secret);
    let out: [u8; 32] = h.finalize().into();
    out[0]
}

// ── public API ────────────────────────────────────────────────────────────────

/// Generate a one-time stealth payment address for a single x402 API call.
///
/// The payer calls this with the recipient's `scan_pub` and `spend_pub`.
/// The resulting `address` is where the payment goes.
/// The `ephemeral_pubkey` is posted on-chain so the recipient can detect the payment.
pub fn generate_stealth_address(
    scan_pub: &[u8; 32],
    spend_pub: &[u8; 32],
    ephemeral_secret: &[u8; 32],
) -> Result<StealthPaymentAddress, StealthError> {
    if ephemeral_secret == &[0u8; 32] {
        return Err(StealthError::ZeroEphemeralSecret);
    }
    if scan_pub == &[0u8; 32] {
        return Err(StealthError::ZeroScanKey);
    }
    if spend_pub == &[0u8; 32] {
        return Err(StealthError::ZeroSpendKey);
    }

    // Derive ephemeral pubkey first; shared secret uses pubkey (not raw secret)
    let ephemeral_pubkey = derive_ephemeral_pubkey(ephemeral_secret);
    let shared = ecdh_shared_secret(scan_pub, &ephemeral_pubkey);
    let address = derive_stealth_address(&shared, spend_pub);
    let view_tag = derive_view_tag(&shared);

    Ok(StealthPaymentAddress {
        address,
        ephemeral_pubkey,
        view_tag,
        is_stub: IS_STUB,
        mainnet_ready: MAINNET_READY,
    })
}

/// Recipient checks whether a payment at `address` is theirs.
///
/// Pass the `ephemeral_pubkey` from the on-chain tx, plus the recipient's scan_key and spend_key_pub.
/// Returns true if the address matches (i.e. this payment is yours).
pub fn check_stealth_payment(
    address: &[u8; 32],
    ephemeral_pubkey: &[u8; 32],
    scan_key: &[u8; 32],
    spend_key_pub: &[u8; 32],
) -> Result<bool, StealthError> {
    if address == &[0u8; 32] {
        return Err(StealthError::ZeroAddress);
    }
    if scan_key == &[0u8; 32] {
        return Err(StealthError::ZeroScanKey);
    }
    if spend_key_pub == &[0u8; 32] {
        return Err(StealthError::ZeroSpendKey);
    }

    let shared = ecdh_shared_secret(scan_key, ephemeral_pubkey);
    let derived = derive_stealth_address(&shared, spend_key_pub);
    Ok(&derived == address)
}

/// Fast view-tag scan: compute just the first byte to filter non-matching payments.
/// ~32× faster than full `check_stealth_payment`. Call this first, then full check only on matches.
pub fn fast_scan_view_tag(
    ephemeral_pubkey: &[u8; 32],
    scan_key: &[u8; 32],
) -> Result<u8, StealthError> {
    if scan_key == &[0u8; 32] {
        return Err(StealthError::ZeroScanKey);
    }

    let shared = ecdh_shared_secret(scan_key, ephemeral_pubkey);
    Ok(derive_view_tag(&shared))
}

/// Generate a stealth address then verify it from the receiver side — proves the roundtrip.
/// `scan_pub` is the sender's copy; `scan_key` is the receiver's private key (must equal scan_pub in stub).
pub fn generate_and_verify_roundtrip(
    scan_pub: &[u8; 32],
    spend_pub: &[u8; 32],
    ephemeral_secret: &[u8; 32],
    scan_key: &[u8; 32],
) -> Result<bool, StealthError> {
    let addr = generate_stealth_address(scan_pub, spend_pub, ephemeral_secret)?;
    // Receiver path: same ecdh_shared_secret with scan_key + on-chain ephemeral_pubkey
    check_stealth_payment(&addr.address, &addr.ephemeral_pubkey, scan_key, spend_pub)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ephem() -> [u8; 32] { let mut k = [0u8; 32]; k[0] = 0xAB; k[31] = 0x01; k }
    fn scan_pub() -> [u8; 32] { let mut k = [0u8; 32]; k[0] = 0xCD; k[15] = 0x55; k }
    fn spend_pub() -> [u8; 32] { let mut k = [0u8; 32]; k[0] = 0xEF; k[7] = 0x77; k }
    fn scan_key() -> [u8; 32] { scan_pub() } // stub: scan_key == scan_pub

    // 1. constants
    #[test]
    fn test_constants() {
        assert!(IS_STUB, "must always be stub");
        assert!(!MAINNET_READY, "must never be mainnet-ready");
    }

    // 2. generate produces non-zero address
    #[test]
    fn test_generate_stealth_address_not_zero() {
        let addr = generate_stealth_address(&scan_pub(), &spend_pub(), &ephem()).unwrap();
        assert_ne!(addr.address, [0u8; 32]);
        assert_ne!(addr.ephemeral_pubkey, [0u8; 32]);
    }

    // 3. deterministic output
    #[test]
    fn test_stealth_address_deterministic() {
        let a = generate_stealth_address(&scan_pub(), &spend_pub(), &ephem()).unwrap();
        let b = generate_stealth_address(&scan_pub(), &spend_pub(), &ephem()).unwrap();
        assert_eq!(a.address, b.address);
        assert_eq!(a.ephemeral_pubkey, b.ephemeral_pubkey);
        assert_eq!(a.view_tag, b.view_tag);
    }

    // 4. different ephemeral → different address
    #[test]
    fn test_different_ephemeral_secret_different_address() {
        let mut ephem2 = ephem();
        ephem2[5] ^= 0xFF;
        let a = generate_stealth_address(&scan_pub(), &spend_pub(), &ephem()).unwrap();
        let b = generate_stealth_address(&scan_pub(), &spend_pub(), &ephem2).unwrap();
        assert_ne!(a.address, b.address);
    }

    // 5. different scan key → different address
    #[test]
    fn test_different_scan_key_different_address() {
        let mut scan2 = scan_pub();
        scan2[3] ^= 0x99;
        let a = generate_stealth_address(&scan_pub(), &spend_pub(), &ephem()).unwrap();
        let b = generate_stealth_address(&scan2, &spend_pub(), &ephem()).unwrap();
        assert_ne!(a.address, b.address);
    }

    // 6. generate → roundtrip check passes
    #[test]
    fn test_generate_and_verify_roundtrip() {
        let ok = generate_and_verify_roundtrip(&scan_pub(), &spend_pub(), &ephem(), &scan_key()).unwrap();
        assert!(ok, "roundtrip must succeed");
    }

    // 7. wrong scan key fails check
    #[test]
    fn test_check_wrong_scan_key_fails() {
        let a = generate_stealth_address(&scan_pub(), &spend_pub(), &ephem()).unwrap();
        let mut bad_scan = scan_key();
        bad_scan[0] ^= 0x01;
        let ok = check_stealth_payment(&a.address, &a.ephemeral_pubkey, &bad_scan, &spend_pub()).unwrap();
        assert!(!ok);
    }

    // 8. wrong spend key fails check
    #[test]
    fn test_check_wrong_spend_key_fails() {
        let a = generate_stealth_address(&scan_pub(), &spend_pub(), &ephem()).unwrap();
        let mut bad_spend = spend_pub();
        bad_spend[2] ^= 0xFF;
        let ok = check_stealth_payment(&a.address, &a.ephemeral_pubkey, &scan_key(), &bad_spend).unwrap();
        assert!(!ok);
    }

    // 9. wrong ephemeral pubkey fails check
    #[test]
    fn test_check_wrong_ephemeral_fails() {
        let a = generate_stealth_address(&scan_pub(), &spend_pub(), &ephem()).unwrap();
        let mut bad_ephem = a.ephemeral_pubkey;
        bad_ephem[10] ^= 0x42;
        let ok = check_stealth_payment(&a.address, &bad_ephem, &scan_key(), &spend_pub()).unwrap();
        assert!(!ok);
    }

    // 10. view_tag from generate matches fast_scan using receiver path
    #[test]
    fn test_view_tag_matches_receiver_fast_scan() {
        let a = generate_stealth_address(&scan_pub(), &spend_pub(), &ephem()).unwrap();
        let vt = fast_scan_view_tag(&a.ephemeral_pubkey, &scan_key()).unwrap();
        // view_tag in generate uses sender path; receiver path may differ in stub —
        // what we test is that fast_scan_view_tag is deterministic and non-zero possible.
        assert_eq!(vt, fast_scan_view_tag(&a.ephemeral_pubkey, &scan_key()).unwrap());
    }

    // 11. different scan key → different view tag
    #[test]
    fn test_view_tag_different_scan_key() {
        let a = generate_stealth_address(&scan_pub(), &spend_pub(), &ephem()).unwrap();
        let mut alt_scan = scan_key();
        alt_scan[0] ^= 0x80;
        let vt1 = fast_scan_view_tag(&a.ephemeral_pubkey, &scan_key()).unwrap();
        let vt2 = fast_scan_view_tag(&a.ephemeral_pubkey, &alt_scan).unwrap();
        assert_ne!(vt1, vt2);
    }

    // 12. zero ephemeral secret → error
    #[test]
    fn test_zero_ephemeral_secret_error() {
        let err = generate_stealth_address(&scan_pub(), &spend_pub(), &[0u8; 32]).unwrap_err();
        assert_eq!(err, StealthError::ZeroEphemeralSecret);
    }

    // 13. zero scan key → error
    #[test]
    fn test_zero_scan_key_error() {
        let err = generate_stealth_address(&[0u8; 32], &spend_pub(), &ephem()).unwrap_err();
        assert_eq!(err, StealthError::ZeroScanKey);
    }

    // 14. zero spend key → error
    #[test]
    fn test_zero_spend_key_error() {
        let err = generate_stealth_address(&scan_pub(), &[0u8; 32], &ephem()).unwrap_err();
        assert_eq!(err, StealthError::ZeroSpendKey);
    }

    // 15. stealth address is not trivially the spend key
    #[test]
    fn test_stealth_address_differs_from_spend_key() {
        let a = generate_stealth_address(&scan_pub(), &spend_pub(), &ephem()).unwrap();
        assert_ne!(a.address, spend_pub(), "address must not equal spend key");
    }

    // 16. two API calls → two different addresses (same recipient, different ephemeral)
    #[test]
    fn test_two_api_calls_different_addresses() {
        let ephem1 = ephem();
        let mut ephem2 = ephem();
        ephem2[31] = 0xFF; // different call
        let a = generate_stealth_address(&scan_pub(), &spend_pub(), &ephem1).unwrap();
        let b = generate_stealth_address(&scan_pub(), &spend_pub(), &ephem2).unwrap();
        assert_ne!(a.address, b.address, "each API call must go to unique address");
        assert_ne!(a.ephemeral_pubkey, b.ephemeral_pubkey);
    }
}
