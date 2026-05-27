//! Evidence-backed capstone flow for the Dark Null frontier demo.
//!
//! The goal is to connect the strongest primitives into one deterministic local
//! run: x402 intent, paid alpha reveal, receipt chain, compressed state root,
//! service posture capsule, fee model, and Blink ritual layout.

use dark_alpha_receipts::{
    chain_receipt, create_paid_reveal, create_pnl_card, create_pnl_commitment, create_session_hash,
    create_trade_commitment, verify_chain_integrity, verify_pnl_card_clean,
    verify_reveal_integrity,
};
use dark_compressed_leaves::{
    compute_state_tree_root, create_commitment_leaf, create_nullifier_leaf,
    create_receipt_head_leaf, estimate_rent_savings,
};
use dark_fee_optimizer::{batch_receipt_savings, p_token_cu_savings_ratio};
use dark_swarm_capsule::{
    check_freshness, config_sha256_from_json, create_capsule, fee_policy_sha256_from_str,
    CustodyAttestation, LivenessConfig, SwarmCaps, SwarmRole,
};
use ritual_blink_gateway::{
    build_ceremony_layout, chain_blink_receipt, compute_hook_verdict, create_blink_receipt,
    create_x402_intent, validate_ceremony_layout, verify_blink_receipt, verify_hook_verdict,
    verify_payer_match,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn sha256_label(label: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(label);
    h.finalize().into()
}

fn sha256_parts(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for part in parts {
        h.update(part);
    }
    h.finalize().into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn bps_from_ratio(ratio: f32) -> u32 {
    (ratio * 10_000.0).round() as u32
}

/// Runs a single local evidence flow that ties the frontier primitives together.
pub fn run_edge_capstone() -> Value {
    let epoch = 88u32;
    let slot = 464_996_215u64;
    let now = 1_779_852_000u64;

    let session_salt = sha256_label(b"edge-capstone-session-salt");
    let execution_wallet = sha256_label(b"edge-capstone-execution-wallet");
    let token_mint = sha256_label(b"edge-capstone-token-mint");
    let payer_key = sha256_label(b"edge-capstone-x402-payer");
    let tx_signature = sha256_label(b"edge-capstone-tx-signature");
    let nonce = sha256_label(b"edge-capstone-x402-nonce");
    let mint_bytes = sha256_label(b"edge-capstone-ritual-mint");

    let session_hash = create_session_hash(&session_salt, &execution_wallet, epoch);
    let token_hash = sha256_parts(&[b"edge-capstone-token-hash", &token_mint]);
    let slot_hash = sha256_parts(&[b"edge-capstone-slot-hash", &slot.to_le_bytes()]);

    let trade = create_trade_commitment(&session_hash, &token_hash, 0x01, 0x02, &slot_hash, now);
    let pnl = create_pnl_commitment(&session_hash, epoch, 12_500, 4, now + 1);
    let pnl_card = create_pnl_card(&pnl);
    let pnl_card_clean = verify_pnl_card_clean(&pnl_card).is_ok();

    let resource_hash = trade.commitment_hash;
    let price_lamports = 1_000_000u64;
    let intent = create_x402_intent(&resource_hash, price_lamports, &payer_key, &nonce, now + 2);
    let paid_reveal = create_paid_reveal(&trade, &intent.payer_hash, now + 3)
        .expect("x402 payer hash should be a valid paid reveal subscriber");
    let paid_reveal_integrity = verify_reveal_integrity(&trade, &paid_reveal);

    let alpha_chain_1 = chain_receipt(None, &trade.commitment_hash);
    let alpha_chain_2 = chain_receipt(Some(&alpha_chain_1), &paid_reveal.reveal_hash);
    let alpha_chain_ok = verify_chain_integrity(&alpha_chain_2, Some(&alpha_chain_1));

    let ceremony = build_ceremony_layout(&intent).expect("x402 intent should build ceremony");
    let ceremony_ok = validate_ceremony_layout(&ceremony).is_ok();
    let verdict = compute_hook_verdict(&mint_bytes, price_lamports);
    let verdict_ok = verify_hook_verdict(&verdict, &mint_bytes, price_lamports).is_ok();
    let blink_receipt = create_blink_receipt(
        &intent,
        &verdict,
        &payer_key,
        &tx_signature,
        slot,
        None,
        now + 4,
    );
    let blink_receipt_ok = verify_blink_receipt(&blink_receipt).is_ok()
        && verify_payer_match(&blink_receipt, &payer_key).is_ok();
    let blink_chain = chain_blink_receipt(None, &blink_receipt, &session_hash);

    let commitment_leaf = create_commitment_leaf(&trade.commitment_hash, epoch, slot);
    let nullifier_leaf = create_nullifier_leaf(&paid_reveal.reveal_hash, epoch, slot + 1);
    let receipt_head_leaf = create_receipt_head_leaf(
        &blink_receipt.receipt_hash,
        Some(&alpha_chain_2.head_hash),
        epoch,
        slot + 2,
    );
    let root = compute_state_tree_root(&[
        commitment_leaf.leaf_hash,
        nullifier_leaf.leaf_hash,
        receipt_head_leaf.leaf_hash,
    ]);

    let caps = SwarmCaps {
        max_total_value_locked_lamports: 2_000_000_000,
        max_deposit_lamports: 50_000_000,
        daily_withdraw_limit_lamports: 250_000_000,
    };
    let capsule = create_capsule(
        SwarmRole::X402Adapter,
        "edge-capstone-local",
        sha256_label(b"edge-capstone-manifest"),
        config_sha256_from_json(r#"{"flow":"x402-alpha-receipt","mode":"devnet"}"#),
        "x402-alpha-edge-0",
        "solana-devnet",
        caps,
        fee_policy_sha256_from_str("flat:1000000-lamports;max:50000000-lamports"),
        LivenessConfig {
            health_path: "/health".to_string(),
            ready_path: "/ready".to_string(),
            metrics_path: "/metrics".to_string(),
        },
        CustodyAttestation {
            root_key_present: false,
            upgrade_key_present: false,
            user_spending_keys_present: false,
        },
        now + 5,
    )
    .expect("clean x402 adapter capsule should build");
    let capsule_fresh = check_freshness(&capsule, now + 60, 3_600).is_ok();

    let (compressed_10k, full_10k, saved_10k) = estimate_rent_savings(10_000);
    let state_savings_bps = ((saved_10k as f64 / full_10k as f64) * 10_000.0).round() as u32;
    let transfer_checked_savings_bps = bps_from_ratio(p_token_cu_savings_ratio());
    let batch_500 = batch_receipt_savings(500);

    let final_hash = sha256_parts(&[
        &session_hash,
        &trade.commitment_hash,
        &pnl.commitment_hash,
        &intent.intent_hash,
        &paid_reveal.reveal_hash,
        &alpha_chain_2.head_hash,
        &blink_receipt.receipt_hash,
        &blink_chain.chain_head_hash,
        &root.root,
        &capsule.capsule_hash,
        &saved_10k.to_le_bytes(),
    ]);

    json!({
        "flow": "paid-alpha-private-receipt-capstone",
        "network": "solana-devnet",
        "status": "local-evidence",
        "steps": [
            "hidden execution wallet -> session hash",
            "trade commitment -> x402 resource hash",
            "x402 payer hash -> paid reveal subscriber",
            "paid reveal -> alpha receipt chain",
            "x402 intent -> five-step Blink ritual layout",
            "Blink receipt -> receipt chain head",
            "commitment/nullifier/receipt leaves -> compressed state root",
            "x402 adapter -> clean service capsule",
            "fee model -> rent and CU savings"
        ],
        "assertions": {
            "pnl_card_clean": pnl_card_clean,
            "paid_reveal_integrity": paid_reveal_integrity,
            "paid_reveal_bound_to_x402_payer": paid_reveal.subscriber_hash == intent.payer_hash,
            "alpha_chain_ok": alpha_chain_ok,
            "ceremony_ok": ceremony_ok,
            "hook_verdict_ok": verdict_ok,
            "blink_receipt_ok": blink_receipt_ok,
            "compressed_root_nonzero": root.root != [0u8; 32],
            "capsule_fresh": capsule_fresh,
            "capsule_clean": !capsule.custody.root_key_present
                && !capsule.custody.upgrade_key_present
                && !capsule.custody.user_spending_keys_present
        },
        "hashes": {
            "session_hash": hex(&session_hash),
            "trade_commitment": hex(&trade.commitment_hash),
            "x402_intent": hex(&intent.intent_hash),
            "paid_reveal": hex(&paid_reveal.reveal_hash),
            "alpha_chain_head": hex(&alpha_chain_2.head_hash),
            "blink_receipt": hex(&blink_receipt.receipt_hash),
            "blink_chain_head": hex(&blink_chain.chain_head_hash),
            "compressed_state_root": hex(&root.root),
            "service_capsule": hex(&capsule.capsule_hash),
            "final_evidence_hash": hex(&final_hash)
        },
        "compressed_state": {
            "leaf_count": root.leaf_count,
            "commitment_leaf": hex(&commitment_leaf.leaf_hash),
            "nullifier_leaf": hex(&nullifier_leaf.leaf_hash),
            "receipt_head_leaf": hex(&receipt_head_leaf.leaf_hash)
        },
        "fee_model": {
            "compressed_10k_lamports": compressed_10k,
            "full_accounts_10k_lamports": full_10k,
            "saved_10k_lamports": saved_10k,
            "state_savings_bps": state_savings_bps,
            "transfer_checked_cu_savings_bps": transfer_checked_savings_bps,
            "batch_500_naive_writes": batch_500.on_chain_writes_naive,
            "batch_500_batched_writes": batch_500.on_chain_writes_batched
        },
        "raw_exposure": {
            "execution_wallet_exposed": false,
            "payer_key_exposed": false,
            "token_mint_exposed": false
        },
        "mainnet_ready": false,
        "production_claim": false
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capstone_all_core_assertions_pass() {
        let ev = run_edge_capstone();
        let assertions = &ev["assertions"];
        for key in [
            "pnl_card_clean",
            "paid_reveal_integrity",
            "paid_reveal_bound_to_x402_payer",
            "alpha_chain_ok",
            "ceremony_ok",
            "hook_verdict_ok",
            "blink_receipt_ok",
            "compressed_root_nonzero",
            "capsule_fresh",
            "capsule_clean",
        ] {
            assert_eq!(assertions[key], true, "assertion should pass: {key}");
        }
    }

    #[test]
    fn capstone_is_deterministic() {
        let a = run_edge_capstone();
        let b = run_edge_capstone();
        assert_eq!(
            a["hashes"]["final_evidence_hash"],
            b["hashes"]["final_evidence_hash"]
        );
    }

    #[test]
    fn capstone_compressed_state_has_three_leaves() {
        let ev = run_edge_capstone();
        assert_eq!(ev["compressed_state"]["leaf_count"], 3);
    }

    #[test]
    fn capstone_fee_model_has_real_savings() {
        let ev = run_edge_capstone();
        assert!(ev["fee_model"]["saved_10k_lamports"].as_u64().unwrap() > 0);
        assert!(ev["fee_model"]["state_savings_bps"].as_u64().unwrap() > 9_900);
        assert!(
            ev["fee_model"]["transfer_checked_cu_savings_bps"]
                .as_u64()
                .unwrap()
                > 9_700
        );
    }

    #[test]
    fn capstone_keeps_raw_inputs_out_of_evidence() {
        let ev = run_edge_capstone();
        let json = serde_json::to_string(&ev).unwrap();
        let execution_wallet = hex(&sha256_label(b"edge-capstone-execution-wallet"));
        let payer_key = hex(&sha256_label(b"edge-capstone-x402-payer"));
        let token_mint = hex(&sha256_label(b"edge-capstone-token-mint"));
        assert!(!json.contains(&execution_wallet));
        assert!(!json.contains(&payer_key));
        assert!(!json.contains(&token_mint));
    }

    #[test]
    fn capstone_status_flags_do_not_overstate() {
        let ev = run_edge_capstone();
        assert_eq!(ev["status"], "local-evidence");
        assert_eq!(ev["mainnet_ready"], false);
        assert_eq!(ev["production_claim"], false);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_mainnet_ready_false() {
        let ev = run_edge_capstone();
        assert_eq!(ev["mainnet_ready"], false, "mainnet_ready must be false");
    }

    #[test]
    fn test_production_claim_false() {
        let ev = run_edge_capstone();
        assert_eq!(
            ev["production_claim"], false,
            "production_claim must be false"
        );
    }

    #[test]
    fn test_network_is_solana_devnet() {
        let ev = run_edge_capstone();
        assert_eq!(ev["network"], "solana-devnet");
    }

    #[test]
    fn test_final_evidence_hash_nonempty() {
        let ev = run_edge_capstone();
        let hash = ev["hashes"]["final_evidence_hash"].as_str().unwrap();
        assert_eq!(hash.len(), 64, "final_evidence_hash must be 64 hex chars");
        assert_ne!(hash, "0".repeat(64).as_str());
    }

    #[test]
    fn test_compressed_root_hash_nonempty() {
        let ev = run_edge_capstone();
        let root = ev["hashes"]["compressed_state_root"].as_str().unwrap();
        assert_eq!(root.len(), 64);
        assert_ne!(root, "0".repeat(64).as_str());
    }

    #[test]
    fn test_raw_exposure_all_false() {
        let ev = run_edge_capstone();
        assert_eq!(ev["raw_exposure"]["execution_wallet_exposed"], false);
        assert_eq!(ev["raw_exposure"]["payer_key_exposed"], false);
        assert_eq!(ev["raw_exposure"]["token_mint_exposed"], false);
    }

    #[test]
    fn test_step_count_is_nine() {
        let ev = run_edge_capstone();
        assert_eq!(ev["steps"].as_array().unwrap().len(), 9);
    }

    #[test]
    fn test_batch_500_batched_less_than_naive() {
        let ev = run_edge_capstone();
        let naive = ev["fee_model"]["batch_500_naive_writes"].as_u64().unwrap();
        let batched = ev["fee_model"]["batch_500_batched_writes"]
            .as_u64()
            .unwrap();
        assert!(batched < naive, "batched writes must be fewer than naive");
    }

    #[test]
    fn test_service_capsule_hash_nonempty() {
        let ev = run_edge_capstone();
        let h = ev["hashes"]["service_capsule"].as_str().unwrap();
        assert_eq!(h.len(), 64);
        assert_ne!(h, "0".repeat(64).as_str());
    }

    #[test]
    fn test_blink_receipt_hash_nonempty() {
        let ev = run_edge_capstone();
        let h = ev["hashes"]["blink_receipt"].as_str().unwrap();
        assert_eq!(h.len(), 64);
        assert_ne!(h, "0".repeat(64).as_str());
    }
}
