//! Core BDHKE primitives over the Ristretto group (curve25519-dalek 3.2.1).
//!
//! These are the host-side, single-mint primitives that prove the mechanics
//! (DO step 1). The federation in [`crate::federation`] swaps the single secret
//! `k` for a `k`-of-`n` Shamir sharing but reuses this exact math.
//!
//! All points are encoded as 32-byte compressed Ristretto; all scalars as
//! 32-byte canonical little-endian. The on-chain redeem program parses the same
//! encodings.

use curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT as G;
use curve25519_dalek::ristretto::{CompressedRistretto, RistrettoPoint};
use curve25519_dalek::scalar::Scalar;
use sha2::{Digest, Sha512};

#[cfg(not(feature = "std"))]
extern crate alloc;
#[cfg(not(feature = "std"))]
use alloc::vec::Vec;

/// Domain separator for hash-to-curve, so `Y = H2C(x)` cannot collide with any
/// other hash use in the protocol.
const H2C_DOMAIN: &[u8] = b"eNULL-BDHKE-H2C-v1";

/// Map an arbitrary token secret to a Ristretto point `Y = H2C(secret)`.
///
/// Ristretto's `from_uniform_bytes` is itself a hash-to-group (Elligator on a
/// 64-byte uniform string), so a single SHA-512 over the domain-separated secret
/// yields a uniform group element with no try-and-increment loop and no known
/// discrete log. This is the curve25519-dalek-native, constant-time H2C.
pub fn hash_to_curve(secret: &[u8]) -> RistrettoPoint {
    let mut h = Sha512::new();
    h.update(H2C_DOMAIN);
    h.update(secret);
    let digest = h.finalize();
    let mut wide = [0u8; 64];
    wide.copy_from_slice(&digest);
    RistrettoPoint::from_uniform_bytes(&wide)
}

/// A blinded message the user sends to the mint, plus the secrets the user keeps.
///
/// Only `b_` (the compressed blinded point) ever leaves the user. `secret` and
/// `r` stay client-side; the mint learns neither.
#[derive(Clone, Debug)]
pub struct BlindedMessage {
    /// `B_ = Y + r·G`, compressed — this is what the mint signs.
    pub b_: [u8; 32],
    /// The token secret `x` (becomes the nullifier on redeem). Client-only.
    pub secret: Vec<u8>,
    /// The blinding scalar `r`. Client-only; needed to unblind.
    pub r: Scalar,
}

/// A finished bearer token `(x, C)` where `C = k·H2C(x)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Token {
    /// Token secret `x`. Revealed on redeem; its hash is the nullifier.
    pub secret: Vec<u8>,
    /// Unblinded signature `C = k·Y`, compressed Ristretto.
    pub c: [u8; 32],
}

/// Client step: blind a fresh token secret. `r` should be uniformly random.
///
/// Returns `B_ = Y + r·G` (to send to the mint) bundled with the secrets.
pub fn blind(secret: &[u8], r: Scalar) -> BlindedMessage {
    let y = hash_to_curve(secret);
    let b_ = y + (r * G);
    BlindedMessage {
        b_: b_.compress().to_bytes(),
        secret: secret.to_vec(),
        r,
    }
}

/// Mint step: blind-sign. Given the mint secret `k` and the blinded point `B_`,
/// return `C_ = k·B_` (compressed). The mint sees only `B_`, never `x` or `Y`.
///
/// Returns `None` if `B_` is not a valid compressed Ristretto point.
pub fn sign_blinded(k: &Scalar, b_compressed: &[u8; 32]) -> Option<[u8; 32]> {
    let b_ = CompressedRistretto(*b_compressed).decompress()?;
    let c_ = k * b_;
    Some(c_.compress().to_bytes())
}

/// Client step: unblind. Given the mint public key `K = k·G`, the blind sig
/// `C_ = k·B_`, and the kept blinding `r`, recover `C = C_ - r·K = k·Y`.
///
/// Returns `None` if either input point fails to decompress.
pub fn unblind(c_blind: &[u8; 32], k_pub: &[u8; 32], r: &Scalar) -> Option<[u8; 32]> {
    let c_ = CompressedRistretto(*c_blind).decompress()?;
    let k_point = CompressedRistretto(*k_pub).decompress()?;
    let c = c_ - (r * k_point);
    Some(c.compress().to_bytes())
}

