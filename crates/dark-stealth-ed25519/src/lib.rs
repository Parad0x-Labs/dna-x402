//! dark-stealth-ed25519 — NullPay stealth addresses on the ed25519 / edwards25519 curve.
//!
//! **Pay a `.null` name; funds land on a one-time NATIVE Solana ed25519 address
//! that only the recipient can spend — and that cannot be linked back to the
//! recipient's main wallet.**  No ZK, no trusted setup, native Solana signing.
//!
//! ## Why ed25519 (not the BN254 variant in `dark-stealth-address`)
//!
//! The one-time stealth address `P` here is a real 32-byte edwards25519 point —
//! i.e. a normal Solana pubkey.  The recipient derives a one-time **scalar**
//! `p` such that `p·B == P`, and signs the sweep transaction with `p` using
//! standard EdDSA.  Solana's runtime verifies that signature with stock
//! ed25519 — there is no special program, no proof, no setup.  (The sibling
//! BN254 crate derives a *hashed* one-time secret, which is fine for an opaque
//! commitment but is **not** a curve key you can natively sign Solana txs with.)
//!
//! ## Protocol
//!
//! ```text
//! B = ed25519 basepoint, L = group order (2^252 + 27742...).
//!
//! Recipient (dual key):
//!   s  = spend scalar (root secret, never shared)         S = s·B   (spend pub)
//!   v  = view  scalar (derived from s, shareable to scan) V = v·B   (view  pub)
//!   meta-address = (S, V) = 64 bytes, published on-chain per .null name.
//!
//! Sender (per payment):
//!   r  = random ephemeral scalar                          R = r·B   (published)
//!   shared = H_scalar( (r·V) )            // ECDH point r·V = r·v·B
//!   P = S + shared·B                       // one-time STEALTH pubkey (32B, native)
//!   ...send funds to P, publish R alongside.
//!
//! Recipient scans (view key only):
//!   shared' = H_scalar( (v·R) )           // v·R = v·r·B = r·V  -> same shared
//!   P'      = S + shared'·B
//!   if P' == P  ->  "this payment is mine"
//!
//! Recipient recovers + spends (needs spend key):
//!   p = (s + shared) mod L                 // one-time STEALTH scalar
//!   check p·B == P, then EdDSA-sign the sweep tx with p. Verifies natively under P.
//! ```
//!
//! Only a holder of the **view** key can recognise `P`; only a holder of the
//! **spend** key can produce `p` and move the funds.  A passive observer sees a
//! transfer to a fresh, unlinkable `P` and a random `R`.
//!
//! ## Honest scope
//! - `mainnet_ready = false` throughout — devnet / library only, unaudited.
//! - This hides the **recipient**.  A sender paying from a funded main wallet is
//!   still linkable as the *sender* — that is the job of a shielded pool / eNULL
//!   rail, not of stealth addressing.

use curve25519_dalek::constants::ED25519_BASEPOINT_TABLE;
use curve25519_dalek::edwards::{CompressedEdwardsY, EdwardsPoint};
use curve25519_dalek::scalar::Scalar;
use sha2::{Digest, Sha512};

// ── Domain-separation tags ─────────────────────────────────────────────────────
const TAG_VIEW: &[u8] = b"nullpay-ed25519-view-key-v1";
const TAG_SHARED: &[u8] = b"nullpay-ed25519-shared-v1";
const TAG_NONCE: &[u8] = b"nullpay-ed25519-sign-nonce-v1";

// ── Types ──────────────────────────────────────────────────────────────────────

/// Errors from this crate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StealthError {
    /// A secret scalar reduced to zero (degenerate key).
    ZeroScalar,
    /// A 32-byte buffer is not a canonical edwards25519 point.
    NotOnCurve,
    /// Derived scalar `p` did not satisfy `p·B == P` (internal invariant).
    KeyMismatch,
}

impl std::fmt::Display for StealthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ZeroScalar => write!(f, "secret scalar reduced to zero"),
            Self::NotOnCurve => write!(f, "bytes are not a canonical edwards25519 point"),
            Self::KeyMismatch => write!(f, "derived stealth scalar does not match stealth point"),
        }
    }
}
impl std::error::Error for StealthError {}

/// A recipient's root key pair: spend + view scalars and their public points.
///
/// The view scalar is derived from the spend scalar, so a recipient stores only
/// `spend_secret` (32 bytes) and can regenerate everything.
#[derive(Clone)]
pub struct RecipientKeys {
    spend: Scalar,
    view: Scalar,
    spend_pub: EdwardsPoint,
    view_pub: EdwardsPoint,
}

