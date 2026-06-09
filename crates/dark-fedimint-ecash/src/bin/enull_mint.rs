//! `enull_mint` — CLI bridge between the Rust federation crypto and the node
//! devnet e2e harness.
//!
//! It performs the full client+federation flow in one shot and emits the redeem
//! artifact (and the group key for InitMint) as JSON. The node script then only
//! has to submit transactions — all curve math stays in Rust.
//!
//! Usage:
//!   enull_mint issue   <out.json> [--n N --t T --secret HEX]
//!       Runs a t-of-n DKG, blind-signs a fresh token with t guardians,
//!       unblinds it, builds a threshold DLEQ, and writes:
//!         { group_pub_hex, denomination?, artifact:{...}, federation:{n,t,signers},
//!           checks:{...} }
//!
//!   enull_mint under-threshold <out.json> [--n N --t T]
//!       Same DKG but signs with only t-1 guardians -> proves the resulting token
//!       FAILS local BDHKE verification (mechanics of "fewer than k cannot issue").
//!
//! All randomness is OS RNG. No secret keys are ever written to disk.

use std::env;
use std::fs;

use dark_fedimint_ecash::bdhke::{
    blind, hash_to_curve, nullifier, public_key, unblind, verify_token, Token,
};
use dark_fedimint_ecash::dleq::verify_dleq;
use dark_fedimint_ecash::federation::{
    combine_partial_sigs, dkg, partial_blind_sign, rand_scalar_os, threshold_dleq, GuardianShare,
};
use dark_fedimint_ecash::token::RedeemArtifact;
use rand::rngs::OsRng;

fn hexs(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push_str(&format!("{x:02x}"));
    }
    s
}

fn arg_val(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1).cloned())
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        eprintln!(
            "usage: enull_mint <issue|under-threshold> <out.json> [--n N --t T --secret HEX]"
        );
        std::process::exit(2);
    }
    let mode = args[1].as_str();
    let out_path = args[2].clone();

    let n: u32 = arg_val(&args, "--n")
        .and_then(|s| s.parse().ok())
        .unwrap_or(3);
    let t: u32 = arg_val(&args, "--t")
        .and_then(|s| s.parse().ok())
        .unwrap_or(2);

    // Token secret: caller-provided hex or fresh random. The high byte is left
    // unconstrained (secret feeds a hash-to-curve, not a scalar, so any bytes ok).
    let secret: Vec<u8> = match arg_val(&args, "--secret") {
        Some(h) => (0..h.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap())
            .collect(),
        None => {
            use rand::RngCore;
            let mut b = [0u8; 32];
            OsRng.fill_bytes(&mut b);
            b.to_vec()
        }
    };

    // ── DKG: t-of-n guardian federation, no single party holds k ──────────────
    let res = dkg(n, t);

    // choose the signing set
    let num_signers = if mode == "under-threshold" {
        (t.saturating_sub(1)).max(1) // deliberately too few (or 1 if t==1)
    } else {
        t
    };
    let signers: Vec<GuardianShare> = res
        .guardians
        .iter()
        .take(num_signers as usize)
        .cloned()
        .collect();
    let signer_indices: Vec<u32> = signers.iter().map(|g| g.index).collect();

    // ── client blinds the secret ──────────────────────────────────────────────
    let r = rand_scalar_os();
    let bm = blind(&secret, r);

    // ── federation: each chosen guardian partial-signs the blinded point ──────
    let partials: Vec<(u32, [u8; 32])> = signers
        .iter()
        .map(|g| partial_blind_sign(g, &bm.b_).expect("partial sign"))
        .collect();
    let c_blind = combine_partial_sigs(&partials).expect("combine");

    // ── client unblinds with the group key ────────────────────────────────────
    let group_pub = res.public.group_pub;
    let c = unblind(&c_blind, &group_pub, &bm.r).expect("unblind");
    let token = Token {
        secret: secret.clone(),
        c,
    };

    // local mint-side verification (knows k only for this single-process sim/test)
    let local_verify = verify_token(&res.k_for_tests, &token);

    // ── threshold DLEQ for the on-chain redeem (uses the SAME signer set) ──────
    let proof = threshold_dleq(&signers, &res.public, &secret);
    let y_bytes = hash_to_curve(&secret).compress().to_bytes();
    let dleq_ok = verify_dleq(&group_pub, &y_bytes, &c, &proof);

    let artifact = RedeemArtifact::new(&secret, c, proof, group_pub);

    // cross-check: combined-sig C must equal a single-mint C under k (sanity that
    // threshold == single when (and only when) enough guardians cooperate)
    let single_c = {
        let single_blind =
            dark_fedimint_ecash::bdhke::sign_blinded(&res.k_for_tests, &bm.b_).unwrap();
        unblind(&single_blind, &group_pub, &bm.r).unwrap()
    };
    let matches_single = c == single_c;

    let out = serde_json::json!({
        "mode": mode,
        "federation": { "n": n, "t": t, "signers": num_signers, "signerIndices": signer_indices },
        "groupPubHex": hexs(&group_pub),
        "secretHex": hexs(&secret),
        "nullifierHex": hexs(&nullifier(&secret)),
        "artifact": artifact,
        "checks": {
            "localBdhkeVerify": local_verify,
            "dleqVerify": dleq_ok,
            "thresholdMatchesSingleMint": matches_single,
        },
        // for tests/inspection only — NOT used by the chain (the chain knows only K)
        "_kPubFromShares": hexs(&public_key(&res.k_for_tests)),
    });

    fs::write(
        &out_path,
        serde_json::to_string_pretty(&out).unwrap() + "\n",
    )
    .expect("write out");
    // human summary on stderr (stdout stays clean for piping if needed)
    eprintln!(
        "[enull_mint] {mode}: {num_signers}-signer of {t}-of-{n} | localVerify={} dleq={} matchesSingle={}",
        local_verify, dleq_ok, matches_single
    );
}