/// Mint-side verification (knows `k`): a token `(x, C)` is valid iff
/// `C == k·H2C(x)`. This is what a *custodial* mint checks; the on-chain redeem
/// uses the DLEQ path instead (it does not know `k`).
pub fn verify_token(k: &Scalar, token: &Token) -> bool {
    let y = hash_to_curve(&token.secret);
    let expected = (k * y).compress().to_bytes();
    // constant-time-ish: compare compressed encodings
    expected == token.c
}

/// Derive the public mint key `K = k·G` (compressed) from a secret `k`.
pub fn public_key(k: &Scalar) -> [u8; 32] {
    (k * G).compress().to_bytes()
}

/// The nullifier for a token is `SHA-512(domain ‖ secret)` truncated to 32 bytes.
/// Revealing the secret on redeem lets the chain derive and record this, so the
/// same token can never be redeemed twice. Domain-separated from H2C.
pub fn nullifier(secret: &[u8]) -> [u8; 32] {
    let mut h = Sha512::new();
    h.update(b"eNULL-NULLIFIER-v1");
    h.update(secret);
    let d = h.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&d[..32]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::OsRng;
    use rand::RngCore;

    fn rand_scalar() -> Scalar {
        let mut wide = [0u8; 64];
        OsRng.fill_bytes(&mut wide);
        Scalar::from_bytes_mod_order_wide(&wide)
    }

    #[test]
    fn single_mint_blind_sign_unblind_verify() {
        // Mint key.
        let k = rand_scalar();
        let k_pub = public_key(&k);

        // User blinds a fresh secret.
        let secret = b"token-secret-0xABCD".to_vec();
        let r = rand_scalar();
        let bm = blind(&secret, r);

        // Mint blind-signs WITHOUT seeing the secret.
        let c_blind = sign_blinded(&k, &bm.b_).expect("sign");

        // User unblinds with the kept r and the mint public key.
        let c = unblind(&c_blind, &k_pub, &bm.r).expect("unblind");

        let token = Token { secret, c };
        assert!(verify_token(&k, &token), "unblinded token must verify");
    }

    #[test]
    fn unblind_equals_direct_k_y() {
        // Sanity: C = unblind(...) must equal k·H2C(secret) computed directly.
        let k = rand_scalar();
        let k_pub = public_key(&k);
        let secret = b"x".to_vec();
        let r = rand_scalar();
        let bm = blind(&secret, r);
        let c_blind = sign_blinded(&k, &bm.b_).unwrap();
        let c = unblind(&c_blind, &k_pub, &bm.r).unwrap();
        let direct = (k * hash_to_curve(&secret)).compress().to_bytes();
        assert_eq!(c, direct);
    }

    #[test]
    fn forged_token_rejected() {
        let k = rand_scalar();
        // Attacker fabricates C for a secret without the mint's signature.
        let secret = b"forged".to_vec();
        let fake_c = (rand_scalar() * G).compress().to_bytes();
        let token = Token { secret, c: fake_c };
        assert!(!verify_token(&k, &token), "forged token must be rejected");
    }

    #[test]
    fn wrong_secret_rejected() {
        // A valid C for secret A must NOT verify against secret B.
        let k = rand_scalar();
        let k_pub = public_key(&k);
        let r = rand_scalar();
        let bm = blind(b"A", r);
        let c_blind = sign_blinded(&k, &bm.b_).unwrap();
        let c = unblind(&c_blind, &k_pub, &bm.r).unwrap();
        let token = Token {
            secret: b"B".to_vec(),
            c,
        };
        assert!(!verify_token(&k, &token));
    }

    #[test]
    fn hash_to_curve_deterministic_and_nonzero() {
        let a = hash_to_curve(b"abc");
        let b = hash_to_curve(b"abc");
        assert_eq!(a.compress(), b.compress());
        assert_ne!(a.compress().to_bytes(), [0u8; 32]);
        assert_ne!(
            hash_to_curve(b"abc").compress(),
            hash_to_curve(b"abd").compress()
        );
    }

    #[test]
    fn nullifier_binds_secret() {
        assert_ne!(nullifier(b"a"), nullifier(b"b"));
        assert_eq!(nullifier(b"a"), nullifier(b"a"));
        assert_ne!(nullifier(b"a"), [0u8; 32]);
    }
}
