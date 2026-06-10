//! Issuance (spec Part 3) — clear-attribute MAC + issuance proof.
//!
//! The gateway knows the clear attributes `m1 = tier`, `m2 = spend_cap`. The
//! credential secret `ms` stays agent-only even at issuance: the agent sends
//! `M3 = ms·Gm3` plus a Schnorr PoK of `ms`, so the gateway can MAC `M3` without
//! learning `ms` (if it learned `ms` it could precompute `n = ms·H_ctx` for any
//! future context and de-anonymize the holder).

use crate::fs::{append_generators, append_point, finalize_challenge};
use crate::keys::{IssuerParams, IssuerSecretKey};
use crate::params::Generators;
use curve25519_dalek::ristretto::RistrettoPoint;
use curve25519_dalek::scalar::Scalar;
use sha2::{Digest, Sha512};

/// A keyed-verification credential `(t, U, V)` (the MAC, eq 6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Credential {
    pub t: Scalar,
    pub u: RistrettoPoint,
    pub v: RistrettoPoint,
}

/// Issuance proof π_I (eq 7) — responses for the 7 secrets `(w, w', x0, x1, y1..y3)`
/// over the three statements `(CW, I, V)`. The agent verifies it to be sure the
/// issuer used the published `iparams` and did not key-tag the credential.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IssuanceProof {
    pub e: Scalar,
    pub s_w: Scalar,
    pub s_w_prime: Scalar,
    pub s_x0: Scalar,
    pub s_x1: Scalar,
    pub s_y: [Scalar; 3],
}

/// A Schnorr PoK that the prover knows `ms` with `M3 = ms·Gm3` (the agent's
/// commitment to the credential secret at issuance).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MsPok {
    pub e: Scalar,
    pub s: Scalar,
}

const ISSUE_DOMAIN: &[u8] = b"DNAx402/KVAC/v1/issue";
const MSPOK_DOMAIN: &[u8] = b"DNAx402/KVAC/v1/ms-pok";

// ── Agent side: commit to ms, prove knowledge ───────────────────────────────

/// Agent computes `M3 = ms·Gm3` and a PoK of `ms`. `nonce_a` is a fresh random
/// scalar (the Schnorr commitment randomness).
pub fn commit_ms(gens: &Generators, ms: &Scalar, nonce_a: Scalar) -> (RistrettoPoint, MsPok) {
    let m3 = ms * gens.gm[2];
    let a = nonce_a * gens.gm[2];
    let e = ms_pok_challenge(gens, &m3, &a);
    let s = nonce_a + e * ms;
    (m3, MsPok { e, s })
}

/// Gateway verifies the agent's PoK of `ms` for `M3`.
pub fn verify_ms_pok(gens: &Generators, m3: &RistrettoPoint, pok: &MsPok) -> bool {
    // A' = s·Gm3 − e·M3
    let a_prime = pok.s * gens.gm[2] - pok.e * m3;
    ms_pok_challenge(gens, m3, &a_prime) == pok.e
}

fn ms_pok_challenge(gens: &Generators, m3: &RistrettoPoint, a: &RistrettoPoint) -> Scalar {
    let mut h = Sha512::new();
    h.update(MSPOK_DOMAIN);
    append_point(&mut h, &gens.gm[2]);
    append_point(&mut h, m3);
    append_point(&mut h, a);
    finalize_challenge(h)
}

// ── Gateway side: MAC + issuance proof ──────────────────────────────────────

