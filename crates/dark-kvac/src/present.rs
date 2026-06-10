//! Presentation — the unlinkable show (spec Part 4).
//!
//! The holder blinds its credential with a fresh `z`, commits to all attributes,
//! derives the per-context nullifier, and proves in zero-knowledge (relations
//! P1–P6, eq 16) that:
//!   * the commitments open to a valid issuer MAC (`Z = z·I`),
//!   * the `t`/`z` blinding is consistent across `Cx0`/`Cx1` (z0 = −tz),
//!   * each attribute commitment is well-formed, and
//!   * the nullifier `n` is `ms·H_ctx` for the **same** `ms` committed in `Cy3`.
//!
//! Two bindings are forgery-critical and enforced by *sharing one nonce*:
//!   * `r_z` is shared across A2,A3,A4,A5 → one blinder `z` across all commitments.
//!   * `r_ms` is shared across A5,A6 → the nullifier is tied to the credential
//!     secret (a forger cannot put a different `ms'` into `n`).

use crate::fs::{append_generators, append_point, finalize_challenge};
use crate::issue::Credential;
use crate::keys::IssuerParams;
use crate::nullifier::h_ctx;
use crate::params::{Generators, N_ATTRS};
use curve25519_dalek::ristretto::RistrettoPoint;
use curve25519_dalek::scalar::Scalar;
use sha2::{Digest, Sha512};

pub(crate) const PRESENT_DOMAIN: &[u8] = b"DNAx402/KVAC/v1/present";

/// The wire proof object π_P (spec §4.4). Announcements are recomputed by the
/// verifier (the `A' = Σ s·base − e·committed` form), not transmitted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Presentation {
    pub cx0: RistrettoPoint,
    pub cx1: RistrettoPoint,
    pub cy: [RistrettoPoint; N_ATTRS],
    pub cv: RistrettoPoint,
    /// Per-context nullifier `n = ms·H_ctx`.
    pub n: RistrettoPoint,
    pub e: Scalar,
    pub s_z: Scalar,
    pub s_z0: Scalar,
    pub s_t: Scalar,
    /// Responses for the 3 attribute values: `[s_m1, s_m2, s_ms]`.
    pub s_attr: [Scalar; N_ATTRS],
}

/// Prover randomness: the blinder `z` and the six announcement nonces.
/// `r_attr = [r_m1, r_m2, r_ms]`; `r_attr[2]` (= `r_ms`) is reused for A6 — that
/// reuse is the nullifier binding, not an accident.
#[derive(Clone, Copy, Debug)]
pub struct PresentRandomness {
    pub z: Scalar,
    pub r_z: Scalar,
    pub r_z0: Scalar,
    pub r_t: Scalar,
    pub r_attr: [Scalar; N_ATTRS],
}

impl PresentRandomness {
    #[cfg(feature = "rand")]
    pub fn random() -> Self {
        use crate::util::random_scalar;
        PresentRandomness {
            z: random_scalar(),
            r_z: random_scalar(),
            r_z0: random_scalar(),
            r_t: random_scalar(),
            r_attr: [random_scalar(), random_scalar(), random_scalar()],
        }
    }
}

/// Build a presentation. `attrs = [m1, m2, ms]` are the holder's attribute scalars;
/// `context` is the fixed 32-byte context tag; `revealed_attrs` is the predicate
/// blob (empty for the all-hidden prototype).
pub fn present(
    cred: &Credential,
    attrs: &[Scalar; N_ATTRS],
    gens: &Generators,
    iparams: &IssuerParams,
    context: &[u8; 32],
    revealed_attrs: &[u8],
    rand: &PresentRandomness,
) -> Presentation {
    let z = rand.z;
    let z0 = -(cred.t * z); // z0 = −t·z

    // (13) commitments
    let cx0 = z * gens.gx0 + cred.u;
    let cx1 = z * gens.gx1 + cred.t * cred.u;
    let cy = [
        z * gens.gy[0] + attrs[0] * gens.gm[0],
        z * gens.gy[1] + attrs[1] * gens.gm[1],
        z * gens.gy[2] + attrs[2] * gens.gm[2],
    ];
    let cv = z * gens.gv + cred.v;

    // (14) nullifier
    let hctx = h_ctx(context);
    let n = attrs[2] * hctx;

    // (16) announcements — shared r_z across A2..A5, shared r_ms (=r_attr[2]) across A5,A6
    let a1 = rand.r_z * iparams.i;
    let a2 = rand.r_t * cx0 + rand.r_z0 * gens.gx0 + rand.r_z * gens.gx1;
    let a3 = rand.r_attr[0] * gens.gm[0] + rand.r_z * gens.gy[0];
    let a4 = rand.r_attr[1] * gens.gm[1] + rand.r_z * gens.gy[1];
    let a5 = rand.r_attr[2] * gens.gm[2] + rand.r_z * gens.gy[2];
    let a6 = rand.r_attr[2] * hctx;

    // (17) Fiat–Shamir challenge
    let e = present_challenge(
        gens, iparams, context, &hctx, &cx0, &cx1, &cy, &cv, &n, revealed_attrs, &a1, &a2, &a3,
        &a4, &a5, &a6,
    );

    // (18) responses
    let s_z = rand.r_z + e * z;
    let s_z0 = rand.r_z0 + e * z0;
    let s_t = rand.r_t + e * cred.t;
    let s_attr = [
        rand.r_attr[0] + e * attrs[0],
        rand.r_attr[1] + e * attrs[1],
        rand.r_attr[2] + e * attrs[2],
    ];

    Presentation {
        cx0,
        cx1,
        cy,
        cv,
        n,
        e,
        s_z,
        s_z0,
        s_t,
        s_attr,
    }
}

/// The canonical presentation challenge (eq 17). Shared by prover and verifier;
/// the verifier passes its *recomputed* announcements `A1'..A6'`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn present_challenge(
    gens: &Generators,
    iparams: &IssuerParams,
    context: &[u8; 32],
    hctx: &RistrettoPoint,
    cx0: &RistrettoPoint,
    cx1: &RistrettoPoint,
    cy: &[RistrettoPoint; N_ATTRS],
    cv: &RistrettoPoint,
    n: &RistrettoPoint,
    revealed_attrs: &[u8],
    a1: &RistrettoPoint,
    a2: &RistrettoPoint,
    a3: &RistrettoPoint,
    a4: &RistrettoPoint,
    a5: &RistrettoPoint,
    a6: &RistrettoPoint,
) -> Scalar {
    let mut h = Sha512::new();
    h.update(PRESENT_DOMAIN);
    append_generators(&mut h, gens); // 12 gens
    append_point(&mut h, &iparams.cw);
    append_point(&mut h, &iparams.i);
    h.update(context); // fixed 32 bytes
    append_point(&mut h, hctx);
    append_point(&mut h, cx0);
    append_point(&mut h, cx1);
    append_point(&mut h, &cy[0]);
    append_point(&mut h, &cy[1]);
    append_point(&mut h, &cy[2]);
    append_point(&mut h, cv);
    append_point(&mut h, n);
    h.update((revealed_attrs.len() as u32).to_le_bytes());
    h.update(revealed_attrs);
    append_point(&mut h, a1);
    append_point(&mut h, a2);
    append_point(&mut h, a3);
    append_point(&mut h, a4);
    append_point(&mut h, a5);
    append_point(&mut h, a6);
    finalize_challenge(h)
}
