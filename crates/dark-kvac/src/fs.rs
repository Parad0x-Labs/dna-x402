//! Canonical Fiat–Shamir transcript serialization (spec Part 4.3 / eq 11 & 17).
//!
//! The challenge is `Scalar::from_bytes_mod_order_wide(SHA512(bytes))` over a
//! FIXED concatenation: a domain tag, then the 12 generators, then the
//! statement-specific points, each as its 32-byte compressed Ristretto encoding.
//! Every field except the optional `revealed_attrs` predicate blob is fixed-width
//! 32 bytes, so the layout is unambiguous without per-field length tags; the one
//! variable field carries a `u32`-LE length prefix.
//!
//! Both the host prover and the host verifier build the identical byte string, and
//! a future syscall verifier reproduces it on-chain — exactly the host/syscall
//! byte-parity discipline `dark_fedimint_redeem::curve_syscall` already relies on.

use crate::params::Generators;
use curve25519_dalek::ristretto::RistrettoPoint;
use curve25519_dalek::scalar::Scalar;
use sha2::{Digest, Sha512};

/// Append a point as its 32-byte compressed Ristretto encoding.
pub fn append_point(h: &mut Sha512, p: &RistrettoPoint) {
    h.update(p.compress().as_bytes());
}

/// Append the full generator block in canonical order:
/// `G ‖ Gw ‖ Gw' ‖ Gx0 ‖ Gx1 ‖ Gy1 ‖ Gy2 ‖ Gy3 ‖ Gm1 ‖ Gm2 ‖ Gm3 ‖ GV`.
pub fn append_generators(h: &mut Sha512, g: &Generators) {
    append_point(h, &g.g);
    append_point(h, &g.gw);
    append_point(h, &g.gw_prime);
    append_point(h, &g.gx0);
    append_point(h, &g.gx1);
    append_point(h, &g.gy[0]);
    append_point(h, &g.gy[1]);
    append_point(h, &g.gy[2]);
    append_point(h, &g.gm[0]);
    append_point(h, &g.gm[1]);
    append_point(h, &g.gm[2]);
    append_point(h, &g.gv);
}

/// Squeeze the challenge scalar from a completed transcript hasher.
pub fn finalize_challenge(h: Sha512) -> Scalar {
    let digest = h.finalize();
    let mut wide = [0u8; 64];
    wide.copy_from_slice(&digest);
    Scalar::from_bytes_mod_order_wide(&wide)
}