/// Issue a credential and its proof. `m1, m2` are the clear attribute scalars;
/// `m3` is the agent's `M3 = ms·Gm3` point (PoK already verified). `t` and `u` are
/// the MAC randomness (`U` must be a real group element with unknown dlog — derive
/// it via [`fresh_u`]); `rho` are the 7 issuance-proof nonces in order
/// `(w, w', x0, x1, y1, y2, y3)`.
pub fn issue(
    sk: &IssuerSecretKey,
    gens: &Generators,
    iparams: &IssuerParams,
    m1: Scalar,
    m2: Scalar,
    m3: RistrettoPoint,
    t: Scalar,
    u: RistrettoPoint,
    rho: [Scalar; 7],
) -> (Credential, IssuanceProof) {
    let big_m1 = m1 * gens.gm[0];
    let big_m2 = m2 * gens.gm[1];
    let big_m3 = m3;

    // (6) V = W + (x0 + x1·t)·U + y1·M1 + y2·M2 + y3·M3
    let w_pt = sk.big_w(gens);
    let v = w_pt
        + (sk.x0 + sk.x1 * t) * u
        + sk.y[0] * big_m1
        + sk.y[1] * big_m2
        + sk.y[2] * big_m3;
    let cred = Credential { t, u, v };

    // (8) T_CW, (9) T_I, (10) T_V
    let t_cw = rho[0] * gens.gw + rho[1] * gens.gw_prime;
    let t_i = -(rho[2] * gens.gx0
        + rho[3] * gens.gx1
        + rho[4] * gens.gy[0]
        + rho[5] * gens.gy[1]
        + rho[6] * gens.gy[2]);
    let t_v = rho[0] * gens.gw
        + rho[2] * u
        + rho[3] * (t * u)
        + rho[4] * big_m1
        + rho[5] * big_m2
        + rho[6] * big_m3;

    // (11) e_I
    let e = issue_challenge(
        gens, iparams, &t, &u, &v, &big_m1, &big_m2, &big_m3, &t_cw, &t_i, &t_v,
    );

    // (12) s_k = ρ_k + e·k
    let secrets = [sk.w, sk.w_prime, sk.x0, sk.x1, sk.y[0], sk.y[1], sk.y[2]];
    let mut s = [Scalar::zero(); 7];
    for k in 0..7 {
        s[k] = rho[k] + e * secrets[k];
    }
    let proof = IssuanceProof {
        e,
        s_w: s[0],
        s_w_prime: s[1],
        s_x0: s[2],
        s_x1: s[3],
        s_y: [s[4], s[5], s[6]],
    };
    (cred, proof)
}

/// Agent-side issuance verification (no secret key needed). `m1, m2` are the clear
/// attribute scalars the agent supplied; `m3` is its own `M3 = ms·Gm3`.
pub fn verify_issuance(
    gens: &Generators,
    iparams: &IssuerParams,
    m1: Scalar,
    m2: Scalar,
    m3: RistrettoPoint,
    cred: &Credential,
    proof: &IssuanceProof,
) -> bool {
    let big_m1 = m1 * gens.gm[0];
    let big_m2 = m2 * gens.gm[1];
    let big_m3 = m3;
    let e = proof.e;

    // T_CW' = s_w·Gw + s_w'·Gw' − e·CW
    let t_cw = proof.s_w * gens.gw + proof.s_w_prime * gens.gw_prime - e * iparams.cw;

    // T_I' = −(s_x0·Gx0 + s_x1·Gx1 + Σ s_yi·Gyi) + e·(GV − I)
    let sigma = proof.s_x0 * gens.gx0
        + proof.s_x1 * gens.gx1
        + proof.s_y[0] * gens.gy[0]
        + proof.s_y[1] * gens.gy[1]
        + proof.s_y[2] * gens.gy[2];
    let t_i = -sigma + e * (gens.gv - iparams.i);

    // T_V' = s_w·Gw + s_x0·U + s_x1·(t·U) + Σ s_yi·Mi − e·V
    let t_v = proof.s_w * gens.gw
        + proof.s_x0 * cred.u
        + proof.s_x1 * (cred.t * cred.u)
        + proof.s_y[0] * big_m1
        + proof.s_y[1] * big_m2
        + proof.s_y[2] * big_m3
        - e * cred.v;

    let e_prime = issue_challenge(
        gens, iparams, &cred.t, &cred.u, &cred.v, &big_m1, &big_m2, &big_m3, &t_cw, &t_i, &t_v,
    );
    e_prime == e
}

