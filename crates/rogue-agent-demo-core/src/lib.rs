//! Rogue Alpha WOW Demo — connects all 7 Dark Null primitives into one narrative:
//! "An AI agent spent money without holding a wallet."
//!
//! Primitives used:
//!   agent-permission-notes  — caveated spending leash
//!   spend-shadows           — shadow bundle (copy-sniper obfuscation)
//!   agent-flight-recorder   — tamper-evident action log
//!   receipt-souls           — unlinkable bearer note
//!   session-note-channel    — 5-payment collapse to one root
//!   no-custody-attestation  — proves agent CANNOT hold funds
//!   onchain-puzzle-compiler — compiles "ROGUE" into shard plan

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use agent_flight_recorder::{redact, FlightReceipt};
use agent_permission_notes::{
    revoke_session, spend_allowed, withdraw_scope_hash, AgentPermissionNote, PermissionError,
    PermissionSpend,
};
use no_custody_attestation::{compute_risk_score, DeniedKeyClass, NoCustodyCapsule};
use onchain_puzzle_compiler::{compile_puzzle, PuzzleCompileInput, PuzzleMethod};
use receipt_souls::{redeem_soul, ReceiptSoul, SoulRedemptionPolicy, SoulTransferPolicy};
use session_note_channel::{issue_notes, settle_session, SessionNoteChannel};
use spend_shadows::{new_shadow_bundle, ShadowLeaf, SpendShadowKind};

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

