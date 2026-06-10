//! End-to-end scheme test vectors (spec Part 7). Host-side correctness gate that
//! must pass BEFORE any on-chain work.

use curve25519_dalek::scalar::Scalar;
use dark_kvac::present::PresentRandomness;
use dark_kvac::util::{random_scalar, random_scalars};
use dark_kvac::verify::recompute_z;
use dark_kvac::*;

const CTX_A: [u8; 32] = [0xA1; 32];
const CTX_B: [u8; 32] = [0xB2; 32];

fn setup() -> (Generators, IssuerSecretKey, IssuerParams) {
    let gens = Generators::new();
    let sk = IssuerSecretKey::random();
    let iparams = sk.iparams(&gens);
    (gens, sk, iparams)
}

/// Issue a credential for (tier, spend_cap, ms); returns the credential + attribute
/// scalars, and asserts the issuance proof + ms-PoK verify.
fn issue_cred(
    gens: &Generators,
    sk: &IssuerSecretKey,
    iparams: &IssuerParams,
    tier: u8,
    cap: u64,
    ms: Scalar,
) -> (Credential, [Scalar; 3]) {
    let (m3, pok) = commit_ms(gens, &ms, random_scalar());
    assert!(issue::verify_ms_pok(gens, &m3, &pok), "ms PoK must verify");

    let m1 = Scalar::from(tier as u64);
    let m2 = Scalar::from(cap);
    let t = random_scalar();
    let u = fresh_u(b"u-nonce");
    let rho = random_scalars::<7>();

    let (cred, proof) = issue(sk, gens, iparams, m1, m2, m3, t, u, rho);
    assert!(
        verify_issuance(gens, iparams, m1, m2, m3, &cred, &proof),
        "issuance proof must verify"
    );
    (cred, attr_scalars(tier, cap, ms))
}

// ── 1, 2: roundtrip accept ──────────────────────────────────────────────────

#[test]
fn roundtrip_accept() {
    let (gens, sk, iparams) = setup();
    let ms = random_scalar();
    let (cred, attrs) = issue_cred(&gens, &sk, &iparams, 2, 1_000_000, ms);

    let pres = present(
        &cred,
        &attrs,
        &gens,
        &iparams,
        &CTX_A,
        &[],
        &PresentRandomness::random(),
    );
    assert!(verify(&pres, &sk, &gens, &iparams, &CTX_A, &[]));
}

// ── 3: the load-bearing identity Z == z·I ───────────────────────────────────

#[test]
#[allow(non_snake_case)]
fn master_identity_Z_equals_zI() {
    let (gens, sk, iparams) = setup();
    let ms = random_scalar();
    let (cred, attrs) = issue_cred(&gens, &sk, &iparams, 1, 42, ms);

    let r = PresentRandomness::random();
    let z = r.z;
    let pres = present(&cred, &attrs, &gens, &iparams, &CTX_A, &[], &r);

    let z_pt = recompute_z(&pres, &sk, &gens);
    assert_eq!(z_pt, z * iparams.i, "Z must collapse to z·I");
}

// ── 5: tamper each response → reject ────────────────────────────────────────

#[test]
fn tamper_each_response_rejects() {
    let (gens, sk, iparams) = setup();
    let ms = random_scalar();
    let (cred, attrs) = issue_cred(&gens, &sk, &iparams, 3, 7, ms);
    let base = present(
        &cred,
        &attrs,
        &gens,
        &iparams,
        &CTX_A,
        &[],
        &PresentRandomness::random(),
    );
    assert!(verify(&base, &sk, &gens, &iparams, &CTX_A, &[]));

    let mut muts: Vec<Presentation> = Vec::new();
    for which in 0..6 {
        let mut p = base;
        match which {
            0 => p.s_z += Scalar::one(),
            1 => p.s_z0 += Scalar::one(),
            2 => p.s_t += Scalar::one(),
            3 => p.s_attr[0] += Scalar::one(),
            4 => p.s_attr[1] += Scalar::one(),
            _ => p.s_attr[2] += Scalar::one(),
        }
        muts.push(p);
    }
    for (i, p) in muts.iter().enumerate() {
        assert!(
            !verify(p, &sk, &gens, &iparams, &CTX_A, &[]),
            "tampered response {i} must reject"
        );
    }
}

// ── 6: tamper each commitment + n → reject ──────────────────────────────────

