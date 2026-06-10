//! Per-context nullifier (spec Part 5).
//!
//! `n = ms · H_ctx` where `H_ctx = H2C_NULL(context)` is a hashed-DH PRF over the
//! credential secret `ms`. It is deterministic in `(ms, context)` — so one
//! credential yields exactly one nullifier per context (the Sybil bound) — while
//! `n` for different contexts are mutually unlinkable under DDH and leak nothing
//! about `ms`.
//!
//! The binding that makes it accountable lives in the presentation proof: `n` is
//! tied to the *same* `ms` committed in `Cy3` by a Chaum–Pedersen DLEQ with a
//! shared nonce (spec eq P5↔P6, A5/A6). This module only derives `H_ctx` and `n`;
//! the binding proof is in [`crate::present`] / [`crate::verify`].

use crate::group::hash_to_curve;
use curve25519_dalek::ristretto::RistrettoPoint;
use curve25519_dalek::scalar::Scalar;

/// Domain separator for the nullifier base — distinct from the generator domain so
/// `H_ctx` can never collide with a credential generator.
pub const NULL_DOMAIN: &[u8] = b"DNAx402/KVAC/v1/nullctx";

/// Derive the per-context base `H_ctx = from_uniform_bytes(SHA512(NULL_DOMAIN ‖ context))`.
///
/// SECURITY: the verifier MUST recompute this from `context` and never accept a
/// client-supplied base — a base with a known discrete log would let a holder forge
/// a second, unlinkable nullifier for one identity in one context (Sybil break).
/// `context` is a fixed 32-byte tag, e.g. `SHA256(endpoint ‖ epoch)`.
pub fn h_ctx(context: &[u8; 32]) -> RistrettoPoint {
    hash_to_curve(NULL_DOMAIN, context)
}

/// The nullifier `n = ms · H_ctx`.
pub fn nullifier(ms: &Scalar, context: &[u8; 32]) -> RistrettoPoint {
    ms * h_ctx(context)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::scalar_from_wide;

    fn ms_a() -> Scalar {
        scalar_from_wide(&[7u8; 64])
    }
    fn ms_b() -> Scalar {
        scalar_from_wide(&[9u8; 64])
    }

    #[test]
    fn deterministic_in_ms_and_context() {
        let ctx = [1u8; 32];
        assert_eq!(nullifier(&ms_a(), &ctx), nullifier(&ms_a(), &ctx));
    }

    #[test]
    fn different_context_unlinkable() {
        let n1 = nullifier(&ms_a(), &[1u8; 32]);
        let n2 = nullifier(&ms_a(), &[2u8; 32]);
        assert_ne!(n1.compress(), n2.compress());
    }

    #[test]
    fn different_identity_different_nullifier() {
        let ctx = [3u8; 32];
        assert_ne!(
            nullifier(&ms_a(), &ctx).compress(),
            nullifier(&ms_b(), &ctx).compress()
        );
    }

    #[test]
    fn h_ctx_is_recomputed_not_basepoint() {
        use curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT as G;
        assert_ne!(h_ctx(&[0u8; 32]).compress(), G.compress());
    }
}
