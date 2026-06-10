//! Presentation verifier (spec §4.5) — runs in the gateway, which holds `sk`.
//!
//! This is *keyed* verification: the gateway recomputes the master value `Z` with
//! its secret key (eq 20) and checks, via the sigma proof, that `Z = z·I` for the
//! `z` the holder blinded with — together with the per-attribute and nullifier
//! relations. The credential secret never appears; the gateway learns nothing
//! except the nullifier `n` (which it then records single-use on-chain).
//!
//! Deployment note (spec §6.2): `sk` stays here, off-chain, and never touches any
//! on-chain account. The chain only sees `n`.

use crate::keys::IssuerSecretKey;
use crate::nullifier::h_ctx;
use crate::params::Generators;
use crate::present::{present_challenge, Presentation};
use crate::keys::IssuerParams;
use curve25519_dalek::ristretto::RistrettoPoint;
use curve25519_dalek::scalar::Scalar;

/// Verify a presentation. Returns `true` iff the proof is a valid show of a
/// genuine issuer MAC over the committed attributes, with `n` correctly bound to
/// the committed credential secret. Does NOT check nullifier freshness — that is
/// the on-chain single-use record's job.
pub fn verify(
    pres: &Presentation,
    sk: &IssuerSecretKey,
    gens: &Generators,
    iparams: &IssuerParams,
    context: &[u8; 32],
    revealed_attrs: &[u8],
) -> bool {
    let e = pres.e;

    // (19) recompute H_ctx from context — NEVER trust a client-supplied base.
    let hctx = h_ctx(context);

    // (20) Z = CV − ( W + x0·Cx0 + x1·Cx1 + y1·Cy1 + y2·Cy2 + y3·Cy3 ),  W = w·Gw.
    let w_pt = sk.big_w(gens);
    let folded = w_pt
        + sk.x0 * pres.cx0
        + sk.x1 * pres.cx1
        + sk.y[0] * pres.cy[0]
        + sk.y[1] * pres.cy[1]
        + sk.y[2] * pres.cy[2];
    let z_pt: RistrettoPoint = pres.cv - folded;

    // (21) recompute the announcements in challenge form A' = Σ s·base − e·committed.
    let a1 = pres.s_z * iparams.i - e * z_pt;
    let a2 = pres.s_t * pres.cx0 + pres.s_z0 * gens.gx0 + pres.s_z * gens.gx1 - e * pres.cx1;
    let a3 = pres.s_attr[0] * gens.gm[0] + pres.s_z * gens.gy[0] - e * pres.cy[0];
    let a4 = pres.s_attr[1] * gens.gm[1] + pres.s_z * gens.gy[1] - e * pres.cy[1];
    let a5 = pres.s_attr[2] * gens.gm[2] + pres.s_z * gens.gy[2] - e * pres.cy[2];
    let a6 = pres.s_attr[2] * hctx - e * pres.n;

    // (22) accept iff the recomputed challenge matches.
    let e_prime = present_challenge(
        gens,
        iparams,
        context,
        &hctx,
        &pres.cx0,
        &pres.cx1,
        &pres.cy,
        &pres.cv,
        &pres.n,
        revealed_attrs,
        &a1,
        &a2,
        &a3,
        &a4,
        &a5,
        &a6,
    );
    e_prime == e
}

/// Convenience: recompute the master `Z` directly (test vector 3 — the load-bearing
/// identity `Z == z·I` for an honest witness). Exposed so the e2e/test harness can
/// assert the algebra independently of the sigma proof.
pub fn recompute_z(
    pres: &Presentation,
    sk: &IssuerSecretKey,
    gens: &Generators,
) -> RistrettoPoint {
    let w_pt = sk.big_w(gens);
    pres.cv
        - (w_pt
            + sk.x0 * pres.cx0
            + sk.x1 * pres.cx1
            + sk.y[0] * pres.cy[0]
            + sk.y[1] * pres.cy[1]
            + sk.y[2] * pres.cy[2])
}

/// For a revealed attribute `j` (spec §4.5 / Danger Zone 3): the verifier folds the
/// public value back by replacing `Cyj` with `Cyj + mj·Gmj` before computing `Z`.
/// Helper kept for the predicate path; unused while all attributes stay hidden.
pub fn fold_revealed(cyj: RistrettoPoint, mj: Scalar, gmj: RistrettoPoint) -> RistrettoPoint {
    cyj + mj * gmj
}
