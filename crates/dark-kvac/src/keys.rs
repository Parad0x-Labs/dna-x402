//! Issuer keygen (spec Part 2).
//!
//! The gateway holds `sk = (w, w', x0, x1, y1, y2, y3)` and publishes
//! `iparams = (CW, I)`. `W = w·Gw` is a deterministic function of `sk` (eq 4) and
//! is recomputed by the verifier; it is not a separate secret.

use crate::params::{Generators, N_ATTRS};
use curve25519_dalek::ristretto::RistrettoPoint;
use curve25519_dalek::scalar::Scalar;

/// The gateway's secret key (eq 3). Never leaves the gateway; never written to any
/// on-chain account.
#[derive(Clone)]
pub struct IssuerSecretKey {
    pub w: Scalar,
    pub w_prime: Scalar,
    pub x0: Scalar,
    pub x1: Scalar,
    pub y: [Scalar; N_ATTRS],
}

/// Published issuer parameters (eq 5), pinned in a config account so prover and
/// verifier agree byte-for-byte.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IssuerParams {
    /// `CW = w·Gw + w'·Gw'`.
    pub cw: RistrettoPoint,
    /// `I = GV − (x0·Gx0 + x1·Gx1 + Σ yi·Gyi)`.
    pub i: RistrettoPoint,
}

impl IssuerSecretKey {
    /// Build a secret key from explicit scalars (no_std-clean, deterministic for
    /// test vectors). Order: `w, w', x0, x1, y1, y2, y3`.
    pub fn from_scalars(s: [Scalar; 4 + N_ATTRS]) -> Self {
        IssuerSecretKey {
            w: s[0],
            w_prime: s[1],
            x0: s[2],
            x1: s[3],
            y: [s[4], s[5], s[6]],
        }
    }

    /// `W = w·Gw` (eq 4) — the secret point the verifier folds into `Z`.
    pub fn big_w(&self, gens: &Generators) -> RistrettoPoint {
        self.w * gens.gw
    }

    /// Derive the published `iparams = (CW, I)` (eq 5).
    pub fn iparams(&self, gens: &Generators) -> IssuerParams {
        // CW = w·Gw + w'·Gw'
        let cw = self.w * gens.gw + self.w_prime * gens.gw_prime;
        // I = GV − (x0·Gx0 + x1·Gx1 + y1·Gy1 + y2·Gy2 + y3·Gy3)
        let mut acc = self.x0 * gens.gx0 + self.x1 * gens.gx1;
        for j in 0..N_ATTRS {
            acc += self.y[j] * gens.gy[j];
        }
        let i = gens.gv - acc;
        IssuerParams { cw, i }
    }

    /// Sample a fresh secret key (host-only).
    #[cfg(feature = "rand")]
    pub fn random() -> Self {
        Self::from_scalars(crate::util::random_scalars::<7>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "rand")]
    #[test]
    fn iparams_deterministic_for_fixed_sk() {
        let gens = Generators::new();
        let sk = IssuerSecretKey::random();
        assert_eq!(sk.iparams(&gens), sk.iparams(&gens));
    }

    #[cfg(feature = "rand")]
    #[test]
    fn i_matches_definition() {
        // Independently recompute I and compare.
        let gens = Generators::new();
        let sk = IssuerSecretKey::random();
        let ip = sk.iparams(&gens);
        let expect = gens.gv
            - (sk.x0 * gens.gx0
                + sk.x1 * gens.gx1
                + sk.y[0] * gens.gy[0]
                + sk.y[1] * gens.gy[1]
                + sk.y[2] * gens.gy[2]);
        assert_eq!(ip.i, expect);
    }
}