impl RecipientKeys {
    /// 32-byte little-endian spend scalar seed.
    pub fn spend_secret_bytes(&self) -> [u8; 32] {
        self.spend.to_bytes()
    }
    /// 32-byte little-endian view scalar (shareable for scanning).
    pub fn view_secret_bytes(&self) -> [u8; 32] {
        self.view.to_bytes()
    }
    /// The published 64-byte meta-address: `spend_pub || view_pub`.
    pub fn meta_address(&self) -> MetaAddress {
        MetaAddress {
            spend_pub: self.spend_pub.compress().to_bytes(),
            view_pub: self.view_pub.compress().to_bytes(),
            mainnet_ready: false,
        }
    }
}

/// A recipient's published meta-address: two compressed edwards25519 points.
///
/// Exactly 64 bytes on the wire (`spend_pub || view_pub`); this is what gets
/// stored in the `.null` domain record so any sender can address a payment.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct MetaAddress {
    /// Compressed `S = s·B`.
    pub spend_pub: [u8; 32],
    /// Compressed `V = v·B`.
    pub view_pub: [u8; 32],
    /// Always false (devnet / unaudited).
    pub mainnet_ready: bool,
}

impl MetaAddress {
    /// Pack to the canonical 64-byte on-chain layout `spend_pub || view_pub`.
    pub fn to_bytes(&self) -> [u8; 64] {
        let mut out = [0u8; 64];
        out[..32].copy_from_slice(&self.spend_pub);
        out[32..].copy_from_slice(&self.view_pub);
        out
    }
    /// Parse the 64-byte on-chain layout. Validates both points are on-curve.
    pub fn from_bytes(b: &[u8; 64]) -> Result<Self, StealthError> {
        let mut spend_pub = [0u8; 32];
        let mut view_pub = [0u8; 32];
        spend_pub.copy_from_slice(&b[..32]);
        view_pub.copy_from_slice(&b[32..]);
        // Reject anything not a canonical point.
        decompress(&spend_pub)?;
        decompress(&view_pub)?;
        Ok(Self { spend_pub, view_pub, mainnet_ready: false })
    }
}

/// A one-time stealth payment header, published alongside the value transfer.
///
/// `stealth_pub` is the NATIVE Solana address that received the funds; `ephem_pub`
/// (= `R`) is what lets the recipient (and only the recipient) recompute the
/// shared secret and recognise the payment.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct StealthPayment {
    /// Compressed one-time stealth pubkey `P = S + shared·B` — a real Solana address.
    pub stealth_pub: [u8; 32],
    /// Compressed ephemeral pubkey `R = r·B` — published so the recipient can scan.
    pub ephem_pub: [u8; 32],
    /// Always false (devnet / unaudited).
    pub mainnet_ready: bool,
}

impl StealthPayment {
    /// The one-time stealth address as raw 32 bytes (Solana pubkey bytes).
    pub fn stealth_address(&self) -> [u8; 32] {
        self.stealth_pub
    }
}

/// The one-time spending material the recipient recovers after a scan match.
///
/// `secret` is the 32-byte little-endian scalar `p`; signing the sweep tx with
/// it produces a standard ed25519 signature that verifies under `stealth_pub`.
#[derive(Clone)]
pub struct StealthSpendKey {
    secret: Scalar,
    /// Compressed `P` this key controls (= `payment.stealth_pub`).
    pub stealth_pub: [u8; 32],
    /// Always false (devnet / unaudited).
    pub mainnet_ready: bool,
}

impl StealthSpendKey {
    /// 32-byte little-endian one-time stealth scalar `p`.
    pub fn secret_bytes(&self) -> [u8; 32] {
        self.secret.to_bytes()
    }
}

// ── Core helpers ────────────────────────────────────────────────────────────────

fn decompress(b: &[u8; 32]) -> Result<EdwardsPoint, StealthError> {
    CompressedEdwardsY(*b)
        .decompress()
        .ok_or(StealthError::NotOnCurve)
}

/// Hash an arbitrary point to a uniform scalar mod L (64-byte wide reduction).
fn point_to_scalar(tag: &[u8], point: &EdwardsPoint) -> Scalar {
    let mut h = Sha512::new();
    h.update(tag);
    h.update(point.compress().as_bytes());
    let digest = h.finalize();
    let mut wide = [0u8; 64];
    wide.copy_from_slice(&digest);
    Scalar::from_bytes_mod_order_wide(&wide)
}

