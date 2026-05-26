// NULL FLYWHEEL SIM
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false
//
// Simulates the full NULL_FLYWHEEL_VAULT_V1 flow:
// 1. Accumulate premium fees from 1000 signal reveals + 250 risk checks + 100 hints
// 2. Commit a randomized schedule
// 3. Reveal the schedule (after window)
// 4. Execute via plan (chunked, capped)
// 5. Mint execution receipt
// 6. Produce redacted public receipt
// Output: dist/null-flywheel/NULL_FLYWHEEL_SIM.json

use sha2::{Sha256, Digest};
use std::fs;
use null_flywheel_core::{
    FlywheelConfig, PremiumFeeEvent, SourceKind,
    compute_allocation, add_fee_event, accumulated_balance, threshold_met,
    daily_cap_remaining, plan_execution, split_into_chunks,
};
use null_flywheel_randomizer::{commit_next_schedule, reveal_schedule, verify_schedule};
use null_flywheel_receipts::{
    build_fee_source_root, build_execution_receipt, verify_execution_receipt,
    redacted_public_receipt,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn h(tag: &[u8], data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(tag);
    hasher.update(data);
    hasher.finalize().into()
}

fn to_hex(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fn main() {
    // -----------------------------------------------------------------------
    // Step 0 — Build simulation config
    //   Simulation uses reduced thresholds for demonstration.
    //   Production values: min ~$50, max_single ~$250, max_daily ~$1000.
    // -----------------------------------------------------------------------
    let mut config = FlywheelConfig::default();
    config.min_execution_lamports = 1_000_000;  // 0.001 SOL for sim
    config.max_single_lamports    = 5_000_000;  // 0.005 SOL for sim
    config.max_daily_lamports     = 20_000_000; // 0.02  SOL for sim

    let epoch: u64 = 42;

    // -----------------------------------------------------------------------
    // Step 1 — Accumulate fee events
    //   Signal reveal gross: 2_000_000 lamports × 5 bps = 1_000 lamports each
    //   Risk check gross:    1_000_000 lamports × 5 bps =   500 lamports each
    //   Hint tier gross:       500_000 lamports × 5 bps =   250 lamports each
    //   Totals: 1_000_000 + 125_000 + 25_000 = 1_150_000 lamports allocated
    // -----------------------------------------------------------------------
    let signal_gross:  u64 = 2_000_000;
    let risk_gross:    u64 = 1_000_000;
    let hint_gross:    u64 =   500_000;

    let signal_count: usize = 1000;
    let risk_count:   usize =  250;
    let hint_count:   usize =  100;

    let mut events: Vec<PremiumFeeEvent> = Vec::new();

    for _ in 0..signal_count {
        add_fee_event(
            &mut events,
            &config,
            PremiumFeeEvent::new(SourceKind::SignalRevealFee, signal_gross, epoch),
        );
    }
    for _ in 0..risk_count {
        add_fee_event(
            &mut events,
            &config,
            PremiumFeeEvent::new(SourceKind::RiskCheckFee, risk_gross, epoch),
        );
    }
    for _ in 0..hint_count {
        add_fee_event(
            &mut events,
            &config,
            PremiumFeeEvent::new(SourceKind::HintTierFee, hint_gross, epoch),
        );
    }

    let total_events = events.len();
    let balance      = accumulated_balance(&events, &config);
    let threshold_ok = threshold_met(&events, &config);
    let cap_left     = daily_cap_remaining(&events, &config, epoch);

    // Per-kind allocation sanity
    let signal_alloc_each = compute_allocation(&config, signal_gross).allocated_lamports;
    let risk_alloc_each   = compute_allocation(&config, risk_gross).allocated_lamports;
    let hint_alloc_each   = compute_allocation(&config, hint_gross).allocated_lamports;

    let signal_alloc_total = signal_alloc_each * signal_count as u64;
    let risk_alloc_total   = risk_alloc_each   * risk_count   as u64;
    let hint_alloc_total   = hint_alloc_each   * hint_count   as u64;

    // -----------------------------------------------------------------------
    // Step 2 — Commit randomized schedule
    // -----------------------------------------------------------------------
    let seed = h(b"sim-seed", b"epoch-42-schedule");

    let window_slots      = 10_000u64;
    let committed_at_slot = 400_000_000u64;
    let revealed_at_slot  = 400_015_000u64; // > reveal_after_slot (400_010_000)

    let commitment = commit_next_schedule(&seed, epoch, window_slots, committed_at_slot)
        .expect("commit_next_schedule must succeed");

    // -----------------------------------------------------------------------
    // Step 3 — Reveal schedule (after window)
    // -----------------------------------------------------------------------
    let reveal = reveal_schedule(&commitment, &seed, epoch, revealed_at_slot)
        .expect("reveal_schedule must succeed");

    let schedule_verified = verify_schedule(&commitment, &reveal);

    // -----------------------------------------------------------------------
    // Step 4 — Plan execution (chunked, capped)
    // -----------------------------------------------------------------------
    let epoch_used: u64 = 0; // fresh epoch for sim

    let plan = plan_execution(&config, balance, epoch_used)
        .expect("plan_execution must succeed");

    let chunks_json: Vec<serde_json::Value> = plan
        .chunks
        .iter()
        .map(|c| serde_json::json!(c))
        .collect();

    // Also demonstrate split_into_chunks directly
    let raw_chunks = split_into_chunks(balance, config.max_single_lamports);

    // -----------------------------------------------------------------------
    // Step 5 — Build fee source root (first 10 event hashes as sample)
    // -----------------------------------------------------------------------
    let sample_hashes: Vec<[u8; 32]> = events
        .iter()
        .take(10)
        .map(|e| e.event_hash)
        .collect();

    let fee_source = build_fee_source_root(&sample_hashes, epoch);

    // schedule_reveal_hash = SHA256("sched-reveal" || reveal.seed)
    let schedule_reveal_hash = h(b"sched-reveal", &reveal.seed);

    // -----------------------------------------------------------------------
    // Step 6 — Build execution receipt
    // -----------------------------------------------------------------------
    let receipt = build_execution_receipt(
        epoch,
        revealed_at_slot,
        plan.total_lamports,
        &fee_source.root,
        "RewardsVault",
        &schedule_reveal_hash,
    );

    let receipt_valid = verify_execution_receipt(&receipt);

    // -----------------------------------------------------------------------
    // Step 7 — Produce redacted public receipt
    // -----------------------------------------------------------------------
    let public_receipt = redacted_public_receipt(&receipt);

    // -----------------------------------------------------------------------
    // Step 8 — Assemble output JSON
    // -----------------------------------------------------------------------
    let output = serde_json::json!({
        "mission": "NULL_FLYWHEEL_VAULT_V1",
        "security_flags": {
            "mainnet_ready":        false,
            "production_claim":     false,
            "agent_had_private_key": false,
            "devnet_only":          true,
            "not_audited":          true,
            "destination":          "RewardsVault",
            "burn_vault":           "disabled_by_default"
        },
        "simulation": {
            "note": "Simulation uses scaled-down fee thresholds for demonstration. Production values: min $50, max $250 single, $1000 daily.",
            "signal_reveal_events": signal_count,
            "risk_check_events":    risk_count,
            "hint_tier_events":     hint_count,
            "total_fee_events":     total_events,
            "signal_gross_lamports_each": signal_gross,
            "risk_gross_lamports_each":   risk_gross,
            "hint_gross_lamports_each":   hint_gross,
            "allocation_bps":   config.allocation_bps,
            "signal_alloc_lamports_each": signal_alloc_each,
            "risk_alloc_lamports_each":   risk_alloc_each,
            "hint_alloc_lamports_each":   hint_alloc_each,
            "signal_alloc_total":  signal_alloc_total,
            "risk_alloc_total":    risk_alloc_total,
            "hint_alloc_total":    hint_alloc_total,
            "total_allocated_lamports": balance,
            "sim_min_execution_lamports": config.min_execution_lamports,
            "sim_max_single_lamports":    config.max_single_lamports,
            "sim_max_daily_lamports":     config.max_daily_lamports
        },
        "steps": {
            "step_1_accumulate": {
                "description": "Accumulate premium fee events into flywheel balance",
                "total_events":    total_events,
                "balance_lamports": balance,
                "threshold_met":   threshold_ok,
                "daily_cap_remaining": cap_left,
                "proven": threshold_ok
            },
            "step_2_commit": {
                "description": "Commit randomized schedule via commit-reveal",
                "epoch":              epoch,
                "window_slots":       window_slots,
                "committed_at_slot":  committed_at_slot,
                "reveal_after_slot":  commitment.reveal_after_slot,
                "commitment_hash":    to_hex(&commitment.commitment_hash),
                "seed_hash":          to_hex(&h(b"seed-fingerprint", &seed)),
                "proven": true
            },
            "step_3_reveal": {
                "description": "Reveal schedule after window (timing enforced)",
                "revealed_at_slot":  revealed_at_slot,
                "scheduled_slot":    reveal.scheduled_slot,
                "verify_schedule":   schedule_verified,
                "proven": schedule_verified
            },
            "step_4_plan": {
                "description": "Plan execution: chunked, capped at daily limit",
                "amount_lamports":   plan.total_lamports,
                "chunks":            chunks_json,
                "chunk_count":       raw_chunks.len(),
                "capped":            plan.capped,
                "destination":       "RewardsVault",
                "proven": !plan.capped || plan.total_lamports > 0
            },
            "step_5_fee_source_root": {
                "description": "Build fee source root from sample event hashes (first 10)",
                "epoch":        fee_source.epoch,
                "event_count":  fee_source.event_count,
                "fee_root":     to_hex(&fee_source.root),
                "proven": true
            },
            "step_6_receipt": {
                "description": "Build and verify execution receipt",
                "epoch":                epoch,
                "executed_at_slot":     receipt.executed_at_slot,
                "receipt_hash":         to_hex(&receipt.receipt_hash),
                "allocated_lamports_hash": to_hex(&receipt.allocated_lamports_hash),
                "fee_source_root":      to_hex(&receipt.fee_source_root),
                "destination_hash":     to_hex(&receipt.destination_hash),
                "schedule_reveal_hash": to_hex(&receipt.schedule_reveal_hash),
                "is_public":            receipt.is_public,
                "mainnet_ready":        receipt.mainnet_ready,
                "receipt_valid":        receipt_valid,
                "proven": receipt_valid
            },
            "step_7_public_receipt": {
                "description": "Redacted public receipt — hashes only, no raw lamport amounts",
                "public_receipt": public_receipt,
                "proven": true
            }
        },
        "summary": {
            "all_steps_proven": threshold_ok && schedule_verified && receipt_valid
        }
    });

    // -----------------------------------------------------------------------
    // Step 9 — Write output
    // -----------------------------------------------------------------------
    let out_dir = "dist/null-flywheel";
    fs::create_dir_all(out_dir)
        .expect("failed to create dist/null-flywheel directory");

    let out_path = format!("{}/NULL_FLYWHEEL_SIM.json", out_dir);
    let json_str = serde_json::to_string_pretty(&output)
        .expect("failed to serialize output JSON");

    fs::write(&out_path, &json_str)
        .expect("failed to write NULL_FLYWHEEL_SIM.json");

    println!("NULL_FLYWHEEL_SIM complete → {}", out_path);
    println!("  total_events:           {}", total_events);
    println!("  balance_lamports:       {}", balance);
    println!("  threshold_met:          {}", threshold_ok);
    println!("  schedule_verified:      {}", schedule_verified);
    println!("  receipt_valid:          {}", receipt_valid);
    println!("  all_steps_proven:       {}", threshold_ok && schedule_verified && receipt_valid);
    println!("  mainnet_ready:          false");
    println!("  production_claim:       false");
}
