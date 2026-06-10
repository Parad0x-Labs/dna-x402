//! x402 × KVAC gateway e2e: an agent makes anonymous paid calls; the gateway
//! grants access by verifying a KVAC credential (never learning who the agent is)
//! and rate-limits by recording the per-(resource,epoch) nullifier on-chain.
//!
//! Emits an evidence JSON (stdout) with an ordered `records` plan the devnet
//! harness executes: same (resource,epoch) twice ⇒ the 2nd is rate-limited;
//! new epoch or new resource ⇒ a fresh nullifier ⇒ allowed.

use curve25519_dalek::scalar::Scalar;
use dark_kvac::present::PresentRandomness;
use dark_kvac::util::{random_scalar, random_scalars};
use dark_kvac::{attr_scalars, commit_ms, fresh_u, issue, present, Credential, Generators, IssuerParams};
use dark_x402_core::X402PaymentRequirement;
use dark_x402_kvac::{x402_context, AccessDecision, KvacGate};

fn to_hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 2);
    for byte in b {
        s.push_str(&format!("{:02x}", byte));
    }
    s
}

fn req(resource: &str) -> X402PaymentRequirement {
    X402PaymentRequirement {
        scheme: "exact".into(),
        network: "solana-devnet".into(),
        asset: "SOL".into(),
        amount_lamports: 1_000_000,
        pay_to: [0xAA; 32],
        resource: resource.into(),
        expires_at_slot: u64::MAX,
        nonce: [1, 2, 3, 4, 5, 6, 7, 8],
        facilitator_url: None,
    }
}

/// Issue one credential to an agent (ms withheld via PoK).
fn issue_to_agent(
    gate: &KvacGate,
    gens: &Generators,
    iparams: &IssuerParams,
) -> (Credential, [Scalar; 3]) {
    let ms = random_scalar();
    let (m3, pok) = commit_ms(gens, &ms, random_scalar());
    assert!(dark_kvac::issue::verify_ms_pok(gens, &m3, &pok));
    let (cred, _ip) = issue(
        gate.secret_key(),
        gens,
        iparams,
        Scalar::from(2u64),       // tier
        Scalar::from(1_000_000u64), // spend_cap
        m3,
        random_scalar(),
        fresh_u(b"x402-kvac-U"),
        random_scalars::<7>(),
    );
    (cred, attr_scalars(2, 1_000_000, ms))
}

fn main() {
    eprintln!("== x402 × KVAC gateway e2e ==");
    let gate = KvacGate::new(dark_kvac::IssuerSecretKey::random());
    let gens = gate.generators().clone();
    let iparams = gate.iparams();

    let (cred, attrs) = issue_to_agent(&gate, &gens, &iparams);
    eprintln!("[issue] agent holds a tier-2 credential (gateway does NOT know which agent)");

    let resource_a = req("https://gateway.dna/x402/infer");
    let resource_b = req("https://gateway.dna/x402/embed");

    // helper: agent presents for (req, epoch); gateway decides; return (nullifier_hex, wire_hex)
    let show = |r: &X402PaymentRequirement, epoch: u64| -> (String, String, bool) {
        let ctx = x402_context(r, epoch);
        let pres = present(&cred, &attrs, &gens, &iparams, &ctx, &[], &PresentRandomness::random());
        let wire = pres.to_bytes();
        match gate.verify_access(&wire, r, epoch, &[]) {
            AccessDecision::Granted { nullifier } => (to_hex(&nullifier), to_hex(&wire), true),
            _ => (String::new(), to_hex(&wire), false),
        }
    };

    // 1+2: two unlinkable shows, SAME (resource A, epoch 7)
    let (n_a7_1, wire1, ok1) = show(&resource_a, 7);
    let (n_a7_2, wire2, ok2) = show(&resource_a, 7);
    // 3: new epoch
    let (n_a8, _w, ok3) = show(&resource_a, 8);
    // 4: new resource
    let (n_b7, _w, ok4) = show(&resource_b, 7);

    let unlinkable = wire1 != wire2; // different bytes ...
    let same_nullifier = n_a7_1 == n_a7_2; // ... same rate-limit key
    let epoch_fresh = n_a8 != n_a7_1;
    let resource_fresh = n_b7 != n_a7_1;

    eprintln!("[show] A/e7 #1 granted={ok1} n={}", &n_a7_1[..16]);
    eprintln!("[show] A/e7 #2 granted={ok2} n={} (unlinkable_bytes={unlinkable} same_nullifier={same_nullifier})", &n_a7_2[..16]);
    eprintln!("[show] A/e8     granted={ok3} n={} (epoch_fresh={epoch_fresh})", &n_a8[..16]);
    eprintln!("[show] B/e7     granted={ok4} n={} (resource_fresh={resource_fresh})", &n_b7[..16]);

    // 5: adversarial — malformed + forged-issuer
    let malformed_denied = gate.verify_access(&[0u8; 10], &resource_a, 7, &[]) == AccessDecision::DeniedMalformed;
    let forged_gate = KvacGate::new(dark_kvac::IssuerSecretKey::random());
    let (fcred, fattrs) = issue_to_agent(&forged_gate, &gens, &forged_gate.iparams());
    let fctx = x402_context(&resource_a, 7);
    let fpres = present(&fcred, &fattrs, &gens, &forged_gate.iparams(), &fctx, &[], &PresentRandomness::random());
    let forged_denied = gate.verify_access(&fpres.to_bytes(), &resource_a, 7, &[]) == AccessDecision::DeniedInvalidProof;
    eprintln!("[adv] malformed_denied={malformed_denied} forged_issuer_denied={forged_denied}");

    let all_ok = ok1 && ok2 && ok3 && ok4 && unlinkable && same_nullifier && epoch_fresh
        && resource_fresh && malformed_denied && forged_denied;
    eprintln!("[done] ALL_OK={all_ok}");

    // ordered on-chain record plan
    let records = serde_json::json!([
        { "label": "A/epoch7 first call", "resource": resource_a.resource, "epoch": 7, "nullifier": n_a7_1, "expect": "success" },
        { "label": "A/epoch7 replay (same agent, same epoch)", "resource": resource_a.resource, "epoch": 7, "nullifier": n_a7_2, "expect": "rate-limited (AlreadyRecorded)" },
        { "label": "A/epoch8 (new epoch)", "resource": resource_a.resource, "epoch": 8, "nullifier": n_a8, "expect": "success" },
        { "label": "B/epoch7 (new resource)", "resource": resource_b.resource, "epoch": 7, "nullifier": n_b7, "expect": "success" },
    ]);

    let out = serde_json::json!({
        "demo": "x402 × KVAC — anonymous tiered access with per-(resource,epoch) rate-limit",
        "gateway_learns_agent_identity": false,
        "x402_requirements": {
            "resource_A": { "resource": resource_a.resource, "scope_hash": to_hex(&resource_a.scope_hash()) },
            "resource_B": { "resource": resource_b.resource, "scope_hash": to_hex(&resource_b.scope_hash()) },
        },
        "properties": {
            "two_shows_same_context_unlinkable_bytes": unlinkable,
            "two_shows_same_context_same_nullifier": same_nullifier,
            "new_epoch_fresh_nullifier": epoch_fresh,
            "new_resource_fresh_nullifier": resource_fresh,
            "malformed_denied": malformed_denied,
            "forged_issuer_denied": forged_denied,
        },
        "records": records,
        "all_ok": all_ok,
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
    if !all_ok {
        std::process::exit(1);
    }
}