/// Derive the view scalar deterministically from the spend scalar.
fn derive_view_scalar(spend: &Scalar) -> Scalar {
    let mut h = Sha512::new();
    h.update(TAG_VIEW);
    h.update(spend.as_bytes());
    let digest = h.finalize();
    let mut wide = [0u8; 64];
    wide.copy_from_slice(&digest);
    Scalar::from_bytes_mod_order_wide(&wide)
}

// ── Public API ───────────────────────────────────────────────────────────────────

/// Build a recipient key pair from 32 bytes of entropy (the spend seed).
///
/// The bytes are reduced mod L to a spend scalar; the view scalar is derived
/// deterministically.  The caller supplies cryptographic-quality randomness.
pub fn keygen(spend_seed: &[u8; 32]) -> Result<RecipientKeys, StealthError> {
    let spend = Scalar::from_bytes_mod_order(*spend_seed);
    if spend == Scalar::zero() {
        return Err(StealthError::ZeroScalar);
    }
    let view = derive_view_scalar(&spend);
    if view == Scalar::zero() {
        return Err(StealthError::ZeroScalar);
    }
    let spend_pub = &spend * &ED25519_BASEPOINT_TABLE;
    let view_pub = &view * &ED25519_BASEPOINT_TABLE;
    Ok(RecipientKeys { spend, view, spend_pub, view_pub })
}

/// SENDER: derive a one-time stealth address for `meta` using a single-use
/// ephemeral scalar seed.  Returns the published `StealthPayment` (`P` and `R`).
///
/// `ephem_seed` must be random and never reused.
pub fn derive(
    meta: &MetaAddress,
    ephem_seed: &[u8; 32],
) -> Result<StealthPayment, StealthError> {
    let r = Scalar::from_bytes_mod_order(*ephem_seed);
    if r == Scalar::zero() {
        return Err(StealthError::ZeroScalar);
    }
    let spend_pub = decompress(&meta.spend_pub)?;
    let view_pub = decompress(&meta.view_pub)?;

    let ephem_pub = &r * &ED25519_BASEPOINT_TABLE; // R = r·B
    let shared_point = r * view_pub; // r·V = r·v·B
    let shared = point_to_scalar(TAG_SHARED, &shared_point);

    // P = S + shared·B
    let stealth_pt = spend_pub + (&shared * &ED25519_BASEPOINT_TABLE);

    Ok(StealthPayment {
        stealth_pub: stealth_pt.compress().to_bytes(),
        ephem_pub: ephem_pub.compress().to_bytes(),
        mainnet_ready: false,
    })
}

/// RECIPIENT (view key only): test whether `payment` is addressed to `keys`.
///
/// Uses only the view scalar for the ECDH, plus the public spend point — it does
/// **not** touch the spend secret, so this is safe for a watch-only / scanning
/// wallet.  Returns the recomputed stealth address on a match, else `None`.
pub fn scan(keys: &RecipientKeys, payment: &StealthPayment) -> Result<Option<[u8; 32]>, StealthError> {
    let ephem_pub = decompress(&payment.ephem_pub)?;
    let shared_point = keys.view * ephem_pub; // v·R = v·r·B = r·V
    let shared = point_to_scalar(TAG_SHARED, &shared_point);
    let candidate = keys.spend_pub + (&shared * &ED25519_BASEPOINT_TABLE);
    if candidate.compress().to_bytes() == payment.stealth_pub {
        Ok(Some(payment.stealth_pub))
    } else {
        Ok(None)
    }
}

/// RECIPIENT (spend key): recover the one-time spending scalar `p` for a matched
/// payment.  `p = (s + shared) mod L`, where `shared` is recomputed from the
/// view scalar and `R`.  Verifies the invariant `p·B == P` before returning.
pub fn recover(keys: &RecipientKeys, payment: &StealthPayment) -> Result<StealthSpendKey, StealthError> {
    let ephem_pub = decompress(&payment.ephem_pub)?;
    let shared_point = keys.view * ephem_pub;
    let shared = point_to_scalar(TAG_SHARED, &shared_point);

    let p = keys.spend + shared; // (s + shared) mod L
    if p == Scalar::zero() {
        return Err(StealthError::ZeroScalar);
    }
    // Invariant: p·B must equal P.
    let p_pub = (&p * &ED25519_BASEPOINT_TABLE).compress().to_bytes();
    if p_pub != payment.stealth_pub {
        return Err(StealthError::KeyMismatch);
    }
    Ok(StealthSpendKey {
        secret: p,
        stealth_pub: payment.stealth_pub,
        mainnet_ready: false,
    })
}

