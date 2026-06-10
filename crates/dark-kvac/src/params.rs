//! System parameters — the fixed credential generators (spec Part 1) and the
//! attribute layout.
//!
//! n = 3 attributes: `m1 = tier` (u8), `m2 = spend_cap` (u64), `m3 = ms` (the
//! high-entropy credential secret / `.null` identity scalar). Each value attribute
//! is carried as `Mi = mi·Gmi`; the `Gyi` are the per-attribute blinding bases.
//!
//! All 11 non-basepoint generators are NUMS points `H2C(GEN_DOMAIN ‖ label)` with
//! mutually unknown discrete logs (Signal §3.1). Host-side we just compute them;
//! the eventual on-chain verifier would bake them as 32-byte constants.

use crate::group::nums_generator;
use curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT;
use curve25519_dalek::ristretto::RistrettoPoint;
use curve25519_dalek::scalar::Scalar;

/// Number of attributes (tier, spend_cap, ms).
pub const N_ATTRS: usize = 3;

/// The fixed generator set `(G, Gw, Gw', Gx0, Gx1, {Gyi}, {Gmi}, GV)` — Signal §3.1.
#[derive(Clone, Debug)]
pub struct Generators {
    /// Ristretto basepoint `G`.
    pub g: RistrettoPoint,
    /// `Gw`, `Gw'` — bases for the `CW` issuer commitment.
    pub gw: RistrettoPoint,
    pub gw_prime: RistrettoPoint,
    /// `Gx0`, `Gx1` — bases for the `x0`/`x1` slots of `I` and the `Cx*` commitments.
    pub gx0: RistrettoPoint,
    pub gx1: RistrettoPoint,
    /// `Gy1..Gy3` — per-attribute blinding bases (the `z`-slot of each `Cyi`).
    pub gy: [RistrettoPoint; N_ATTRS],
    /// `Gm1..Gm3` — per-attribute value bases (`Mi = mi·Gmi`).
    pub gm: [RistrettoPoint; N_ATTRS],
    /// `GV` — base for the `V` slot of `I` and `CV`.
    pub gv: RistrettoPoint,
}

impl Generators {
    /// Derive the canonical generator set. Deterministic; identical everywhere.
    pub fn new() -> Self {
        Generators {
            g: RISTRETTO_BASEPOINT_POINT,
            gw: nums_generator(b"Gw"),
            gw_prime: nums_generator(b"Gw_prime"),
            gx0: nums_generator(b"Gx0"),
            gx1: nums_generator(b"Gx1"),
            gy: [
                nums_generator(b"Gy1"),
                nums_generator(b"Gy2"),
                nums_generator(b"Gy3"),
            ],
            gm: [
                nums_generator(b"Gm1"),
                nums_generator(b"Gm2"),
                nums_generator(b"Gm3"),
            ],
            gv: nums_generator(b"GV"),
        }
    }
}

impl Default for Generators {
    fn default() -> Self {
        Self::new()
    }
}

/// Map the public attribute values to their field scalars in the canonical order
/// `[tier, spend_cap, ms]`. `ms` is supplied directly (it is a random scalar, the
/// credential secret), while `tier`/`spend_cap` are small integers.
pub fn attr_scalars(tier: u8, spend_cap: u64, ms: Scalar) -> [Scalar; N_ATTRS] {
    [Scalar::from(tier as u64), Scalar::from(spend_cap), ms]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generators_are_distinct() {
        let g = Generators::new();
        let mut all = alloc_points(&g);
        all.sort_by(|a, b| a.compress().to_bytes().cmp(&b.compress().to_bytes()));
        for w in all.windows(2) {
            assert_ne!(w[0].compress(), w[1].compress(), "generators must be distinct");
        }
    }

    fn alloc_points(g: &Generators) -> Vec<RistrettoPoint> {
        let mut v = vec![g.g, g.gw, g.gw_prime, g.gx0, g.gx1, g.gv];
        v.extend_from_slice(&g.gy);
        v.extend_from_slice(&g.gm);
        v
    }

    #[test]
    fn attr_scalars_layout() {
        let ms = Scalar::from(123456u64);
        let a = attr_scalars(2, 1_000_000, ms);
        assert_eq!(a[0], Scalar::from(2u64));
        assert_eq!(a[1], Scalar::from(1_000_000u64));
        assert_eq!(a[2], ms);
    }
}
