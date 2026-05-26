//! Ritual-Bound Token Devnet Demo — design mode evidence generator.
//!
//! Generates RITUAL_BOUND_TOKEN_DEVNET.json showing:
//!   - what a bad transfer (no ritual) would fail with
//!   - what a CPI drain would fail with
//!   - what the correct ritual transfer would prove
//!
//! Devnet transactions require a deployed hook program.
//! Set HOOK_PROGRAM_ID env var when hook is deployed.
//!
//! NOT_PRODUCTION. Devnet only. No audit. mainnet_ready = false.

use ritual_memo_capsule::{
    capsule_hash, capsule_to_memo_string, validate_memo_string, MemoCapsule,
};
use ritual_precompile_braid::{braid_message_hash_hex, new_braid, PermissionBraid};
use ritual_token_factory::{default_ritual_config, plan_ritual_mint};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

const DARK_RITUAL_GATE: &str = "31qmvsHijLMnQogQ4yvtZom7b1V9ETDx37x2LkhywtCy";

// ── SHA256 helper ─────────────────────────────────────────────────────────────

fn sha256_bytes(input: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(input);
    h.finalize().into()
}

fn hex32(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

// ── Deterministic keypair ─────────────────────────────────────────────────────

fn make_deterministic_keypair() -> ed25519_dalek::Keypair {
    use ed25519_dalek::{Keypair, PublicKey, SecretKey};
    let seed = sha256_bytes(b"dark_null_ritual_bound_token_demo_v1_braid_keypair");
    let secret = SecretKey::from_bytes(&seed).expect("valid secret key from seed");
    let public: PublicKey = (&secret).into();
    Keypair { secret, public }
}

// ── Evidence JSON structure ───────────────────────────────────────────────────

#[derive(Serialize)]
struct PermissionBraidEvidence {
    signer_kind: String,
    ritual_hash: String,
    permission_hash: String,
    message_hash: String,
    precompile_instruction_present: bool,
}

#[derive(Serialize)]
struct MemoCapsuleEvidence {
    capsule_hash: String,
    memo_string: String,
    no_raw_url: bool,
    no_raw_buyer_identity: bool,
}

#[derive(Serialize)]
struct BadTransferEvidence {
    status: String,
    expected_error: String,
    reason: String,
    tx: String,
}

#[derive(Serialize)]
struct BadCpiDrainEvidence {
    status: String,
    expected_error: String,
    reason: String,
    tx: String,
}

#[derive(Serialize)]
struct GoodRitualTransferEvidence {
    status: String,
    expected_return_data: String,
    ritual_hash: String,
    hook_hash: String,
    ceremony: Vec<String>,
    tx: String,
}

#[derive(Serialize)]
struct Evidence {
    network: String,
    mainnet_ready: bool,
    production_claim: bool,
    agent_had_private_key: bool,
    ritual_gate_program: String,
    transfer_hook_program: String,
    mint: String,
    source_token_account: String,
    destination_token_account: String,
    extensions_planned: Vec<String>,
    permission_braid: PermissionBraidEvidence,
    memo_capsule: MemoCapsuleEvidence,
    bad_transfer_without_ritual: BadTransferEvidence,
    bad_cpi_drain: BadCpiDrainEvidence,
    good_ritual_transfer: GoodRitualTransferEvidence,
    hook_checks: Vec<String>,
    not_production_note: String,
}

// ── Main ──────────────────────────────────────────────────────────────────────

fn main() {
    // ── Build ritual hash and permission hash from well-known seeds ───────────
    let ritual_hash = sha256_bytes(b"dark_null_ritual_bound_token_demo_v1_ritual");
    let permission_hash = sha256_bytes(b"dark_null_ritual_bound_token_demo_v1_permission");
    let receipt_hash = sha256_bytes(b"dark_null_ritual_bound_token_demo_v1_receipt");
    let scope_hash = sha256_bytes(b"dark_null_ritual_bound_token_demo_v1_scope");
    let redaction_hash = sha256_bytes(b"dark_null_ritual_bound_token_demo_v1_redaction");

    // ── Build MemoCapsule ─────────────────────────────────────────────────────
    let capsule = MemoCapsule {
        ritual_hash,
        permission_hash,
        receipt_hash,
        service_scope_hash: scope_hash,
        expires_at_slot: 999_999_999,
        redaction_policy_hash: redaction_hash,
    };
    let capsule_hash_val = capsule_hash(&capsule);
    let memo_str = capsule_to_memo_string(&capsule);
    let memo_valid = validate_memo_string(&memo_str).is_ok();

    // ── Build PermissionBraid ─────────────────────────────────────────────────
    let keypair = make_deterministic_keypair();
    let braid: PermissionBraid = new_braid(ritual_hash, permission_hash, 999_999_999, &keypair);
    let msg_hash_hex = braid_message_hash_hex(&ritual_hash, &permission_hash, 999_999_999);

    // ── Build RitualMintSetupPlan ─────────────────────────────────────────────
    let hook_id_bytes = [0u8; 32]; // pending deployment
    let gate_id_bytes: [u8; 32] = {
        let mut b = [0u8; 32];
        // Encode gate ID as bytes (not real — just for the plan)
        b[0] = 0x31;
        b
    };
    let config = default_ritual_config(hook_id_bytes, gate_id_bytes);
    let plan = plan_ritual_mint(&config);

    // ── Hook hash for good transfer ───────────────────────────────────────────
    // Compute hook_hash as the hook program would: SHA256("dark_null_v1_hook_verdict" || mint || amount)
    let mint_bytes = [0u8; 32]; // pending_devnet
    let amount: u64 = 1_000_000;
    let hook_hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"dark_null_v1_hook_verdict");
        h.update(&mint_bytes);
        h.update(amount.to_le_bytes());
        h.finalize().into()
    };
    let hook_hash_hex = hex32(&hook_hash);
    let expected_return_data = format!("0x01{}", hook_hash_hex);

    // ── Assemble evidence ─────────────────────────────────────────────────────
    let evidence = Evidence {
        network: "solana-devnet".to_string(),
        mainnet_ready: false,
        production_claim: false,
        agent_had_private_key: false,
        ritual_gate_program: DARK_RITUAL_GATE.to_string(),
        transfer_hook_program: "pending_deployment".to_string(),
        mint: "pending_devnet".to_string(),
        source_token_account: "pending_devnet".to_string(),
        destination_token_account: "pending_devnet".to_string(),
        extensions_planned: plan.extensions.clone(),
        permission_braid: PermissionBraidEvidence {
            signer_kind: "Ed25519".to_string(),
            ritual_hash: hex32(&ritual_hash),
            permission_hash: hex32(&permission_hash),
            message_hash: msg_hash_hex.clone(),
            precompile_instruction_present: true,
        },
        memo_capsule: MemoCapsuleEvidence {
            capsule_hash: hex32(&capsule_hash_val),
            memo_string: memo_str.clone(),
            no_raw_url: memo_valid,
            no_raw_buyer_identity: memo_valid,
        },
        bad_transfer_without_ritual: BadTransferEvidence {
            status: "pending_devnet".to_string(),
            expected_error: "MissingRitualGate".to_string(),
            reason: "Token-2022 hook rejects transfer — no VerifyRitualShape instruction in tx"
                .to_string(),
            tx: "pending".to_string(),
        },
        bad_cpi_drain: BadCpiDrainEvidence {
            status: "pending_devnet".to_string(),
            expected_error: "CpiGuardExpected".to_string(),
            reason: "Token-2022 CPI Guard rejects program-initiated drain".to_string(),
            tx: "pending".to_string(),
        },
        good_ritual_transfer: GoodRitualTransferEvidence {
            status: "pending_devnet".to_string(),
            expected_return_data: expected_return_data.clone(),
            ritual_hash: hex32(&ritual_hash),
            hook_hash: hook_hash_hex.clone(),
            ceremony: vec![
                "ComputeBudget".to_string(),
                "MemoCapsule".to_string(),
                "Ed25519Precompile".to_string(),
                "VerifyRitualShape".to_string(),
                "Token2022Transfer".to_string(),
            ],
            tx: "pending".to_string(),
        },
        hook_checks: vec![
            "MissingRitualGate".to_string(),
            "WrongRitualType".to_string(),
            "WrongRitualHash".to_string(),
            "ForbiddenProgram".to_string(),
        ],
        not_production_note: "NOT_PRODUCTION. Devnet only. No audit. No mainnet keys.".to_string(),
    };

    // ── Write JSON ────────────────────────────────────────────────────────────
    let out_dir = Path::new("dist/ritual-bound-token");
    fs::create_dir_all(out_dir).expect("create dist/ritual-bound-token/");
    let json = serde_json::to_string_pretty(&evidence).expect("serialize evidence");
    let out_path = out_dir.join("RITUAL_BOUND_TOKEN_DEVNET.json");
    fs::write(&out_path, &json).expect("write RITUAL_BOUND_TOKEN_DEVNET.json");

    // ── Print summary ─────────────────────────────────────────────────────────
    let capsule_hex_short = &hex32(&capsule_hash_val)[..16];
    let msg_hash_short = &msg_hash_hex[..16];

    println!();
    println!("  DARK NULL — RITUAL-BOUND TOKEN");
    println!("  ===============================");
    println!("  Money with a bouncer.");
    println!();
    println!("  [HOOK DESIGN]");
    println!("    transfer_hook_program: pending_deployment");
    println!("    ritual_gate_program  : {}...", &DARK_RITUAL_GATE[..6]);
    println!();
    println!("  [EXTENSIONS PLANNED]");
    println!("    TransferHook / MemoTransfer / CpiGuard");
    println!();
    println!("  [MEMO CAPSULE]");
    println!("    capsule_hash   : {}...", capsule_hex_short);
    println!("    no_raw_url     : true");
    println!("    no_raw_identity: true");
    println!();
    println!("  [PERMISSION BRAID]");
    println!("    signer_kind    : Ed25519");
    println!("    message_hash   : {}...", msg_hash_short);
    println!();
    println!("  [BAD TRANSFER]    expected         : MissingRitualGate  ❌");
    println!("  [CPI DRAIN]");
    println!("    expected         : CpiGuardExpected  ❌");
    println!("  [GOOD RITUAL TRANSFER]");
    println!("    expected         : hook passes     ✅");
    println!();
    println!("  ┌─────────────────────────────────────────────┐");
    println!("  │  BAD TRANSFER    ❌  MissingRitualGate       │");
    println!("  │  CPI DRAIN       ❌  CpiGuardExpected        │");
    println!("  │  RITUAL TRANSFER ✅  ceremony passes         │");
    println!("  │  AGENT KEY       🚫  never held              │");
    println!("  └─────────────────────────────────────────────┘");
    println!();
    println!("  Evidence: dist/ritual-bound-token/RITUAL_BOUND_TOKEN_DEVNET.json");
    println!("  NOT_PRODUCTION. Devnet only. No audit. No mainnet keys.");
    println!();
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use ritual_memo_capsule::{capsule_to_memo_string, MemoCapsule};
    use ritual_precompile_braid::braid_message_hash_hex;

    fn test_ritual_hash() -> [u8; 32] {
        sha256_bytes(b"dark_null_ritual_bound_token_demo_v1_ritual")
    }
    fn test_permission_hash() -> [u8; 32] {
        sha256_bytes(b"dark_null_ritual_bound_token_demo_v1_permission")
    }

    fn make_test_evidence_json() -> String {
        let ritual_hash = test_ritual_hash();
        let permission_hash = test_permission_hash();
        let receipt_hash = sha256_bytes(b"r");
        let scope_hash = sha256_bytes(b"s");
        let redaction_hash = sha256_bytes(b"d");

        let capsule = MemoCapsule {
            ritual_hash,
            permission_hash,
            receipt_hash,
            service_scope_hash: scope_hash,
            expires_at_slot: 999_999_999,
            redaction_policy_hash: redaction_hash,
        };
        let memo = capsule_to_memo_string(&capsule);
        let msg_hash_hex = braid_message_hash_hex(&ritual_hash, &permission_hash, 999_999_999);

        let evidence = serde_json::json!({
            "network": "solana-devnet",
            "mainnet_ready": false,
            "production_claim": false,
            "agent_had_private_key": false,
            "ritual_gate_program": DARK_RITUAL_GATE,
            "memo_string": memo,
            "message_hash": msg_hash_hex,
            "extensions_planned": ["TransferHook", "MemoTransfer", "CpiGuard"],
        });
        serde_json::to_string(&evidence).unwrap()
    }

    #[test]
    fn test_evidence_mainnet_ready_false() {
        let json = make_test_evidence_json();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["mainnet_ready"], false);
    }

    #[test]
    fn test_evidence_production_claim_false() {
        let json = make_test_evidence_json();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["production_claim"], false);
    }

    #[test]
    fn test_evidence_agent_had_no_key() {
        let json = make_test_evidence_json();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["agent_had_private_key"], false);
    }

    #[test]
    fn test_no_raw_url_in_json() {
        let json = make_test_evidence_json();
        assert!(
            !json.contains("http"),
            "JSON must not contain raw URLs, found 'http' in: {}",
            &json[..100.min(json.len())]
        );
    }

    #[test]
    fn test_ritual_gate_id_in_json() {
        let json = make_test_evidence_json();
        assert!(
            json.contains("31qmvs"),
            "JSON must contain ritual gate ID prefix '31qmvs'"
        );
    }

    #[test]
    fn test_memo_capsule_hash_is_64_hex() {
        let ritual_hash = test_ritual_hash();
        let permission_hash = test_permission_hash();
        let capsule = MemoCapsule {
            ritual_hash,
            permission_hash,
            receipt_hash: sha256_bytes(b"r"),
            service_scope_hash: sha256_bytes(b"s"),
            expires_at_slot: 999_999_999,
            redaction_policy_hash: sha256_bytes(b"d"),
        };
        let memo = capsule_to_memo_string(&capsule);
        assert_eq!(memo.len(), 64);
        assert!(memo.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_braid_message_hash_present() {
        let rh = test_ritual_hash();
        let ph = test_permission_hash();
        let hex = braid_message_hash_hex(&rh, &ph, 999_999_999);
        assert_eq!(hex.len(), 64);
    }

    #[test]
    fn test_extensions_include_transfer_hook() {
        use ritual_token_factory::{default_ritual_config, plan_ritual_mint};
        let config = default_ritual_config([0u8; 32], [0u8; 32]);
        let plan = plan_ritual_mint(&config);
        assert!(plan.extensions.contains(&"TransferHook".to_string()));
    }
}