#[test]
fn tamper_each_commitment_rejects() {
    let (gens, sk, iparams) = setup();
    let ms = random_scalar();
    let (cred, attrs) = issue_cred(&gens, &sk, &iparams, 2, 9, ms);
    let base = present(
        &cred,
        &attrs,
        &gens,
        &iparams,
        &CTX_A,
        &[],
        &PresentRandomness::random(),
    );

    let bump = gens.gw; // any nonzero point
    let mut variants: Vec<Presentation> = Vec::new();
    for which in 0..7 {
        let mut p = base;
        match which {
            0 => p.cx0 += bump,
            1 => p.cx1 += bump,
            2 => p.cy[0] += bump,
            3 => p.cy[1] += bump,
            4 => p.cy[2] += bump,
            5 => p.cv += bump,
            _ => p.n += bump,
        }
        variants.push(p);
    }
    for (i, p) in variants.iter().enumerate() {
        assert!(
            !verify(p, &sk, &gens, &iparams, &CTX_A, &[]),
            "tampered commitment {i} must reject"
        );
    }
}

// ── 7: wrong challenge → reject ─────────────────────────────────────────────

#[test]
fn wrong_challenge_rejects() {
    let (gens, sk, iparams) = setup();
    let ms = random_scalar();
    let (cred, attrs) = issue_cred(&gens, &sk, &iparams, 1, 1, ms);
    let mut p = present(
        &cred,
        &attrs,
        &gens,
        &iparams,
        &CTX_A,
        &[],
        &PresentRandomness::random(),
    );
    p.e += Scalar::one();
    assert!(!verify(&p, &sk, &gens, &iparams, &CTX_A, &[]));
}

// ── 9: mismatched MAC (forged credential) → reject ──────────────────────────

#[test]
fn forged_mac_rejects() {
    let (gens, sk, iparams) = setup();
    let ms = random_scalar();
    let (mut cred, attrs) = issue_cred(&gens, &sk, &iparams, 2, 5, ms);
    // Replace V with a random point — not a genuine MAC.
    cred.v += gens.gv;
    let pres = present(
        &cred,
        &attrs,
        &gens,
        &iparams,
        &CTX_A,
        &[],
        &PresentRandomness::random(),
    );
    assert!(
        !verify(&pres, &sk, &gens, &iparams, &CTX_A, &[]),
        "a presentation of a non-MAC credential must reject"
    );
}

// ── 10: wrong attribute (present m1' ≠ MAC'd m1) → reject ────────────────────

#[test]
fn wrong_attribute_rejects() {
    let (gens, sk, iparams) = setup();
    let ms = random_scalar();
    let (cred, _attrs) = issue_cred(&gens, &sk, &iparams, 2, 100, ms);
    // Present claiming tier=5 though the credential was MAC'd over tier=2.
    let lying = attr_scalars(5, 100, ms);
    let pres = present(
        &cred,
        &lying,
        &gens,
        &iparams,
        &CTX_A,
        &[],
        &PresentRandomness::random(),
    );
    assert!(
        !verify(&pres, &sk, &gens, &iparams, &CTX_A, &[]),
        "claiming an attribute the MAC does not cover must reject"
    );
}

// ── 11: param swap → reject ─────────────────────────────────────────────────

#[test]
fn param_swap_rejects() {
    let (gens, sk, iparams) = setup();
    let ms = random_scalar();
    let (cred, attrs) = issue_cred(&gens, &sk, &iparams, 1, 1, ms);
    let pres = present(
        &cred,
        &attrs,
        &gens,
        &iparams,
        &CTX_A,
        &[],
        &PresentRandomness::random(),
    );
    // A different issuer's params (different sk) must not verify the show.
    let sk2 = IssuerSecretKey::random();
    let iparams2 = sk2.iparams(&gens);
    assert!(!verify(&pres, &sk2, &gens, &iparams2, &CTX_A, &[]));
}

// ── 12 / nullifier binding: swap n for ms'·H_ctx → reject ───────────────────

#[test]
fn forged_nullifier_rejects() {
    let (gens, sk, iparams) = setup();
    let ms = random_scalar();
    let (cred, attrs) = issue_cred(&gens, &sk, &iparams, 2, 2, ms);
    let mut pres = present(
        &cred,
        &attrs,
        &gens,
        &iparams,
        &CTX_A,
        &[],
        &PresentRandomness::random(),
    );
    // Replace n with one for a DIFFERENT secret ms' (the shared-nonce DLEQ must bind
    // n to the committed ms, so this is unforgeable → reject).
    let ms_fake = random_scalar();
    pres.n = nullifier(&ms_fake, &CTX_A);
    assert!(!verify(&pres, &sk, &gens, &iparams, &CTX_A, &[]));
}

// ── 16 / wrong context: verifier recomputes H_ctx, ignores client ───────────

