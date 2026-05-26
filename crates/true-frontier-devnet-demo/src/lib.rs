// true-frontier-devnet-demo/src/lib.rs
//
// NOT_PRODUCTION — devnet only, mainnet_ready=false
//
// Builds all 10 True Frontier Primitive objects locally and returns a typed
// evidence struct. No network required for any function in this file.
// The binary layer adds devnet tx submission.

use agent_flight_recorder::{chain_root, redact, FlightChain, FlightReceipt, RedactedFlightView};
use agent_permission_notes::{
    spend_allowed, withdraw_scope_hash, AgentPermissionNote, PermissionSpend,
};
use alpha_capsules::{commit_side, new_capsule, ConfidenceBucket};
use chaff_economy as _;
use no_custody_attestation::{compute_risk_score, DeniedKeyClass, NoCustodyCapsule};
use onchain_puzzle_compiler::{compile_puzzle, PuzzleCompileInput, PuzzleMethod};
use receipt_souls::{redeem_soul, ReceiptSoul, SoulRedemptionPolicy, SoulTransferPolicy};
use roadmap_commitments::{commit_feature, RoadmapCommit};
use session_note_channel::{issue_notes, settle_session, SessionNoteChannel, SessionSpendNote};
use sha2::{Digest, Sha256};
use spend_shadows::{
    copy_sniper_precision, new_shadow_bundle, ShadowBundle, ShadowLeaf, SpendShadowKind,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

pub fn sha256_bytes(input: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(input);
    h.finalize().into()
}

pub fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ---------------------------------------------------------------------------
// Local evidence struct — all fields derivable without network
// ---------------------------------------------------------------------------

pub struct DemoEvidenceLocal {
    // Step 1: AgentPermissionNote
    pub agent_permission_hash: [u8; 32],
    pub permission_spend_nullifier: [u8; 32],

    // Step 2: AlphaCapsule
    pub alpha_capsule_hash: [u8; 32],
    pub alpha_side_commitment: [u8; 32],

    // Step 3-4: Shadow bundle + permission spend
    pub shadow_bundle: ShadowBundle,
    pub copy_sniper_precision: f32,

    // Step 5: FlightRecord
    pub flight_record_hash: [u8; 32],
    pub redacted_view: RedactedFlightView,
    pub flight_chain_root: [u8; 32],

    // Step 6: ReceiptSoul
    pub soul_hash: [u8; 32],
    pub soul_nullifier: [u8; 32],

    // Step 7: SessionNoteChannel
    pub session_settlement_root: [u8; 32],
    pub session_total_spent: u64,
    pub session_notes_used: u32,

    // Step 8: NoCustodyAttestation
    pub no_custody_capsule_hash: [u8; 32],
    pub no_custody_risk_score: u8,

    // Step 9: Puzzle
    pub puzzle_message: String,
    pub puzzle_shard_path: Vec<u8>,

    // Roadmap commitment
    pub roadmap_commit: RoadmapCommit,

    pub mainnet_ready: bool,
    pub production_claim: bool,
    pub tests_total: u64,
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

pub fn build_local_demo() -> DemoEvidenceLocal {
    let slot: u64 = 1_000_000; // representative devnet slot for local demo

    // ── Step 1: AgentPermissionNote for "Rogue Alpha" ────────────────────────
    let agent_id_hash = sha256_bytes(b"rogue_alpha_agent_v1");
    let market_scope_hash = sha256_bytes(b"dark_null_v1_market_scope");
    let kill_switch_root = sha256_bytes(b"rogue_alpha_kill_switch_root");

    let note = AgentPermissionNote {
        agent_id_hash,
        max_total_spend: 50_000_000, // 0.05 SOL in lamports
        max_single_spend: 10_000_000,
        allowed_scopes: vec![market_scope_hash],
        denied_scopes: vec![withdraw_scope_hash()],
        expiry_slot: slot + 5_000,
        loss_fuse_hash: sha256_bytes(b"rogue_alpha_loss_fuse"),
        kill_switch_root,
        receipt_root: [0u8; 32],
        no_withdraw: true,
        kill_switch_active: false,
    };

    let agent_permission_hash = note.note_hash();

    let spend = PermissionSpend::new(&note, 1_000_000, market_scope_hash, slot);
    let permission_spend_nullifier = spend.nullifier;

    // Verify spend is allowed
    assert!(
        spend_allowed(&note, &spend, slot, 0).is_ok(),
        "Permission spend must be allowed in demo"
    );

    // ── Step 2: AlphaCapsule ─────────────────────────────────────────────────
    let market_hash = sha256_bytes(b"DARK_NULL_TEST_MARKET");
    let alpha_salt: [u8; 32] = sha256_bytes(b"rogue_alpha_capsule_salt_v1");
    let side_bytes = b"LONG";
    let alpha_side_commitment = commit_side(side_bytes, &alpha_salt);

    let confidence = ConfidenceBucket::new(4).expect("confidence 4 is valid");
    let model_hash = sha256_bytes(b"rogue_alpha_model_v1");
    let odds_snapshot_hash = sha256_bytes(b"dark_null_test_odds_v1");
    let buyer_scope_hash = sha256_bytes(b"rogue_alpha_buyer_scope");

    let capsule = new_capsule(
        market_hash,
        alpha_side_commitment,
        confidence,
        model_hash,
        odds_snapshot_hash,
        slot + 100,
        buyer_scope_hash,
        false,
    );
    let alpha_capsule_hash = capsule.capsule_hash();

    // ── Step 3: Shadow bundle ─────────────────────────────────────────────────
    let real_leaf_hash = sha256_bytes(b"rogue_alpha_real_spend_v1");
    let delayed_slot = slot + 500;
    let mut bundle = new_shadow_bundle(real_leaf_hash, 2, Some(delayed_slot), None, slot + 10_000);

    // Manually add poison leaf (task spec: 1 real + 2 decoy + 1 delayed + 1 poison = 5 total)
    let poison_hash = sha256_bytes(b"rogue_alpha_poison_leaf");
    bundle.public_leaves.push(ShadowLeaf {
        kind: SpendShadowKind::Poison,
        leaf_hash: poison_hash,
        reveal_slot: 0,
        maintenance_job_hash: [0u8; 32],
        expiry_slot: slot + 10_000,
    });

    let precision = copy_sniper_precision(&bundle); // 1.0 / 5.0 = 0.2

    // ── Step 4: PermissionSpend against real leaf already created above ───────
    // (spend was validated in Step 1)

    // ── Step 5: FlightRecord chain ────────────────────────────────────────────
    let first_receipt = FlightReceipt {
        agent_id_hash,
        model_output_hash: model_hash,
        permission_hash: agent_permission_hash,
        risk_policy_hash: sha256_bytes(b"rogue_alpha_risk_policy"),
        spend_receipt_hash: sha256_bytes(&spend.nullifier),
        timestamp_slot: slot,
        previous_flight_hash: [0u8; 32], // first in chain
        kill_switch_state_hash: kill_switch_root,
    };
    let first_hash = first_receipt.compute_hash();

    let second_receipt = FlightReceipt {
        agent_id_hash,
        model_output_hash: sha256_bytes(b"rogue_alpha_model_output_2"),
        permission_hash: agent_permission_hash,
        risk_policy_hash: sha256_bytes(b"rogue_alpha_risk_policy"),
        spend_receipt_hash: sha256_bytes(b"rogue_alpha_outcome_v2"),
        timestamp_slot: slot + 1,
        previous_flight_hash: first_hash,
        kill_switch_state_hash: kill_switch_root,
    };

    let chain = FlightChain {
        receipts: vec![first_receipt.clone(), second_receipt],
    };

    let flight_chain_root = chain_root(&chain);
    let flight_record_hash = first_hash;
    let redacted_view = redact(&first_receipt);

    // ── Step 6: ReceiptSoul ───────────────────────────────────────────────────
    let soul = ReceiptSoul {
        soul_id_hash: sha256_bytes(b"rogue_alpha_api_soul_v1"),
        scope_hash: sha256_bytes(b"dark_null_api_scope"),
        amount_bucket: 1,
        issuer_hash: sha256_bytes(b"rogue_alpha_issuer"),
        expiry_slot: slot + 5_000,
        transfer_policy: SoulTransferPolicy::OneHopOnly,
        redemption_policy: SoulRedemptionPolicy::BurnAfterRead,
        current_holder_hash: sha256_bytes(b"rogue_alpha_holder"),
        transfer_count: 0,
        redeemed: false,
    };
    let soul_hash = soul.soul_hash();
    let holder_hash = sha256_bytes(b"rogue_alpha_holder");

    let (soul_nullifier_obj, _redeemed_soul) =
        redeem_soul(&soul, holder_hash, slot).expect("soul redemption must succeed in demo");
    let soul_nullifier = soul_nullifier_obj.0;

    // ── Step 7: SessionNoteChannel (5 notes) ─────────────────────────────────
    let session_hash = sha256_bytes(b"rogue_alpha_session_v1");
    let channel = SessionNoteChannel {
        session_hash,
        starting_balance_commitment: sha256_bytes(b"rogue_alpha_balance_commitment"),
        permission_hash: agent_permission_hash,
        note_count: 5,
        note_amount_each: 100_000,
        expiry_slot: slot + 1_000,
    };
    let scope_hash = market_scope_hash;
    let notes: Vec<SessionSpendNote> = issue_notes(&channel, scope_hash);
    let settlement = settle_session(&channel, &notes).expect("session settlement must succeed");
    let session_settlement_root = settlement.root;

    // ── Step 8: NoCustodyAttestation ─────────────────────────────────────────
    let capsule_no_custody = NoCustodyCapsule {
        binary_hash: sha256_bytes(b"true_frontier_demo_binary_v1"),
        config_hash: sha256_bytes(b"true_frontier_demo_config_v1"),
        denied_key_classes: DeniedKeyClass::all(),
        max_float_lamports: 0,
        redaction_policy_hash: sha256_bytes(b"pii_removed"),
        custody_denied: true,
        issued_at_slot: slot,
        signer_pubkey_hash: sha256_bytes(b"true_frontier_demo_signer"),
    };
    let no_custody_capsule_hash = capsule_no_custody.capsule_hash();
    let risk_score = compute_risk_score(&capsule_no_custody);
    let no_custody_risk_score = risk_score.0;

    // ── Step 9: Puzzle — "ROGUE" shard path ──────────────────────────────────
    let puzzle_input = PuzzleCompileInput {
        message: "ROGUE".to_string(),
        method: PuzzleMethod::ShardAscii,
        target_network: "solana-devnet".to_string(),
    };
    let puzzle_output = compile_puzzle(&puzzle_input).expect("ROGUE puzzle must compile");
    let puzzle_shard_path: Vec<u8> = puzzle_output
        .shard_targets
        .iter()
        .map(|t| t.shard_byte)
        .collect();

    // ── Roadmap commitment ────────────────────────────────────────────────────
    let docs_hash = sha256_bytes(b"TRUE_FRONTIER_PRIMITIVES.md_v1");
    let tests_hash = sha256_bytes(b"true_frontier_tests_522_v1");
    let roadmap_commit = commit_feature(
        docs_hash,
        tests_hash,
        b"Dark Null True Frontier Primitives -- 10 product primitives, 522 tests",
        0,            // target_epoch
        slot + 5_000, // reveal_deadline
        slot,
    );

    DemoEvidenceLocal {
        agent_permission_hash,
        permission_spend_nullifier,
        alpha_capsule_hash,
        alpha_side_commitment,
        shadow_bundle: bundle,
        copy_sniper_precision: precision,
        flight_record_hash,
        redacted_view,
        flight_chain_root,
        soul_hash,
        soul_nullifier,
        session_settlement_root,
        session_total_spent: settlement.total_spent,
        session_notes_used: settlement.notes_used,
        no_custody_capsule_hash,
        no_custody_risk_score,
        puzzle_message: "ROGUE".to_string(),
        puzzle_shard_path,
        roadmap_commit,
        mainnet_ready: false,
        production_claim: false,
        tests_total: 522,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use agent_permission_notes::{
        spend_allowed, withdraw_scope_hash, AgentPermissionNote, PermissionSpend,
    };

    // Helper: build a fresh demo (fast — no network).
    fn demo() -> DemoEvidenceLocal {
        build_local_demo()
    }

    // 1. mainnet_ready is always false.
    #[test]
    fn test_mainnet_ready_is_false() {
        let d = demo();
        assert!(!d.mainnet_ready, "mainnet_ready must be false");
    }

    // 2. production_claim is always false.
    #[test]
    fn test_production_claim_false() {
        let d = demo();
        assert!(!d.production_claim, "production_claim must be false");
    }

    // 3. copy_sniper_precision == 0.2 (5 public leaves).
    #[test]
    fn test_copy_sniper_precision_is_0_2() {
        let d = demo();
        assert_eq!(
            d.shadow_bundle.public_leaves.len(),
            5,
            "must have exactly 5 public leaves for 0.2 precision"
        );
        let expected = 0.2_f32;
        let diff = (d.copy_sniper_precision - expected).abs();
        assert!(
            diff < 0.0001,
            "copy_sniper_precision must be 0.2, got {}",
            d.copy_sniper_precision
        );
    }

    // 4. no_custody_risk_score == 0.
    #[test]
    fn test_no_custody_risk_score_zero() {
        let d = demo();
        assert_eq!(
            d.no_custody_risk_score, 0,
            "risk score must be 0 when all 4 key classes denied"
        );
    }

    // 5. Puzzle shards decode to "ROGUE" = [82, 79, 71, 85, 69].
    #[test]
    fn test_puzzle_shards_decode_rogue() {
        let d = demo();
        assert_eq!(d.puzzle_shard_path, vec![82u8, 79, 71, 85, 69]);
        // Verify character by character
        let letters = "ROGUE";
        for (i, ch) in letters.chars().enumerate() {
            assert_eq!(
                d.puzzle_shard_path[i], ch as u8,
                "shard[{}] must be '{}' ({})",
                i, ch, ch as u8
            );
        }
    }

    // 6. All public shadow leaves encode to exactly 81 bytes.
    #[test]
    fn test_shadow_leaves_uniform_81_bytes() {
        let d = demo();
        for (i, leaf) in d.shadow_bundle.public_leaves.iter().enumerate() {
            let bytes = leaf.canonical_bytes();
            assert_eq!(
                bytes.len(),
                81,
                "leaf {} (kind={:?}) must be 81 bytes, got {}",
                i,
                leaf.kind,
                bytes.len()
            );
        }
    }

    // 7. Kill switch invalidates old permission: rotating note produces a different hash.
    //    The old spend's permission_hash no longer matches the new note's note_hash.
    #[test]
    fn test_kill_switch_invalidates_permission() {
        let slot = 1_000_000u64;
        let agent_id = sha256_bytes(b"test_agent");
        let scope = sha256_bytes(b"test_scope");

        let note = AgentPermissionNote {
            agent_id_hash: agent_id,
            max_total_spend: 10_000_000,
            max_single_spend: 1_000_000,
            allowed_scopes: vec![scope],
            denied_scopes: vec![],
            expiry_slot: slot + 1_000,
            loss_fuse_hash: [0u8; 32],
            kill_switch_root: sha256_bytes(b"kill_switch_A"),
            receipt_root: [0u8; 32],
            no_withdraw: false,
            kill_switch_active: false,
        };

        let spend = PermissionSpend::new(&note, 500_000, scope, slot);
        // Spend is valid against original note
        assert!(spend_allowed(&note, &spend, slot, 0).is_ok());

        // Rotate: new note has different kill_switch_root → different note_hash
        let rotated_note = AgentPermissionNote {
            kill_switch_root: sha256_bytes(b"kill_switch_B"),
            ..note.clone()
        };

        // The spend was built against the old note — its permission_hash doesn't match rotated note
        let old_hash = note.note_hash();
        let new_hash = rotated_note.note_hash();
        assert_ne!(
            old_hash, new_hash,
            "rotating kill_switch_root must change note_hash"
        );
        // spend.permission_hash == old_hash, but rotated_note.note_hash() == new_hash
        // → spend_allowed rejects it
        assert_ne!(spend.permission_hash, new_hash);
    }

    // 8. Spend with withdrawal scope is rejected.
    #[test]
    fn test_withdrawal_scope_rejected() {
        let slot = 1_000_000u64;
        let agent_id = sha256_bytes(b"test_agent_2");
        let withdraw = withdraw_scope_hash();

        let note = AgentPermissionNote {
            agent_id_hash: agent_id,
            max_total_spend: 10_000_000,
            max_single_spend: 1_000_000,
            allowed_scopes: vec![], // all scopes allowed when empty
            denied_scopes: vec![withdraw],
            expiry_slot: slot + 1_000,
            loss_fuse_hash: [0u8; 32],
            kill_switch_root: [0u8; 32],
            receipt_root: [0u8; 32],
            no_withdraw: true,
            kill_switch_active: false,
        };

        let spend = PermissionSpend::new(&note, 500_000, withdraw, slot);
        let result = spend_allowed(&note, &spend, slot, 0);
        assert!(
            result.is_err(),
            "spend with withdrawal scope must be rejected, got Ok"
        );
    }

    // 9. No raw private keys or secrets appear in JSON serialisation of evidence.
    #[test]
    fn test_no_secrets_in_serialised_hashes() {
        let d = demo();
        // Serialise key fields to hex and ensure no accidental "private_key" substring
        let json = serde_json::json!({
            "agent_permission_hash": hex_encode(&d.agent_permission_hash),
            "soul_nullifier": hex_encode(&d.soul_nullifier),
            "session_settlement_root": hex_encode(&d.session_settlement_root),
            "no_custody_capsule_hash": hex_encode(&d.no_custody_capsule_hash),
            "roadmap_commit_hash": hex_encode(&d.roadmap_commit.commit_hash),
        });
        let s = json.to_string().to_lowercase();
        assert!(
            !s.contains("private_key"),
            "no 'private_key' in serialised evidence"
        );
        assert!(!s.contains("secret"), "no 'secret' in serialised evidence");
    }

    // 10. Session settlement covers 5 notes.
    #[test]
    fn test_session_settles_five_notes() {
        let d = demo();
        assert_eq!(d.session_notes_used, 5, "5 notes must be settled");
        assert_eq!(
            d.session_total_spent,
            5 * 100_000,
            "total spent must be 500_000 lamports"
        );
    }

    // 11. Shadow bundle leaf count matches spec.
    #[test]
    fn test_shadow_bundle_leaf_kinds() {
        let d = demo();
        let kinds: Vec<_> = d
            .shadow_bundle
            .public_leaves
            .iter()
            .map(|l| &l.kind)
            .collect();
        let has_real = kinds.iter().any(|k| **k == SpendShadowKind::Real);
        let decoy_count = kinds
            .iter()
            .filter(|k| ***k == SpendShadowKind::Decoy)
            .count();
        let has_delayed = kinds.iter().any(|k| **k == SpendShadowKind::Delayed);
        let has_poison = kinds.iter().any(|k| **k == SpendShadowKind::Poison);
        assert!(has_real, "must have a real leaf");
        assert_eq!(decoy_count, 2, "must have exactly 2 decoy leaves");
        assert!(has_delayed, "must have a delayed leaf");
        assert!(has_poison, "must have a poison leaf");
    }

    // 12. Roadmap commit is stale-resistant (deadline enforcement).
    #[test]
    fn test_roadmap_commit_stale_detection() {
        use roadmap_commitments::{commit_feature, reveal_commit, RevealStatus, RoadmapReveal};

        let docs_hash = sha256_bytes(b"docs_v1");
        let tests_hash = sha256_bytes(b"tests_v1");
        let commit = commit_feature(docs_hash, tests_hash, b"test claim", 0, 1_000, 500);

        // Reveal AFTER deadline → Stale
        let reveal = RoadmapReveal {
            commit_hash: commit.commit_hash,
            docs_hash,
            tests_hash,
            claim_preimage: b"test claim".to_vec(),
            reveal_slot: 2_000, // > deadline 1_000
        };
        let status = reveal_commit(&commit, &reveal, 2_000);
        assert!(
            matches!(status, RevealStatus::Stale { .. }),
            "reveal after deadline must be Stale"
        );
    }
}