#[allow(clippy::too_many_arguments)]
fn issue_challenge(
    gens: &Generators,
    iparams: &IssuerParams,
    t: &Scalar,
    u: &RistrettoPoint,
    v: &RistrettoPoint,
    big_m1: &RistrettoPoint,
    big_m2: &RistrettoPoint,
    big_m3: &RistrettoPoint,
    t_cw: &RistrettoPoint,
    t_i: &RistrettoPoint,
    t_v: &RistrettoPoint,
) -> Scalar {
    let mut h = Sha512::new();
    h.update(ISSUE_DOMAIN);
    append_generators(&mut h, gens);
    append_point(&mut h, &iparams.cw);
    append_point(&mut h, &iparams.i);
    h.update(t.as_bytes()); // t is a scalar (32 bytes)
    append_point(&mut h, u);
    append_point(&mut h, v);
    append_point(&mut h, big_m1);
    append_point(&mut h, big_m2);
    append_point(&mut h, big_m3);
    append_point(&mut h, t_cw);
    append_point(&mut h, t_i);
    append_point(&mut h, t_v);
    finalize_challenge(h)
}

/// Derive a fresh MAC point `U = H2C("issue" ‖ nonce)` — a real group element with
/// no known discrete log (spec eq 6 danger-zone note; never use `r·G`, whose dlog
/// the issuer would know).
pub fn fresh_u(nonce: &[u8]) -> RistrettoPoint {
    crate::group::hash_to_curve(b"DNAx402/KVAC/v1/U", nonce)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::scalar_from_wide;

    fn sk_fixed() -> IssuerSecretKey {
        let mut s = [Scalar::zero(); 7];
        for (k, sc) in s.iter_mut().enumerate() {
            *sc = scalar_from_wide(&[(k as u8) + 1; 64]);
        }
        IssuerSecretKey::from_scalars(s)
    }

    #[test]
    fn ms_pok_roundtrip() {
        let gens = Generators::new();
        let ms = scalar_from_wide(&[42u8; 64]);
        let (m3, pok) = commit_ms(&gens, &ms, scalar_from_wide(&[99u8; 64]));
        assert!(verify_ms_pok(&gens, &m3, &pok));
        // tamper
        let mut bad = pok;
        bad.s += Scalar::one();
        assert!(!verify_ms_pok(&gens, &m3, &bad));
    }

    #[test]
    fn issuance_roundtrip_and_tamper() {
        let gens = Generators::new();
        let sk = sk_fixed();
        let iparams = sk.iparams(&gens);
        let m1 = Scalar::from(2u64);
        let m2 = Scalar::from(1_000_000u64);
        let ms = scalar_from_wide(&[7u8; 64]);
        let (m3, _pok) = commit_ms(&gens, &ms, scalar_from_wide(&[8u8; 64]));

        let t = scalar_from_wide(&[33u8; 64]);
        let u = fresh_u(b"nonce-1");
        let rho: [Scalar; 7] = core::array::from_fn(|k| scalar_from_wide(&[(k as u8) + 50; 64]));

        let (cred, proof) = issue(&sk, &gens, &iparams, m1, m2, m3, t, u, rho);
        assert!(verify_issuance(&gens, &iparams, m1, m2, m3, &cred, &proof));

        // tamper V → reject
        let mut bad_cred = cred;
        bad_cred.v += gens.gw;
        assert!(!verify_issuance(&gens, &iparams, m1, m2, m3, &bad_cred, &proof));

        // tamper a response → reject
        let mut bad_proof = proof;
        bad_proof.s_x0 += Scalar::one();
        assert!(!verify_issuance(&gens, &iparams, m1, m2, m3, &cred, &bad_proof));
    }
}
