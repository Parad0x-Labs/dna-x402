//! Scheme-independent Ristretto group helpers shared by the host prover and the
//! (future) syscall-backed on-chain verifier.
//!
//! This is the same group/curve infrastructure the eNULL eCash rail uses
//! (`dark_fedimint_ecash::bdhke` / `::dleq`): compressed-Ristretto 32-byte points,
//! `from_uniform_bytes` hash-to-curve (Elligator), and SHA-512 → reduce for
//! Fiat–Shamir. Nothing here depends on the MAC_GGM credential algebra — only on
//! the curve and our encoding conventions — so it is safe to fix before the
//! scheme modules and to link on-chain (`no_std`-clean).

use curve25519_dalek::ristretto::{CompressedRistretto, RistrettoPoint};
use curve25519_dalek::scalar::Scalar;
use sha2::{Digest, Sha512};

/// Compressed Ristretto basepoint `G` (== `RISTRETTO_BASEPOINT_POINT.compress()`).
/// Hard-coded so the on-chain verifier never pulls the dalek basepoint-table
/// constructor (it overflows the SBF stack). Asserted against dalek's constant in
/// a host test below. Identical to `dark_fedimint_redeem::curve_syscall`.
pub const RISTRETTO_BASEPOINT_COMPRESSED: [u8; 32] = [
    0xe2, 0xf2, 0xae, 0x0a, 0x6a, 0xbc, 0x4e, 0x71, 0xa8, 0x84, 0xa9, 0x61, 0xc5, 0x00, 0x51, 0x5f,
    0x58, 0xe3, 0x0b, 0x6a, 0xa5, 0x82, 0xdd, 0x8d, 0xb6, 0xa6, 0x59, 0x45, 0xe0, 0x8d, 0x2d, 0x76,
];

/// Domain separator for deriving nothing-up-my-sleeve (NUMS) generators. Every
/// credential generator beyond the basepoint `G` is derived as
/// `H2C(GEN_DOMAIN ‖ label)` so its discrete log w.r.t. `G` is unknown to everyone.
/// Canonical value from the design spec (Part 1).
pub const GEN_DOMAIN: &[u8] = b"DNAx402/KVAC/v1/gen";

/// Hash an arbitrary input to a Ristretto point via dalek-native Elligator.
///
/// A single SHA-512 over the domain-separated input feeds
/// `RistrettoPoint::from_uniform_bytes`, which is itself a hash-to-group — a
/// uniform element with no try-and-increment loop and no known discrete log.
/// Same construction as `dark_fedimint_ecash::bdhke::hash_to_curve`.
pub fn hash_to_curve(domain: &[u8], data: &[u8]) -> RistrettoPoint {
    let mut h = Sha512::new();
    h.update(domain);
    h.update(data);
    let digest = h.finalize();
    let mut wide = [0u8; 64];
    wide.copy_from_slice(&digest);
    RistrettoPoint::from_uniform_bytes(&wide)
}

/// Derive a NUMS credential generator from a short label, e.g. `nums_generator(b"y1")`.
/// Deterministic and identical host-side and on-chain.
pub fn nums_generator(label: &[u8]) -> RistrettoPoint {
    hash_to_curve(GEN_DOMAIN, label)
}

/// Fiat–Shamir transcript accumulator.
///
/// Append every public value of the statement and every prover commitment, in a
/// fixed canonical order, then squeeze a challenge scalar. Binding *every* point
/// is the forgery-critical discipline for the presentation proof — a point left
/// out of the transcript is a point the prover can equivocate on.
///
/// Concretely the challenge is `Scalar::from_bytes_mod_order_wide(SHA512(bytes))`,
/// the same reduction the eCash DLEQ uses, so a transcript built host-side
/// reproduces byte-for-byte on-chain.
#[derive(Clone)]
pub struct Transcript {
    hasher: Sha512,
}

impl Transcript {
    /// Start a transcript bound to a protocol/version domain tag.
    pub fn new(domain: &[u8]) -> Self {
        let mut hasher = Sha512::new();
        hasher.update(domain);
        // Pin the basepoint into every transcript so the statement is anchored to G.
        hasher.update(RISTRETTO_BASEPOINT_COMPRESSED);
        Transcript { hasher }
    }

    /// Append a length-tagged label then raw bytes (length tag prevents the
    /// concatenation ambiguity where `append("ab")` and `append("a")+append("b")`
    /// would hash identically).
    pub fn append_bytes(&mut self, label: &[u8], bytes: &[u8]) {
        self.hasher.update((label.len() as u64).to_le_bytes());
        self.hasher.update(label);
        self.hasher.update((bytes.len() as u64).to_le_bytes());
        self.hasher.update(bytes);
    }

    /// Append a compressed Ristretto point (32 bytes) under a label.
    pub fn append_point(&mut self, label: &[u8], point: &CompressedRistretto) {
        self.append_bytes(label, point.as_bytes());
    }

    /// Squeeze the challenge scalar. Consumes a clone of the state so the
    /// transcript can keep being extended if a protocol needs multiple challenges.
    pub fn challenge_scalar(&self) -> Scalar {
        let digest = self.hasher.clone().finalize();
        let mut wide = [0u8; 64];
        wide.copy_from_slice(&digest);
        Scalar::from_bytes_mod_order_wide(&wide)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT as G;

    #[test]
    fn basepoint_constant_matches_dalek() {
        assert_eq!(RISTRETTO_BASEPOINT_COMPRESSED, G.compress().to_bytes());
    }

    #[test]
    fn nums_generators_distinct_and_independent_of_g() {
        let y1 = nums_generator(b"y1");
        let y2 = nums_generator(b"y2");
        assert_ne!(y1.compress(), y2.compress());
        assert_ne!(y1.compress(), G.compress());
        // Deterministic.
        assert_eq!(nums_generator(b"y1").compress(), y1.compress());
    }

    #[test]
    fn transcript_is_order_and_label_sensitive() {
        let p = nums_generator(b"p").compress();
        let q = nums_generator(b"q").compress();

        let mut a = Transcript::new(b"t/v1");
        a.append_point(b"A", &p);
        a.append_point(b"B", &q);

        let mut b = Transcript::new(b"t/v1");
        b.append_point(b"A", &q); // swapped
        b.append_point(b"B", &p);
        assert_ne!(a.challenge_scalar(), b.challenge_scalar());

        // Same content, same order → same challenge.
        let mut c = Transcript::new(b"t/v1");
        c.append_point(b"A", &p);
        c.append_point(b"B", &q);
        assert_eq!(a.challenge_scalar(), c.challenge_scalar());

        // Length-tagging defeats the boundary-ambiguity collision.
        let mut d = Transcript::new(b"t/v1");
        d.append_bytes(b"X", b"ab");
        let mut e = Transcript::new(b"t/v1");
        e.append_bytes(b"X", b"a");
        e.append_bytes(b"", b"b");
        assert_ne!(d.challenge_scalar(), e.challenge_scalar());
    }
}