// ── Native EdDSA signing with the one-time scalar ────────────────────────────────
//
// Standard ed25519 derives its signing scalar by hashing+clamping a seed; we
// instead have an *explicit* scalar `p` (from the stealth derivation) and must
// produce a signature verifiable under `P = p·B`.  We follow RFC 8032 §5.1.6
// directly, deriving the nonce-prefix deterministically from `p` (a domain-
// separated hash) since there is no seed to split.  The resulting 64-byte
// `R || S` signature verifies under `P` with any stock ed25519 verifier —
// including Solana's runtime and tweetnacl.

/// EdDSA-sign `message` with the one-time stealth scalar.  Produces a 64-byte
/// `R || S` signature that verifies natively under `stealth_pub`.
pub fn sign(key: &StealthSpendKey, message: &[u8]) -> [u8; 64] {
    sign_with_scalar(&key.secret, &key.stealth_pub, message)
}

fn sign_with_scalar(p: &Scalar, a_pub: &[u8; 32], message: &[u8]) -> [u8; 64] {
    // Deterministic nonce prefix from the secret scalar (domain-separated).
    let mut hp = Sha512::new();
    hp.update(TAG_NONCE);
    hp.update(p.as_bytes());
    let prefix = hp.finalize(); // 64 bytes; used as the nonce-prefix half

    // r = H(prefix || M) mod L
    let mut hr = Sha512::new();
    hr.update(&prefix);
    hr.update(message);
    let mut wide = [0u8; 64];
    wide.copy_from_slice(&hr.finalize());
    let r = Scalar::from_bytes_mod_order_wide(&wide);

    let r_point = (&r * &ED25519_BASEPOINT_TABLE).compress().to_bytes(); // R = r·B

    // k = H(R || A || M) mod L
    let mut hk = Sha512::new();
    hk.update(&r_point);
    hk.update(a_pub);
    hk.update(message);
    let mut wide_k = [0u8; 64];
    wide_k.copy_from_slice(&hk.finalize());
    let k = Scalar::from_bytes_mod_order_wide(&wide_k);

    // S = (r + k·p) mod L
    let s = r + k * p;

    let mut sig = [0u8; 64];
    sig[..32].copy_from_slice(&r_point);
    sig[32..].copy_from_slice(&s.to_bytes());
    sig
}