#[test]
fn wrong_context_rejects() {
    let (gens, sk, iparams) = setup();
    let ms = random_scalar();
    let (cred, attrs) = issue_cred(&gens, &sk, &iparams, 1, 1, ms);
    let pres = present(
        &cred,
        &attrs,
        &gens,
        &iparams,
        &CTX_A,
        &[],
        &PresentRandomness::random(),
    );
    // Verifier checks against a different context → H_ctx differs → reject.
    assert!(!verify(&pres, &sk, &gens, &iparams, &CTX_B, &[]));
}

// ── 13, 14: nullifier determinism + cross-context (full presentations) ──────

#[test]
fn nullifier_determinism_and_cross_context() {
    let (gens, sk, iparams) = setup();
    let ms = random_scalar();
    let (cred, attrs) = issue_cred(&gens, &sk, &iparams, 2, 2, ms);

    let p1 = present(
        &cred,
        &attrs,
        &gens,
        &iparams,
        &CTX_A,
        &[],
        &PresentRandomness::random(),
    );
    let p2 = present(
        &cred,
        &attrs,
        &gens,
        &iparams,
        &CTX_A,
        &[],
        &PresentRandomness::random(),
    );
    let p3 = present(
        &cred,
        &attrs,
        &gens,
        &iparams,
        &CTX_B,
        &[],
        &PresentRandomness::random(),
    );

    // Same (ms, context) → identical nullifier across two independent shows.
    assert_eq!(p1.n, p2.n, "nullifier must be deterministic within a context");
    // Different context → different nullifier.
    assert_ne!(p1.n, p3.n, "nullifier must differ across contexts");
    // All verify.
    assert!(verify(&p1, &sk, &gens, &iparams, &CTX_A, &[]));
    assert!(verify(&p2, &sk, &gens, &iparams, &CTX_A, &[]));
    assert!(verify(&p3, &sk, &gens, &iparams, &CTX_B, &[]));
}

// ── wire roundtrip + 12: non-canonical encodings rejected at parse ──────────

#[test]
fn wire_roundtrip_and_noncanonical_reject() {
    let (gens, sk, iparams) = setup();
    let ms = random_scalar();
    let (cred, attrs) = issue_cred(&gens, &sk, &iparams, 2, 2, ms);
    let pres = present(
        &cred,
        &attrs,
        &gens,
        &iparams,
        &CTX_A,
        &[],
        &PresentRandomness::random(),
    );

    // roundtrip is exact and the parsed proof still verifies.
    let bytes = pres.to_bytes();
    let parsed = Presentation::from_bytes(&bytes).expect("canonical bytes must parse");
    assert_eq!(parsed, pres);
    assert!(verify(&parsed, &sk, &gens, &iparams, &CTX_A, &[]));

    // wrong length → None.
    assert!(Presentation::from_bytes(&bytes[..bytes.len() - 1]).is_none());

    // non-canonical SCALAR in the `e` slot (offset 7*32) → None.
    let mut bad = bytes;
    for b in bad[7 * 32..7 * 32 + 32].iter_mut() {
        *b = 0xff; // 0xff..ff is ≥ L, not a canonical scalar
    }
    assert!(
        Presentation::from_bytes(&bad).is_none(),
        "non-canonical scalar must be rejected at parse"
    );

    // non-canonical POINT in the cx0 slot (offset 0) → None (0xff..ff is not a
    // valid compressed Ristretto encoding).
    let mut bad2 = bytes;
    for b in bad2[0..32].iter_mut() {
        *b = 0xff;
    }
    assert!(
        Presentation::from_bytes(&bad2).is_none(),
        "non-canonical point must be rejected at parse"
    );
}

// ── 18: presentation unlinkability sanity ───────────────────────────────────

#[test]
fn two_shows_share_no_commitment_point() {
    let (gens, sk, iparams) = setup();
    let ms = random_scalar();
    let (cred, attrs) = issue_cred(&gens, &sk, &iparams, 2, 2, ms);

    let p1 = present(
        &cred,
        &attrs,
        &gens,
        &iparams,
        &CTX_A,
        &[],
        &PresentRandomness::random(),
    );
    let p2 = present(
        &cred,
        &attrs,
        &gens,
        &iparams,
        &CTX_A,
        &[],
        &PresentRandomness::random(),
    );
    // Fresh z each time → every blinded commitment differs; only n matches in-context.
    assert_ne!(p1.cx0, p2.cx0);
    assert_ne!(p1.cx1, p2.cx1);
    assert_ne!(p1.cv, p2.cv);
    for j in 0..N_ATTRS {
        assert_ne!(p1.cy[j], p2.cy[j]);
    }
    assert_eq!(p1.n, p2.n);
    let _ = (sk, iparams); // keep used
}