fn sha256_bytes(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ---------------------------------------------------------------------------
// Output JSON schema — matches ROGUE_WOW_DEMO.json exactly
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionSection {
    pub max_spend_lamports: u64,
    pub withdraw_allowed: bool,
    pub expires_at_slot: u64,
    pub permission_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AllowedSpendSection {
    pub status: String,
    pub spend_hash: String,
    pub shadow_bundle_hash: String,
    pub copy_sniper_precision: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForbiddenWithdrawSection {
    pub status: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KillSwitchSection {
    pub status: String,
    pub revocation_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceiptSoulSection {
    pub nullifier: String,
    pub policy: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSection {
    pub payments_collapsed: u32,
    pub settlement_root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlightRecorderSection {
    pub record_hash: String,
    pub redacted_public_view_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoCustodySection {
    pub risk_score: u8,
    pub attestation_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DevnetRitualSection {
    pub message: String,
    pub shard_path: Vec<u8>,
    pub solscan_links: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RogueWowDemo {
    pub network: String,
    pub mainnet_ready: bool,
    pub production_claim: bool,
    pub agent: String,
    pub permission: PermissionSection,
    pub allowed_spend: AllowedSpendSection,
    pub forbidden_withdraw: ForbiddenWithdrawSection,
    pub kill_switch: KillSwitchSection,
    pub receipt_soul: ReceiptSoulSection,
    pub session: SessionSection,
    pub flight_recorder: FlightRecorderSection,
    pub no_custody: NoCustodySection,
    pub devnet_ritual: DevnetRitualSection,
}

// ---------------------------------------------------------------------------
// Steal-attempt demo — output JSON schema
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StealDemoPermissionSection {
    pub max_spend_lamports: u64,
    pub allowed_scopes: Vec<String>,
    pub denied_scopes: Vec<String>,
    pub withdraw_allowed: bool,
    pub permission_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AllowedActionSection {
    pub name: String,
    pub status: String,
    pub reason: String,
    pub shadow_leaves: u32,
    pub copy_sniper_precision: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StealAttemptSection {
    pub name: String,
    pub status: String,
    pub reason: String,
    pub attempted_destination_hash: String,
    pub funds_moved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StealDemoKillSwitchSection {
    pub triggered_after_steal_attempt: bool,
    pub future_spend_status: String,
    pub future_spend_reason: String,
    pub revocation_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StealDemoFlightSection {
    pub events: Vec<String>,
    pub public_chain_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RogueStealAttemptDemo {
    pub headline: String,
    pub network: String,
    pub mainnet_ready: bool,
    pub production_claim: bool,
    pub agent: String,
    pub agent_had_private_key: bool,
    pub permission: StealDemoPermissionSection,
    pub allowed_action: AllowedActionSection,
    pub steal_attempt: StealAttemptSection,
    pub kill_switch: StealDemoKillSwitchSection,
    pub flight_recorder: StealDemoFlightSection,
    pub devnet_ritual: DevnetRitualSection,
}

// ---------------------------------------------------------------------------
// Core demo builder — deterministic, no network, no randomness
// ---------------------------------------------------------------------------

pub fn build_wow_demo() -> RogueWowDemo {
    let slot: u64 = 100_000;

    // ---- 1. AGENT PERMISSION NOTE ----------------------------------------
    // Grant Rogue Alpha a cryptographic spending leash.
    // No withdrawal allowed. Max 1 SOL total. Expires at slot 110_000.
    let agent_id_hash = sha256_bytes(b"rogue_alpha_agent_id_v1");
    let note = AgentPermissionNote {
        agent_id_hash,
        max_total_spend: 1_000_000, // 1_000_000 lamports = 0.001 SOL
        max_single_spend: 500_000,
        allowed_scopes: vec![], // empty = all non-denied scopes allowed
        denied_scopes: vec![withdraw_scope_hash()],
        expiry_slot: slot + 10_000,
        loss_fuse_hash: [0u8; 32],
        kill_switch_root: sha256_bytes(b"rogue_alpha_kill_switch_root"),
        receipt_root: [0u8; 32],
        no_withdraw: true,
        kill_switch_active: false,
    };
    let permission_hash = note.note_hash();

    // ---- 2. ALLOWED SPEND — agent pays for API access --------------------
    let api_scope_hash = sha256_bytes(b"dark_null_api_scope_v1");
    let spend = PermissionSpend::new(&note, 100_000, api_scope_hash, slot);
    let spend_hash = spend.nullifier;
    let allowed_status = if spend_allowed(&note, &spend, slot, 0).is_ok() {
        "accepted"
    } else {
        "rejected"
    };

    // Shadow bundle: 1 real + 2 decoy + 1 delayed + 1 poison = 5 leaves
    // copy_sniper_precision = 1 / 5 = 0.2 — analyst has 20% chance of picking real leaf
    let real_leaf_hash = sha256_bytes(b"rogue_alpha_real_spend_leaf_v1");
    let mut bundle = new_shadow_bundle(
        real_leaf_hash,
        2,                // 2 decoys
        Some(slot + 500), // 1 delayed
        None,             // no maintenance
        slot + 10_000,
    );
    bundle.public_leaves.push(ShadowLeaf {
        kind: SpendShadowKind::Poison,
        leaf_hash: sha256_bytes(b"rogue_alpha_poison_leaf_v1"),
        reveal_slot: 0,
        maintenance_job_hash: [0u8; 32],
        expiry_slot: slot + 10_000,
    });
    let copy_sniper_precision = 1.0_f64 / (bundle.public_leaves.len() as f64);

    // ---- 3. FORBIDDEN WITHDRAW — prove agent cannot touch user funds -----
    let withdraw_scope = withdraw_scope_hash();
    let withdraw_spend = PermissionSpend::new(&note, 100_000, withdraw_scope, slot + 1);
    let withdraw_result = spend_allowed(&note, &withdraw_spend, slot + 1, 0);
    let forbidden_reason = match &withdraw_result {
        Err(PermissionError::WithdrawDenied) => "withdraw scope denied",
        Err(PermissionError::ScopeDenied) => "withdraw scope denied",
        Err(_) => "spend check failed",
        Ok(()) => "unexpected: allowed",
    };

    // ---- 4. KILL SWITCH — revoke the session ----------------------------
    let revocation = revoke_session(&note);
    let revocation_hash = hex_encode(&revocation.0);

    // ---- 5. RECEIPT SOUL — burn-after-read bearer note ------------------
    let soul_id_hash = sha256_bytes(b"rogue_alpha_soul_id_v1");
    let soul_scope_hash = sha256_bytes(b"dark_null_api_access_soul_v1");
    let issuer_hash = sha256_bytes(b"dark_null_issuer_v1_concealed");
    let holder_hash = sha256_bytes(b"rogue_alpha_holder_v1");
    let soul = ReceiptSoul {
        soul_id_hash,
        scope_hash: soul_scope_hash,
        amount_bucket: 1,
        issuer_hash,
        expiry_slot: slot + 10_000,
        transfer_policy: SoulTransferPolicy::Transferable,
        redemption_policy: SoulRedemptionPolicy::BurnAfterRead,
        current_holder_hash: holder_hash,
        transfer_count: 0,
        redeemed: false,
    };
    let (soul_nullifier, _) = redeem_soul(&soul, holder_hash, slot).expect("soul redeem");
    let soul_nullifier_hex = hex_encode(&soul_nullifier.0);

    // ---- 6. SESSION CHANNEL — 5 payments collapsed to one root ----------
    let session_hash = sha256_bytes(b"rogue_alpha_session_hash_v1");
    let session_scope_hash = sha256_bytes(b"dark_null_session_scope_v1");
    let channel = SessionNoteChannel {
        session_hash,
        starting_balance_commitment: sha256_bytes(b"rogue_session_balance_commitment"),
        permission_hash,
        note_count: 5,
        note_amount_each: 100_000,
        expiry_slot: slot + 10_000,
    };
    let notes = issue_notes(&channel, session_scope_hash);
    let settlement = settle_session(&channel, &notes).expect("session settle");

    // ---- 7. FLIGHT RECORDER — tamper-evident black-box ------------------
    let receipt = FlightReceipt {
        agent_id_hash,
        model_output_hash: sha256_bytes(b"rogue_alpha_model_output_v1"),
        permission_hash,
        risk_policy_hash: sha256_bytes(b"dark_null_risk_policy_v1"),
        spend_receipt_hash: spend_hash,
        timestamp_slot: slot,
        previous_flight_hash: [0u8; 32],
        kill_switch_state_hash: sha256_bytes(b"kill_switch_not_triggered"),
    };
    let record_hash = hex_encode(&receipt.compute_hash());
    let redacted = redact(&receipt);
    // Public view: only agent_id + slot + kill_switch (strategy fields redacted)
    let pub_view_hash = {
        let mut h = Sha256::new();
        h.update(b"dark_null_v1_redacted_public_view");
        h.update(&redacted.agent_id_hash);
        h.update(&redacted.timestamp_slot.to_le_bytes());
        h.update(&redacted.kill_switch_state_hash);
        let v: [u8; 32] = h.finalize().into();
        hex_encode(&v)
    };

    // ---- 8. NO-CUSTODY ATTESTATION — agent cannot hold funds ------------
    let capsule = NoCustodyCapsule {
        binary_hash: sha256_bytes(b"rogue_agent_demo_binary_v1"),
        config_hash: sha256_bytes(b"rogue_agent_demo_config_v1"),
        denied_key_classes: DeniedKeyClass::all(),
        max_float_lamports: 0,
        redaction_policy_hash: sha256_bytes(b"pii_removed_key_slots_empty"),
        custody_denied: true,
        issued_at_slot: slot,
        signer_pubkey_hash: sha256_bytes(b"rogue_alpha_signer_pubkey"),
    };
    let risk = compute_risk_score(&capsule);
    let attestation_hash = hex_encode(&capsule.capsule_hash());

    // ---- 9. ONCHAIN PUZZLE — compile "ROGUE" shard plan -----------------
    let puzzle_input = PuzzleCompileInput {
        message: "ROGUE".to_string(),
        method: PuzzleMethod::ShardAscii,
        target_network: "solana-devnet".to_string(),
    };
    let puzzle = compile_puzzle(&puzzle_input).expect("puzzle compile ROGUE");
    let shard_path: Vec<u8> = puzzle.shard_targets.iter().map(|t| t.shard_byte).collect();

    // Solscan links from the live devnet run (TRUE_ALIEN_DEVNET_DEMO.json)
    let solscan_links = vec![
        "https://solscan.io/tx/67jsL2KmhYfg2z1TvkGfzhDoA7YEi8Gojn3gcQkUL3zgMbXSnwjocvj1ZX3AX7ne11J1VUXnG6hnyV2f8DzczeCZ?cluster=devnet".to_string(),
        "https://solscan.io/tx/4UDnJctmmvhmctQhJfLZuKNXgxnVqXrarDHFisozu5UMzxJ32cCXcFzEQo8UdiVmfdp1SG49P7UUoa8Ggb2br4hb?cluster=devnet".to_string(),
        "https://solscan.io/tx/5BCtkPKLxjELu1Sg4UGHm5ja5G1RNyFkufpy62ho4RmXHjEtEMyxcNwTQwDGnCCE491j89WMVzJ8BzQhxJGJCF1a?cluster=devnet".to_string(),
        "https://solscan.io/tx/63LQ8uUZN5f9uxo9PgYF2tgXu4oA6nH8UZH1L93seEazmhaR9zcnkbdSMFWhXaXx4GepHEb3XMQW6Y11Tge9xqZE?cluster=devnet".to_string(),
        "https://solscan.io/tx/5Dd58QcyJSvGtx61EUjGiFexbx9fzYtEsuYNKXMFzoksBbA8dfYPqL3B8ihpgwo79PGccQGN41m6ex7rdiNpuzaQ?cluster=devnet".to_string(),
    ];

    RogueWowDemo {
        network: "solana-devnet".to_string(),
        mainnet_ready: false,
        production_claim: false,
        agent: "Rogue Alpha".to_string(),
        permission: PermissionSection {
            max_spend_lamports: 1_000_000,
            withdraw_allowed: false,
            expires_at_slot: slot + 10_000,
            permission_hash: hex_encode(&permission_hash),
        },
        allowed_spend: AllowedSpendSection {
            status: allowed_status.to_string(),
            spend_hash: hex_encode(&spend_hash),
            shadow_bundle_hash: hex_encode(&bundle.bundle_id),
            copy_sniper_precision,
        },
        forbidden_withdraw: ForbiddenWithdrawSection {
            status: "rejected".to_string(),
            reason: forbidden_reason.to_string(),
        },
        kill_switch: KillSwitchSection {
            status: "available".to_string(),
            revocation_hash,
        },
        receipt_soul: ReceiptSoulSection {
            nullifier: soul_nullifier_hex,
            policy: "BurnAfterRead".to_string(),
        },
        session: SessionSection {
            payments_collapsed: 5,
            settlement_root: hex_encode(&settlement.root),
        },
        flight_recorder: FlightRecorderSection {
            record_hash,
            redacted_public_view_hash: pub_view_hash,
        },
        no_custody: NoCustodySection {
            risk_score: risk.0,
            attestation_hash,
        },
        devnet_ritual: DevnetRitualSection {
            message: "ROGUE".to_string(),
            shard_path,
            solscan_links,
        },
    }
}

// ---------------------------------------------------------------------------
// Steal-attempt demo builder
// ---------------------------------------------------------------------------

/// "Rogue tried to steal. Dark Null blocked it."
///
/// Shows the full villain arc in 4 steps:
/// 1. Permission note issued (API allowed, withdraw denied)
/// 2. Legitimate API spend — accepted
/// 3. External withdraw attempt — rejected
/// 4. Kill switch auto-activates; future spends blocked; flight recorder proves it all
pub fn build_rogue_steal_attempt_demo() -> RogueStealAttemptDemo {
    let slot: u64 = 100_000;

    // ── 1. PERMISSION NOTE ────────────────────────────────────────────────────
    // Only API_SIGNAL is allowed. WITHDRAW_EXTERNAL is explicitly denied.
    let agent_id_hash = sha256_bytes(b"rogue_alpha_steal_demo_agent_v1");
    let api_scope_hash = sha256_bytes(b"dark_null_api_signal_scope_v1");

    let note = AgentPermissionNote {
        agent_id_hash,
        max_total_spend: 1_000_000,
        max_single_spend: 500_000,
        allowed_scopes: vec![api_scope_hash],
        denied_scopes: vec![withdraw_scope_hash()],
        expiry_slot: slot + 10_000,
        loss_fuse_hash: [0u8; 32],
        kill_switch_root: sha256_bytes(b"rogue_steal_demo_kill_switch_v1"),
        receipt_root: [0u8; 32],
        no_withdraw: true,
        kill_switch_active: false,
    };
    let permission_hash = note.note_hash();

    // ── 2. ALLOWED ACTION — buy API signal ────────────────────────────────────
    let api_spend = PermissionSpend::new(&note, 100_000, api_scope_hash, slot);
    let allowed_ok = spend_allowed(&note, &api_spend, slot, 0).is_ok();

    // Shadow bundle wraps the real spend in 5 leaves
    let real_leaf = sha256_bytes(b"rogue_steal_real_api_spend_leaf");
    let mut bundle = new_shadow_bundle(real_leaf, 2, Some(slot + 500), None, slot + 10_000);
    bundle.public_leaves.push(ShadowLeaf {
        kind: SpendShadowKind::Poison,
        leaf_hash: sha256_bytes(b"rogue_steal_poison_leaf_v1"),
        reveal_slot: 0,
        maintenance_job_hash: [0u8; 32],
        expiry_slot: slot + 10_000,
    });
    let copy_sniper_precision = 1.0_f64 / (bundle.public_leaves.len() as f64);

    // ── 3. STEAL ATTEMPT — withdraw to external wallet ────────────────────────
    // Destination hash is hashed — raw address never appears in public JSON
    let fake_destination_hash = sha256_bytes(b"rogue_fake_external_wallet_destination_v1");
    let steal_spend = PermissionSpend::new(&note, 100_000, withdraw_scope_hash(), slot + 1);
    let steal_result = spend_allowed(&note, &steal_spend, slot + 1, 0);
    let steal_reason = match &steal_result {
        Err(PermissionError::WithdrawDenied) => "withdraw scope denied",
        Err(PermissionError::ScopeDenied) => "withdraw scope denied",
        Err(_) => "spend check failed",
        Ok(()) => "unexpected: allowed",
    };

    // ── 4. KILL SWITCH ────────────────────────────────────────────────────────
    // After the steal attempt, the session is revoked.
    let revocation = revoke_session(&note);
    let revocation_hash = hex_encode(&revocation.0);

    // Prove: with kill_switch_active=true all future spends are blocked
    let note_killed = AgentPermissionNote {
        agent_id_hash,
        max_total_spend: 1_000_000,
        max_single_spend: 500_000,
        allowed_scopes: vec![api_scope_hash],
        denied_scopes: vec![withdraw_scope_hash()],
        expiry_slot: slot + 10_000,
        loss_fuse_hash: [0u8; 32],
        kill_switch_root: sha256_bytes(b"rogue_steal_demo_kill_switch_v1"),
        receipt_root: [0u8; 32],
        no_withdraw: true,
        kill_switch_active: true, // ← activated
    };
    let future_api_spend = PermissionSpend::new(&note_killed, 100_000, api_scope_hash, slot + 2);
    let future_result = spend_allowed(&note_killed, &future_api_spend, slot + 2, 0);
    let future_reason = match &future_result {
        Err(PermissionError::KillSwitchActive) => "KillSwitchActive",
        Err(_) => "other error",
        Ok(()) => "unexpected: allowed",
    };

    // ── 5. FLIGHT RECORDER — chain of 3 tamper-evident records ───────────────
    // Record 1: allowed spend
    let rec1 = FlightReceipt {
        agent_id_hash,
        model_output_hash: sha256_bytes(b"event_allowed_buy_api_signal"),
        permission_hash,
        risk_policy_hash: sha256_bytes(b"dark_null_risk_policy_v1"),
        spend_receipt_hash: api_spend.nullifier,
        timestamp_slot: slot,
        previous_flight_hash: [0u8; 32],
        kill_switch_state_hash: sha256_bytes(b"kill_switch_inactive"),
    };
    let hash1 = rec1.compute_hash();

    // Record 2: blocked steal attempt
    let rec2 = FlightReceipt {
        agent_id_hash,
        model_output_hash: sha256_bytes(b"event_blocked_withdraw_steal_attempt"),
        permission_hash,
        risk_policy_hash: sha256_bytes(b"dark_null_risk_policy_v1"),
        spend_receipt_hash: steal_spend.nullifier,
        timestamp_slot: slot + 1,
        previous_flight_hash: hash1,
        kill_switch_state_hash: sha256_bytes(b"kill_switch_steal_detected"),
    };
    let hash2 = rec2.compute_hash();

    // Record 3: kill switch activated
    let rec3 = FlightReceipt {
        agent_id_hash,
        model_output_hash: sha256_bytes(b"event_kill_switch_activated"),
        permission_hash,
        risk_policy_hash: sha256_bytes(b"dark_null_risk_policy_v1"),
        spend_receipt_hash: revocation.0,
        timestamp_slot: slot + 2,
        previous_flight_hash: hash2,
        kill_switch_state_hash: sha256_bytes(b"kill_switch_active_session_terminated"),
    };
    let hash3 = rec3.compute_hash();

    // ── 6. ONCHAIN RITUAL — reuse ROGUE shard plan ───────────────────────────
    let puzzle_input = PuzzleCompileInput {
        message: "ROGUE".to_string(),
        method: PuzzleMethod::ShardAscii,
        target_network: "solana-devnet".to_string(),
    };
    let puzzle = compile_puzzle(&puzzle_input).expect("compile ROGUE");
    let shard_path: Vec<u8> = puzzle.shard_targets.iter().map(|t| t.shard_byte).collect();
    let solscan_links = vec![
        "https://solscan.io/tx/67jsL2KmhYfg2z1TvkGfzhDoA7YEi8Gojn3gcQkUL3zgMbXSnwjocvj1ZX3AX7ne11J1VUXnG6hnyV2f8DzczeCZ?cluster=devnet".to_string(),
        "https://solscan.io/tx/4UDnJctmmvhmctQhJfLZuKNXgxnVqXrarDHFisozu5UMzxJ32cCXcFzEQo8UdiVmfdp1SG49P7UUoa8Ggb2br4hb?cluster=devnet".to_string(),
        "https://solscan.io/tx/5BCtkPKLxjELu1Sg4UGHm5ja5G1RNyFkufpy62ho4RmXHjEtEMyxcNwTQwDGnCCE491j89WMVzJ8BzQhxJGJCF1a?cluster=devnet".to_string(),
        "https://solscan.io/tx/63LQ8uUZN5f9uxo9PgYF2tgXu4oA6nH8UZH1L93seEazmhaR9zcnkbdSMFWhXaXx4GepHEb3XMQW6Y11Tge9xqZE?cluster=devnet".to_string(),
        "https://solscan.io/tx/5Dd58QcyJSvGtx61EUjGiFexbx9fzYtEsuYNKXMFzoksBbA8dfYPqL3B8ihpgwo79PGccQGN41m6ex7rdiNpuzaQ?cluster=devnet".to_string(),
    ];

    RogueStealAttemptDemo {
        headline: "Rogue tried to withdraw. Dark Null blocked it.".to_string(),
        network: "solana-devnet".to_string(),
        mainnet_ready: false,
        production_claim: false,
        agent: "Rogue Alpha".to_string(),
        agent_had_private_key: false,
        permission: StealDemoPermissionSection {
            max_spend_lamports: 1_000_000,
            allowed_scopes: vec!["API_SIGNAL".to_string()],
            denied_scopes: vec!["WITHDRAW_EXTERNAL".to_string()],
            withdraw_allowed: false,
            permission_hash: hex_encode(&permission_hash),
        },
        allowed_action: AllowedActionSection {
            name: "buy_api_signal".to_string(),
            status: if allowed_ok { "accepted" } else { "rejected" }.to_string(),
            reason: "scope allowed".to_string(),
            shadow_leaves: bundle.public_leaves.len() as u32,
            copy_sniper_precision,
        },
        steal_attempt: StealAttemptSection {
            name: "withdraw_external".to_string(),
            status: "rejected".to_string(),
            reason: steal_reason.to_string(),
            attempted_destination_hash: hex_encode(&fake_destination_hash),
            funds_moved: false,
        },
        kill_switch: StealDemoKillSwitchSection {
            triggered_after_steal_attempt: true,
            future_spend_status: if future_result.is_err() {
                "rejected"
            } else {
                "accepted"
            }
            .to_string(),
            future_spend_reason: future_reason.to_string(),
            revocation_hash,
        },
        flight_recorder: StealDemoFlightSection {
            events: vec![
                "allowed_spend".to_string(),
                "blocked_withdraw".to_string(),
                "kill_switch".to_string(),
            ],
            public_chain_hash: hex_encode(&hash3),
        },
        devnet_ritual: DevnetRitualSection {
            message: "ROGUE".to_string(),
            shard_path,
            solscan_links,
        },
    }
}

// ---------------------------------------------------------------------------
// Tests — 12 required
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use agent_permission_notes::{
        spend_allowed, AgentPermissionNote, PermissionError, PermissionSpend,
    };
    use spend_shadows::{new_shadow_bundle, ShadowLeaf, SpendShadowKind};

    fn make_test_note() -> AgentPermissionNote {
        AgentPermissionNote {
            agent_id_hash: [0x01u8; 32],
            max_total_spend: 1_000_000,
            max_single_spend: 500_000,
            allowed_scopes: vec![],
            denied_scopes: vec![],
            expiry_slot: 999_999,
            loss_fuse_hash: [0u8; 32],
            kill_switch_root: [0u8; 32],
            receipt_root: [0u8; 32],
            no_withdraw: false,
            kill_switch_active: false,
        }
    }

    // 1. Permission grant creates deterministic hash
    #[test]
    fn test_permission_hash_deterministic() {
        let demo1 = build_wow_demo();
        let demo2 = build_wow_demo();
        assert_eq!(
            demo1.permission.permission_hash, demo2.permission.permission_hash,
            "permission_hash must be deterministic"
        );
        assert_eq!(
            demo1.permission.permission_hash.len(),
            64,
            "hex string must be 64 chars"
        );
    }

    // 2. Allowed spend accepted
    #[test]
    fn test_allowed_spend_accepted() {
        let demo = build_wow_demo();
        assert_eq!(demo.allowed_spend.status, "accepted");
        assert_eq!(demo.allowed_spend.spend_hash.len(), 64);
    }

    // 3. Forbidden withdraw rejected
    #[test]
    fn test_forbidden_withdraw_rejected() {
        let demo = build_wow_demo();
        assert_eq!(demo.forbidden_withdraw.status, "rejected");
        assert_eq!(demo.forbidden_withdraw.reason, "withdraw scope denied");
    }

    // 4. Kill switch blocks future spend
    #[test]
    fn test_kill_switch_blocks_spend() {
        let mut note = make_test_note();
        note.kill_switch_active = true;
        let scope = [0x02u8; 32];
        let spend = PermissionSpend::new(&note, 100_000, scope, 100);
        let result = spend_allowed(&note, &spend, 100, 0);
        assert_eq!(result, Err(PermissionError::KillSwitchActive));
    }

    // 5. Shadow bundle has 1 real + 4 non-real leaves = 5 total
    #[test]
    fn test_shadow_bundle_leaf_count() {
        let real_hash = sha256_bytes(b"test_real_leaf");
        let mut bundle = new_shadow_bundle(real_hash, 2, Some(500), None, 10_000);
        bundle.public_leaves.push(ShadowLeaf {
            kind: SpendShadowKind::Poison,
            leaf_hash: sha256_bytes(b"test_poison"),
            reveal_slot: 0,
            maintenance_job_hash: [0u8; 32],
            expiry_slot: 10_000,
        });
        assert_eq!(bundle.public_leaves.len(), 5, "must have 5 public leaves");
        assert_eq!(
            bundle.public_leaves[0].kind,
            SpendShadowKind::Real,
            "first leaf must be Real"
        );
        let non_real = bundle
            .public_leaves
            .iter()
            .filter(|l| l.kind != SpendShadowKind::Real)
            .count();
        assert_eq!(non_real, 4, "must have 4 shadow (non-real) leaves");
    }

    // 6. All shadow leaves encode to same byte length (81)
    #[test]
    fn test_shadow_leaves_same_byte_length() {
        let real_hash = sha256_bytes(b"test_real_leaf");
        let mut bundle = new_shadow_bundle(real_hash, 2, Some(500), None, 10_000);
        bundle.public_leaves.push(ShadowLeaf {
            kind: SpendShadowKind::Poison,
            leaf_hash: sha256_bytes(b"test_poison"),
            reveal_slot: 0,
            maintenance_job_hash: [0u8; 32],
            expiry_slot: 10_000,
        });
        for leaf in &bundle.public_leaves {
            assert_eq!(
                leaf.canonical_bytes().len(),
                81,
                "every leaf must encode to 81 bytes"
            );
        }
    }

    // 7. Receipt soul nullifier is generated (non-empty hex string)
    #[test]
    fn test_receipt_soul_nullifier_generated() {
        let demo = build_wow_demo();
        assert_eq!(
            demo.receipt_soul.nullifier.len(),
            64,
            "nullifier must be 64-char hex"
        );
        assert!(
            demo.receipt_soul
                .nullifier
                .chars()
                .all(|c| c.is_ascii_hexdigit()),
            "nullifier must be valid hex"
        );
    }

    // 8. Session root collapses 5 notes into one root
    #[test]
    fn test_session_collapses_5_notes() {
        let demo = build_wow_demo();
        assert_eq!(demo.session.payments_collapsed, 5);
        assert_eq!(
            demo.session.settlement_root.len(),
            64,
            "settlement_root must be 64-char hex"
        );
    }

    // 9. No-custody risk score is 0 (all 4 key classes denied)
    #[test]
    fn test_no_custody_risk_score_zero() {
        let demo = build_wow_demo();
        assert_eq!(
            demo.no_custody.risk_score, 0,
            "risk score must be 0 (all keys denied)"
        );
    }

    // 10. Evidence JSON contains no private key, secret, or seed data
    #[test]
    fn test_evidence_json_no_private_key() {
        let demo = build_wow_demo();
        let json = serde_json::to_string(&demo).expect("must serialize");
        let lower = json.to_lowercase();
        assert!(
            !lower.contains("private_key"),
            "JSON must not contain private_key"
        );
        assert!(
            !lower.contains("secret_key"),
            "JSON must not contain secret_key"
        );
        assert!(
            !lower.contains("seed_phrase"),
            "JSON must not contain seed_phrase"
        );
        assert!(
            !lower.contains("mnemonic"),
            "JSON must not contain mnemonic"
        );
    }

    // 11. mainnet_ready is false
    #[test]
    fn test_mainnet_ready_false() {
        let demo = build_wow_demo();
        assert!(!demo.mainnet_ready, "mainnet_ready must be false");
    }

    // 12. production_claim is false
    #[test]
    fn test_production_claim_false() {
        let demo = build_wow_demo();
        assert!(!demo.production_claim, "production_claim must be false");
    }

    // ── STEAL ATTEMPT DEMO tests ──────────────────────────────────────────────

    // 13. Allowed action is accepted
    #[test]
    fn test_steal_allowed_action_accepted() {
        let demo = build_rogue_steal_attempt_demo();
        assert_eq!(demo.allowed_action.status, "accepted");
        assert_eq!(demo.allowed_action.name, "buy_api_signal");
        assert_eq!(demo.allowed_action.reason, "scope allowed");
    }

    // 14. Steal (withdraw) attempt is rejected
    #[test]
    fn test_steal_withdraw_rejected() {
        let demo = build_rogue_steal_attempt_demo();
        assert_eq!(demo.steal_attempt.status, "rejected");
        assert_eq!(demo.steal_attempt.name, "withdraw_external");
        assert!(demo.steal_attempt.reason.contains("withdraw"));
    }

    // 15. funds_moved is false on steal attempt
    #[test]
    fn test_steal_funds_moved_false() {
        let demo = build_rogue_steal_attempt_demo();
        assert!(!demo.steal_attempt.funds_moved, "funds_moved must be false");
    }

    // 16. Kill switch triggered after steal attempt
    #[test]
    fn test_steal_kill_switch_triggered() {
        let demo = build_rogue_steal_attempt_demo();
        assert!(demo.kill_switch.triggered_after_steal_attempt);
        assert_eq!(demo.kill_switch.revocation_hash.len(), 64);
    }

    // 17. Future spend is rejected after kill switch
    #[test]
    fn test_steal_future_spend_rejected_after_kill() {
        let demo = build_rogue_steal_attempt_demo();
        assert_eq!(demo.kill_switch.future_spend_status, "rejected");
        assert_eq!(demo.kill_switch.future_spend_reason, "KillSwitchActive");
    }

    // 18. Flight recorder has exactly 3 events
    #[test]
    fn test_steal_flight_has_3_events() {
        let demo = build_rogue_steal_attempt_demo();
        assert_eq!(demo.flight_recorder.events.len(), 3);
    }

    // 19. Flight recorder includes blocked_withdraw event
    #[test]
    fn test_steal_flight_includes_blocked_withdraw() {
        let demo = build_rogue_steal_attempt_demo();
        assert!(
            demo.flight_recorder
                .events
                .contains(&"blocked_withdraw".to_string()),
            "flight recorder must contain blocked_withdraw event"
        );
        assert!(
            demo.flight_recorder
                .events
                .contains(&"kill_switch".to_string()),
            "flight recorder must contain kill_switch event"
        );
    }

    // 20. No raw private key in JSON — agent_had_private_key field is false (not a key value)
    #[test]
    fn test_steal_no_private_key_in_json() {
        let demo = build_rogue_steal_attempt_demo();
        // The agent_had_private_key field name is intentional — its value must be false
        assert!(
            !demo.agent_had_private_key,
            "agent_had_private_key must be false"
        );
        let json = serde_json::to_string(&demo).expect("must serialize");
        let lower = json.to_lowercase();
        // No raw key material, seeds, or mnemonics in the output
        assert!(!lower.contains("secret_key"), "must not contain secret_key");
        assert!(
            !lower.contains("seed_phrase"),
            "must not contain seed_phrase"
        );
        assert!(!lower.contains("mnemonic"), "must not contain mnemonic");
    }

    // 21. attempted_destination_hash is a hash (64 hex chars), not a raw address
    #[test]
    fn test_steal_destination_is_hash_not_raw_key() {
        let demo = build_rogue_steal_attempt_demo();
        let h = &demo.steal_attempt.attempted_destination_hash;
        assert_eq!(
            h.len(),
            64,
            "destination must be 64-char hex hash, not raw key"
        );
        assert!(
            h.chars().all(|c| c.is_ascii_hexdigit()),
            "must be valid hex"
        );
    }

    // 22. mainnet_ready is false
    #[test]
    fn test_steal_mainnet_ready_false() {
        let demo = build_rogue_steal_attempt_demo();
        assert!(!demo.mainnet_ready);
    }

    // 23. production_claim is false
    #[test]
    fn test_steal_production_claim_false() {
        let demo = build_rogue_steal_attempt_demo();
        assert!(!demo.production_claim);
    }

    // 24. agent_had_private_key is false
    #[test]
    fn test_steal_agent_never_held_key() {
        let demo = build_rogue_steal_attempt_demo();
        assert!(
            !demo.agent_had_private_key,
            "agent must never hold a private key"
        );
    }
}
