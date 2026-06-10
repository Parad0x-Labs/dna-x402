//! Host e2e ceremony: keygen -> issue -> present -> verify, for two x402 contexts
//! of the SAME credential. Emits an evidence JSON (to stdout) carrying the two
//! verified nullifiers; the devnet harness records those on-chain.
//!
//! Run: `cargo run -p dark-kvac --bin kvac_e2e > ../../evidence/kvac/host-ceremony.json`
//! (human progress goes to stderr, JSON to stdout).

use curve25519_dalek::ristretto::RistrettoPoint;
use curve25519_dalek::scalar::Scalar;
use dark_kvac::present::PresentRandomness;
use dark_kvac::util::{random_scalar, random_scalars};
use dark_kvac::*;
use sha2::{Digest, Sha256};

fn hex32(p: &RistrettoPoint) -> String {
    to_hex(&p.compress().to_bytes())
}
fn to_hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 2);
    for byte in b {
        s.push_str(&format!("{:02x}", byte));
    }
    s
}

/// context tag = SHA256(label) — the fixed 32-byte context per spec Part 1.
fn context_tag(label: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(label.as_bytes());
    let d = h.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&d);
    out
}

fn main() {
    eprintln!("== KVAC host e2e ceremony ==");
    let gens = Generators::new();
    let sk = IssuerSecretKey::random();
    let iparams = sk.iparams(&gens);
    eprintln!("[1] keygen ok; iparams.I = {}", hex32(&iparams.i));

    // ── Issue one credential (tier=2, spend_cap=1_000_000), ms withheld via PoK ──
    let ms = random_scalar();
    let (m3, pok) = commit_ms(&gens, &ms, random_scalar());
    let ms_pok_ok = issue::verify_ms_pok(&gens, &m3, &pok);
    let tier: u8 = 2;
    let cap: u64 = 1_000_000;
    let m1 = Scalar::from(tier as u64);
    let m2 = Scalar::from(cap);
    let t = random_scalar();
    let u = fresh_u(b"kvac-e2e-U");
    let (cred, iproof) = issue(&sk, &gens, &iparams, m1, m2, m3, t, u, random_scalars::<7>());
    let issuance_ok = verify_issuance(&gens, &iparams, m1, m2, m3, &cred, &iproof);
    eprintln!("[2] issued credential; ms_pok={ms_pok_ok} issuance_proof={issuance_ok}");
    let attrs = attr_scalars(tier, cap, ms);

    // ── Two unlinkable shows of the SAME credential, two contexts ──
    let labels = ["x402:gateway/quote:epoch-7", "x402:gateway/infer:epoch-7"];
    let mut shows = Vec::new();
    for label in labels.iter() {
        let ctx = context_tag(label);
        let pres = present(&cred, &attrs, &gens, &iparams, &ctx, &[], &PresentRandomness::random());
        let verified = verify(&pres, &sk, &gens, &iparams, &ctx, &[]);
        // round-trip the wire encoding; the gateway parses these bytes.
        let wire = pres.to_bytes();
        let reparsed = Presentation::from_bytes(&wire).map(|p| verify(&p, &sk, &gens, &iparams, &ctx, &[]));
        eprintln!(
            "    show [{label}] verified={verified} reparsed_verified={:?} n={}",
            reparsed,
            hex32(&pres.n)
        );
        shows.push((label.to_string(), to_hex(&ctx), verified, hex32(&pres.n), wire.len()));
    }

    // ── Adversarial checks (must all hold) ──
    let ctx_a = context_tag(labels[0]);
    let base = present(&cred, &attrs, &gens, &iparams, &ctx_a, &[], &PresentRandomness::random());

    // forged nullifier (different ms) → reject
    let mut forged = base;
    forged.n = nullifier(&random_scalar(), &ctx_a);
    let forged_rejected = !verify(&forged, &sk, &gens, &iparams, &ctx_a, &[]);

    // wrong context → reject
    let wrong_ctx_rejected = !verify(&base, &sk, &gens, &iparams, &context_tag("other:ctx"), &[]);

    // non-canonical wire → rejected at parse
    let mut bad = base.to_bytes();
    for b in bad[7 * 32..8 * 32].iter_mut() {
        *b = 0xff;
    }
    let noncanonical_rejected = Presentation::from_bytes(&bad).is_none();

    let nullifiers_differ = shows[0].3 != shows[1].3;
    let all_ok = ms_pok_ok
        && issuance_ok
        && shows.iter().all(|s| s.2)
        && forged_rejected
        && wrong_ctx_rejected
        && noncanonical_rejected
        && nullifiers_differ;

    eprintln!(
        "[3] checks: forged_rejected={forged_rejected} wrong_ctx_rejected={wrong_ctx_rejected} \
         noncanonical_rejected={noncanonical_rejected} nullifiers_differ={nullifiers_differ}"
    );
    eprintln!("[4] ALL_OK = {all_ok}");

    // ── Evidence JSON to stdout ──
    let shows_json: Vec<serde_json::Value> = shows
        .iter()
        .map(|(label, ctx, ver, n, wlen)| {
            serde_json::json!({
                "context_label": label,
                "context_hex": ctx,
                "verified": ver,
                "nullifier_hex": n,
                "presentation_wire_len": wlen,
            })
        })
        .collect();

    let out = serde_json::json!({
        "scheme": "KVAC keyed-verification anonymous credential (MAC_GGM / ristretto255)",
        "crate": "dark-kvac",
        "source": "CMZ 2013 (eprint 2013/516) + Signal 2019 (eprint 2019/1416)",
        "mainnet_ready": dark_kvac::MAINNET_READY,
        "is_stub": dark_kvac::IS_STUB,
        "credential": { "tier": tier, "spend_cap": cap, "attributes_hidden": true },
        "ms_pok_verified": ms_pok_ok,
        "issuance_proof_verified": issuance_ok,
        "iparams_I_hex": hex32(&iparams.i),
        "iparams_CW_hex": hex32(&iparams.cw),
        "shows": shows_json,
        "adversarial_checks": {
            "forged_nullifier_rejected": forged_rejected,
            "wrong_context_rejected": wrong_ctx_rejected,
            "noncanonical_wire_rejected": noncanonical_rejected,
            "nullifiers_differ_across_context": nullifiers_differ,
        },
        "all_ok": all_ok,
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());

    if !all_ok {
        std::process::exit(1);
    }
}