/// Reference EdDSA verifier (RFC 8032 §5.1.7): checks `8·S·B == 8·R + 8·k·A`.
///
/// Provided so the crate's round-trip test is self-contained.  On-chain, Solana's
/// own ed25519 path performs the equivalent check.
pub fn verify(public_key: &[u8; 32], message: &[u8], sig: &[u8; 64]) -> bool {
    let a = match decompress(public_key) {
        Ok(p) => p,
        Err(_) => return false,
    };
    let mut r_bytes = [0u8; 32];
    let mut s_bytes = [0u8; 32];
    r_bytes.copy_from_slice(&sig[..32]);
    s_bytes.copy_from_slice(&sig[32..]);

    let r = match decompress(&r_bytes) {
        Ok(p) => p,
        Err(_) => return false,
    };
    // S must be a canonical scalar.
    let s = match Scalar::from_canonical_bytes(s_bytes) {
        Some(s) => s,
        None => return false,
    };

    let mut hk = Sha512::new();
    hk.update(&r_bytes);
    hk.update(public_key);
    hk.update(message);
    let mut wide_k = [0u8; 64];
    wide_k.copy_from_slice(&hk.finalize());
    let k = Scalar::from_bytes_mod_order_wide(&wide_k);

    // Cofactored check: 8·(S·B) == 8·(R + k·A)
    let lhs = (&s * &ED25519_BASEPOINT_TABLE).mul_by_cofactor();
    let rhs = (r + k * a).mul_by_cofactor();
    lhs == rhs
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(b: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = b;
        s[1] = 0x11; // ensure non-zero, non-trivial
        s
    }

    // 1. Full happy-path round trip: derive -> scan detects -> recover -> sign -> verify under P.
    #[test]
    fn test_full_roundtrip_native_signature() {
        let keys = keygen(&seed(1)).unwrap();
        let meta = keys.meta_address();
        let payment = derive(&meta, &seed(0xE1)).unwrap();

        // Recipient scans and detects.
        let hit = scan(&keys, &payment).unwrap();
        assert_eq!(hit, Some(payment.stealth_pub), "recipient must detect own payment");

        // Recipient recovers the one-time scalar and signs a sweep message.
        let spend_key = recover(&keys, &payment).unwrap();
        let msg = b"nullpay-sweep:devnet:stealthtest1.null";
        let sig = sign(&spend_key, msg);

        // The signature verifies under the STEALTH pubkey (native ed25519).
        assert!(verify(&payment.stealth_pub, msg, &sig), "sig must verify under P");
        // And NOT under the recipient's main spend pubkey (unlinkability sanity).
        assert!(!verify(&meta.spend_pub, msg, &sig), "sig must NOT verify under main spend pub");
    }

    // 2. p·B == P invariant: the recovered scalar is the discrete log of the stealth point.
    #[test]
    fn test_recovered_scalar_is_dlog_of_stealth_point() {
        let keys = keygen(&seed(2)).unwrap();
        let payment = derive(&keys.meta_address(), &seed(0xE2)).unwrap();
        let sk = recover(&keys, &payment).unwrap();
        let p = Scalar::from_bytes_mod_order(sk.secret_bytes());
        let recomputed = (&p * &ED25519_BASEPOINT_TABLE).compress().to_bytes();
        assert_eq!(recomputed, payment.stealth_pub);
    }

    // 3. A different recipient cannot detect the payment (view key isolation).
    #[test]
    fn test_wrong_recipient_cannot_scan() {
        let alice = keygen(&seed(3)).unwrap();
        let bob = keygen(&seed(4)).unwrap();
        let payment = derive(&alice.meta_address(), &seed(0xE3)).unwrap();
        assert_eq!(scan(&bob, &payment).unwrap(), None, "bob must not match alice's payment");
    }

    // 4. mod-L reduction edge: a spend seed numerically ABOVE L still yields a valid,
    //    consistent stealth key (p reduces correctly mod the group order).
    #[test]
    fn test_mod_l_reduction_edge() {
        // 0xFF..FF (>L) as the spend seed; from_bytes_mod_order must reduce it.
        let big = [0xFFu8; 32];
        let keys = keygen(&big).unwrap();
        // Spend scalar is the canonical reduction of 0xFF..FF.
        assert_ne!(keys.spend_secret_bytes(), big, "seed above L must be reduced");

        // And the full pipeline still round-trips with this edge-case key.
        let payment = derive(&keys.meta_address(), &seed(0xE4)).unwrap();
        assert_eq!(scan(&keys, &payment).unwrap(), Some(payment.stealth_pub));
        let sk = recover(&keys, &payment).unwrap();
        let msg = b"mod-L-edge";
        assert!(verify(&payment.stealth_pub, msg, &sign(&sk, msg)));
    }

    // 5. Stealth offset wraps mod L when s + shared crosses the order.
    //    Construct an ephemeral seed and verify p = (s + shared) mod L is canonical
    //    (to_bytes always returns the reduced 32-byte form < L).
    #[test]
    fn test_stealth_scalar_canonical_mod_l() {
        let keys = keygen(&[0xFEu8; 32]).unwrap(); // s near the top of the range
        let payment = derive(&keys.meta_address(), &[0xFDu8; 32]).unwrap();
        let sk = recover(&keys, &payment).unwrap();
        // Canonical scalar => from_canonical_bytes must accept it.
        assert!(
            Scalar::from_canonical_bytes(sk.secret_bytes()).is_some(),
            "recovered p must be a canonical scalar < L"
        );
    }

    // 6. Each ephemeral key yields a distinct stealth address (unlinkability across payments).
    #[test]
    fn test_distinct_ephemerals_distinct_addresses() {
        let keys = keygen(&seed(6)).unwrap();
        let meta = keys.meta_address();
        let p1 = derive(&meta, &seed(0xA1)).unwrap();
        let p2 = derive(&meta, &seed(0xA2)).unwrap();
        assert_ne!(p1.stealth_pub, p2.stealth_pub);
        // But both are detectable and spendable by the same recipient.
        assert!(scan(&keys, &p1).unwrap().is_some());
        assert!(scan(&keys, &p2).unwrap().is_some());
        assert_ne!(
            recover(&keys, &p1).unwrap().secret_bytes(),
            recover(&keys, &p2).unwrap().secret_bytes(),
            "distinct payments must produce distinct one-time scalars"
        );
    }

    // 7. Stealth address is unlinkable to the meta-address by inspection:
    //    P != S, P != V, R != S, R != V.
    #[test]
    fn test_stealth_address_not_equal_to_meta() {
        let keys = keygen(&seed(7)).unwrap();
        let meta = keys.meta_address();
        let p = derive(&meta, &seed(0xB7)).unwrap();
        assert_ne!(p.stealth_pub, meta.spend_pub);
        assert_ne!(p.stealth_pub, meta.view_pub);
        assert_ne!(p.ephem_pub, meta.spend_pub);
        assert_ne!(p.ephem_pub, meta.view_pub);
    }

    // 8. View scalar differs from spend scalar (key separation).
    #[test]
    fn test_view_differs_from_spend() {
        let keys = keygen(&seed(8)).unwrap();
        assert_ne!(keys.spend_secret_bytes(), keys.view_secret_bytes());
    }

    // 9. Meta-address serialises to exactly 64 bytes and round-trips.
    #[test]
    fn test_meta_address_64_bytes_roundtrip() {
        let keys = keygen(&seed(9)).unwrap();
        let meta = keys.meta_address();
        let bytes = meta.to_bytes();
        assert_eq!(bytes.len(), 64);
        let parsed = MetaAddress::from_bytes(&bytes).unwrap();
        assert_eq!(parsed.spend_pub, meta.spend_pub);
        assert_eq!(parsed.view_pub, meta.view_pub);
    }

    // 10. from_bytes rejects a non-canonical (off-curve) point.
    #[test]
    fn test_meta_address_rejects_off_curve() {
        let mut bad = [0u8; 64];
        // y=2 is not a valid compressed edwards25519 point ((y^2-1)/(d*y^2+1) is a
        // non-square, so decompression fails). Isolates the first-point check.
        bad[0] = 0x02;
        // Second half a valid point so we isolate the first-point failure.
        let keys = keygen(&seed(10)).unwrap();
        bad[32..].copy_from_slice(&keys.meta_address().view_pub);
        assert_eq!(MetaAddress::from_bytes(&bad), Err(StealthError::NotOnCurve));
    }

    // 11. zero spend seed rejected.
    #[test]
    fn test_zero_spend_seed_rejected() {
        match keygen(&[0u8; 32]) {
            Err(StealthError::ZeroScalar) => {}
            _ => panic!("zero seed must be rejected"),
        }
    }

    // 12. zero ephemeral seed rejected.
    #[test]
    fn test_zero_ephem_seed_rejected() {
        let keys = keygen(&seed(12)).unwrap();
        match derive(&keys.meta_address(), &[0u8; 32]) {
            Err(StealthError::ZeroScalar) => {}
            _ => panic!("zero ephemeral must be rejected"),
        }
    }

    // 13. Tampered signature fails verification.
    #[test]
    fn test_tampered_signature_fails() {
        let keys = keygen(&seed(13)).unwrap();
        let payment = derive(&keys.meta_address(), &seed(0xC3)).unwrap();
        let sk = recover(&keys, &payment).unwrap();
        let msg = b"sweep";
        let mut sig = sign(&sk, msg);
        sig[10] ^= 0x01;
        assert!(!verify(&payment.stealth_pub, msg, &sig));
    }

    // 14. Signature over a different message fails (no replay across messages).
    #[test]
    fn test_signature_message_bound() {
        let keys = keygen(&seed(14)).unwrap();
        let payment = derive(&keys.meta_address(), &seed(0xC4)).unwrap();
        let sk = recover(&keys, &payment).unwrap();
        let sig = sign(&sk, b"message-A");
        assert!(!verify(&payment.stealth_pub, b"message-B", &sig));
    }

    // 15. Deterministic: same inputs -> same stealth address.
    #[test]
    fn test_derive_deterministic() {
        let keys = keygen(&seed(15)).unwrap();
        let meta = keys.meta_address();
        let p1 = derive(&meta, &seed(0xD5)).unwrap();
        let p2 = derive(&meta, &seed(0xD5)).unwrap();
        assert_eq!(p1.stealth_pub, p2.stealth_pub);
        assert_eq!(p1.ephem_pub, p2.ephem_pub);
    }

    // 16. mainnet_ready is false everywhere.
    #[test]
    fn test_mainnet_ready_false() {
        let keys = keygen(&seed(16)).unwrap();
        assert!(!keys.meta_address().mainnet_ready);
        let payment = derive(&keys.meta_address(), &seed(0xD6)).unwrap();
        assert!(!payment.mainnet_ready);
        let sk = recover(&keys, &payment).unwrap();
        assert!(!sk.mainnet_ready);
    }
}
