use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use bounty_blink_jobs::{claim_job, complete_job, create_job, JobKind};
use cold_route_fee_sniper::{score_route, select_coldest_safe_route, RouteCandidate};
use copy_sniper_trap_board::create_board;
use degen_scoreboard::{
    compute_epoch_score, generate_badge, leaderboard_redacted, DegenScoreEvent, ScoreEventKind,
};
use fee_cashback_receipts::mint_cashback_receipt;
use no_deploy_token_launcher::{compile_launch_plan, TokenExtension};
use rent_goblin_swarm::{build_sweep_plan, scan_mock_targets, sort_by_highest_bounty};
use ritual_puzzle_market::{
    build_correct_solution, create_puzzle_job, submit_solution, PuzzleMethod,
};
use scratch_slot_leasing::{
    compute_rent_saved_vs_new_pda, lease_slot, release_slot, LeaseRequest, ScratchSlot, SlotState,
};
use shape_pool_pass::{compute_k_shape_boost, consume_pass, mint_pass};
use sleep_earn_watcher::{
    build_execution_plan, scan_jobs, WatcherConfig, WatcherJob, WatcherJobKind,
};
use useful_chaff_market::{create_chaff_job, execute_job_mock, ChaffJobKind};

#[derive(Debug, Serialize, Deserialize)]
pub struct DemoEvidence {
    pub network: String,
    pub mainnet_ready: bool,
    pub production_claim: bool,
    pub public_summary: String,
    pub ritual_message: String,
    pub money_saved_lamports: u64,
    pub money_earned_lamports: u64,
    pub jobs_completed: u32,
    pub primitives: DemoPrimitives,
    pub not_production_note: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DemoPrimitives {
    pub rent_goblin: RentGoblinSummary,
    pub bounty_blinks: BountyBlinkSummary,
    pub cold_route: ColdRouteSummary,
    pub token_launcher: TokenLauncherSummary,
    pub scratch_leasing: ScratchLeasingSummary,
    pub shape_pass: ShapePassSummary,
    pub chaff_market: ChaffMarketSummary,
    pub trap_board: TrapBoardSummary,
    pub puzzle_market: PuzzleMarketSummary,
    pub fee_cashback: FeeCashbackSummary,
    pub watcher: WatcherSummary,
    pub scoreboard: ScoreboardSummary,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RentGoblinSummary {
    pub targets: usize,
    pub reclaimable_lamports: u64,
    pub bounty_lamports: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BountyBlinkSummary {
    pub jobs_created: u32,
    pub jobs_completed: u32,
    pub reward_earned: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ColdRouteSummary {
    pub candidates_checked: usize,
    pub savings_lamports: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TokenLauncherSummary {
    pub deploy_sol_saved: f64,
    pub extensions: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ScratchLeasingSummary {
    pub slots_reused: u32,
    pub rent_saved: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ShapePassSummary {
    pub k_shape_boost: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChaffMarketSummary {
    pub jobs_done: u32,
    pub maintenance_value: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TrapBoardSummary {
    pub leaves: usize,
    pub sniper_detected: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PuzzleMarketSummary {
    pub message: String,
    pub solved: bool,
    pub reward: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FeeCashbackSummary {
    pub savings: u64,
    pub cashback: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WatcherSummary {
    pub jobs_planned: u32,
    pub estimated_profit: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ScoreboardSummary {
    pub events: u32,
    pub epoch_score: u64,
    pub badge_hash: String,
}

fn sha256_label(label: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(label);
    h.finalize().into()
}

fn hex8(bytes: &[u8; 32]) -> String {
    bytes.iter().take(8).map(|b| format!("{:02x}", b)).collect()
}

pub fn run_demo() -> DemoEvidence {
    let current_slot = 200_000u64;

    // 1. Rent goblin
    let mut targets = scan_mock_targets(current_slot);
    sort_by_highest_bounty(&mut targets);
    let plan = build_sweep_plan(targets, current_slot);
    let rent_goblin = RentGoblinSummary {
        targets: plan.targets.len(),
        reclaimable_lamports: plan.total_reclaimable_lamports,
        bounty_lamports: plan.total_bounty_lamports,
    };

    // 2. Bounty blinks
    let proof = sha256_label(b"demo_proof_hash");
    let mut job1 = create_job(
        JobKind::CloseExpiredAccount,
        5_000,
        500_000,
        proof,
        "Close expired PDA",
    )
    .unwrap();
    let mut job2 = create_job(
        JobKind::CompileRitualPuzzle,
        7_500,
        500_000,
        proof,
        "Compile ritual puzzle",
    )
    .unwrap();
    claim_job(&mut job1, current_slot).unwrap();
    claim_job(&mut job2, current_slot).unwrap();
    let reward1 = complete_job(&mut job1, proof).unwrap();
    let reward2 = complete_job(&mut job2, proof).unwrap();
    let bounty_blinks = BountyBlinkSummary {
        jobs_created: 2,
        jobs_completed: 2,
        reward_earned: reward1 + reward2,
    };

    // 3. Cold route
    let c1 = RouteCandidate {
        route_id: [0x01u8; 32],
        writable_account_hashes: vec![[0x01u8; 32]],
        expected_priority_fee: 8_000,
        shape_hash: sha256_label(b"shape_1"),
        k_shape: 2,
    };
    let c2 = RouteCandidate {
        route_id: [0x02u8; 32],
        writable_account_hashes: vec![[0x02u8; 32]],
        expected_priority_fee: 4_000,
        shape_hash: sha256_label(b"shape_2"),
        k_shape: 4,
    };
    let reference_fee = 10_000u64;
    let candidates = vec![c1.clone(), c2.clone()];
    let best = select_coldest_safe_route(candidates, &[], reference_fee, 1).unwrap();
    let best_score = score_route(&best, &[], reference_fee);
    let cold_route = ColdRouteSummary {
        candidates_checked: 2,
        savings_lamports: best_score.expected_savings_lamports,
    };

    // 4. Token launcher
    let ritual_hash = sha256_label(b"ritual_policy_demo");
    let hook_hash = sha256_label(b"hook_program_demo");
    let token_plan = compile_launch_plan(
        "ROGUE",
        "RGE",
        "https://darknull.xyz/rogue-metadata.json",
        vec![TokenExtension::TransferHook, TokenExtension::MemoTransfer],
        ritual_hash,
        hook_hash,
    )
    .unwrap();
    let token_launcher = TokenLauncherSummary {
        deploy_sol_saved: token_plan.estimated_deploy_sol_saved,
        extensions: vec!["TransferHook".to_string(), "MemoTransfer".to_string()],
    };

    // 5. Scratch slot leasing
    let mut scratch_slot = ScratchSlot {
        slot_id: sha256_label(b"scratch_slot_demo"),
        state: SlotState::Available,
        current_lease_hash: [0u8; 32],
        expires_at_slot: 0,
        state_hash: [0u8; 32],
        rent_deposit_lamports: 2_039_280,
    };
    let lease_req = LeaseRequest {
        user_hash: sha256_label(b"demo_user"),
        job_hash: sha256_label(b"demo_job"),
        requested_slots: 1,
        max_lamports: 5_000_000,
        expires_at_slot: current_slot + 10_000,
    };
    lease_slot(&mut scratch_slot, &lease_req, current_slot).unwrap();
    release_slot(&mut scratch_slot, current_slot).unwrap();
    let rent_saved = compute_rent_saved_vs_new_pda(2_039_280, 1);
    let scratch_leasing = ScratchLeasingSummary {
        slots_reused: 1,
        rent_saved,
    };

    // 6. Shape pool pass
    let shape_class = sha256_label(b"shape_alpha_pool");
    let owner = sha256_label(b"demo_owner");
    let mut pass = mint_pass(shape_class, owner, current_slot + 50_000, 10, true);
    consume_pass(&mut pass, &shape_class, current_slot).unwrap();
    let k_boost = compute_k_shape_boost(&pass, 4);
    let shape_pass = ShapePassSummary {
        k_shape_boost: k_boost,
    };

    // 7. Useful chaff market
    let chaff_shape = sha256_label(b"chaff_shape_class");
    let chaff_job = create_chaff_job(ChaffJobKind::CompactRoot, 3_500, 0.8, chaff_shape).unwrap();
    let maintenance_value = chaff_job.maintenance_value_lamports;
    let chaff_receipt = execute_job_mock(&chaff_job, chaff_shape).unwrap();
    assert!(chaff_receipt.maintenance_done);
    let chaff_market = ChaffMarketSummary {
        jobs_done: 1,
        maintenance_value,
    };

    // 8. Copy sniper trap board
    let market = sha256_label(b"demo_market");
    let board = create_board(market, b"real_leaf_seed", 3, 1, 500);
    let poison_hash = board
        .public_leaves
        .iter()
        .find(|l| l.kind == copy_sniper_trap_board::LeafKind::Poison)
        .unwrap()
        .leaf_hash;
    let sniper_report = copy_sniper_trap_board::detect_poison_redeemer(&board, poison_hash);
    let trap_board = TrapBoardSummary {
        leaves: board.public_leaves.len(),
        sniper_detected: sniper_report.flagged_as_poison,
    };

    // 9. Ritual puzzle market
    let mut puzzle = create_puzzle_job(
        "CASH",
        PuzzleMethod::ShardAscii,
        50_000,
        current_slot + 100_000,
    );
    let correct_solution = build_correct_solution(&puzzle);
    let puzzle_reward = submit_solution(&mut puzzle, correct_solution, current_slot).unwrap();
    let puzzle_market = PuzzleMarketSummary {
        message: "CASH".to_string(),
        solved: true,
        reward: puzzle_reward,
    };

    // 10. Fee cashback
    let fee_user = sha256_label(b"fee_user");
    let fee_route = sha256_label(b"fee_route");
    let cashback_receipt =
        mint_cashback_receipt(fee_user, 10_000, 6_000, fee_route, 500, 2_000, current_slot)
            .unwrap();
    let fee_cashback = FeeCashbackSummary {
        savings: cashback_receipt.savings_lamports,
        cashback: cashback_receipt.cashback_lamports,
    };

    // 11. Sleep-earn watcher
    let watcher_config = WatcherConfig {
        max_sol_float_lamports: 500_000_000,
        allowed_kinds: vec![
            WatcherJobKind::RentGoblin,
            WatcherJobKind::ChaffMarket,
            WatcherJobKind::RitualPuzzle,
        ],
        min_reward_lamports: 1_000,
        max_tx_per_hour: 5,
        dry_run: false,
    };
    let available_jobs = vec![
        WatcherJob {
            job_hash: sha256_label(b"wjob1"),
            kind: WatcherJobKind::RentGoblin,
            estimated_reward_lamports: 5_000,
            estimated_cost_lamports: 200,
        },
        WatcherJob {
            job_hash: sha256_label(b"wjob2"),
            kind: WatcherJobKind::ChaffMarket,
            estimated_reward_lamports: 3_000,
            estimated_cost_lamports: 150,
        },
        WatcherJob {
            job_hash: sha256_label(b"wjob3"),
            kind: WatcherJobKind::AlphaReveal, // not in allowed
            estimated_reward_lamports: 10_000,
            estimated_cost_lamports: 100,
        },
    ];
    let scanned = scan_jobs(available_jobs, &watcher_config);
    let watcher_plan = build_execution_plan(scanned, &watcher_config);
    let watcher = WatcherSummary {
        jobs_planned: watcher_plan.tx_count,
        estimated_profit: watcher_plan.estimated_profit_lamports,
    };

    // 12. Degen scoreboard
    let score_user = sha256_label(b"degen_user");
    let events = vec![
        DegenScoreEvent {
            user_hash: score_user,
            event_kind: ScoreEventKind::RentReclaimed,
            value_lamports: plan.total_reclaimable_lamports,
            proof_hash: [0u8; 32],
            slot: current_slot,
        },
        DegenScoreEvent {
            user_hash: score_user,
            event_kind: ScoreEventKind::ChaffJobCompleted,
            value_lamports: maintenance_value,
            proof_hash: [0u8; 32],
            slot: current_slot,
        },
        DegenScoreEvent {
            user_hash: score_user,
            event_kind: ScoreEventKind::PuzzleSolved,
            value_lamports: puzzle_reward,
            proof_hash: [0u8; 32],
            slot: current_slot,
        },
        DegenScoreEvent {
            user_hash: score_user,
            event_kind: ScoreEventKind::BadRouteAvoided,
            value_lamports: best_score.expected_savings_lamports,
            proof_hash: [0u8; 32],
            slot: current_slot,
        },
        DegenScoreEvent {
            user_hash: score_user,
            event_kind: ScoreEventKind::ReceiptVerified,
            value_lamports: cashback_receipt.savings_lamports,
            proof_hash: [0u8; 32],
            slot: current_slot,
        },
    ];
    let epoch_score = compute_epoch_score(&events);
    let badge = generate_badge(score_user, &events);
    let _lb = leaderboard_redacted(vec![(score_user, epoch_score)]);
    let scoreboard = ScoreboardSummary {
        events: events.len() as u32,
        epoch_score,
        badge_hash: format!("{}...", hex8(&badge.badge_hash)),
    };

    // Totals
    let money_saved_lamports = rent_goblin.reclaimable_lamports
        + cold_route.savings_lamports
        + scratch_leasing.rent_saved
        + fee_cashback.savings;
    let money_earned_lamports =
        bounty_blinks.reward_earned + puzzle_market.reward + watcher.estimated_profit;

    DemoEvidence {
        network: "solana-devnet".to_string(),
        mainnet_ready: false,
        production_claim: false,
        public_summary: "Paid useful noise: rent reclaimed, fees avoided, rituals solved"
            .to_string(),
        ritual_message: "CASH".to_string(),
        money_saved_lamports,
        money_earned_lamports,
        jobs_completed: 12,
        primitives: DemoPrimitives {
            rent_goblin,
            bounty_blinks,
            cold_route,
            token_launcher,
            scratch_leasing,
            shape_pass,
            chaff_market,
            trap_board,
            puzzle_market,
            fee_cashback,
            watcher,
            scoreboard,
        },
        not_production_note: "NOT_PRODUCTION. Devnet only. No audit. No mainnet keys.".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_demo_mainnet_ready_false() {
        let ev = run_demo();
        assert!(!ev.mainnet_ready);
    }

    #[test]
    fn test_demo_production_claim_false() {
        let ev = run_demo();
        assert!(!ev.production_claim);
    }

    #[test]
    fn test_demo_jobs_completed_12() {
        let ev = run_demo();
        assert_eq!(ev.jobs_completed, 12);
    }

    #[test]
    fn test_no_raw_key_in_json() {
        let ev = run_demo();
        let json = serde_json::to_string(&ev).unwrap();
        // should not contain anything that looks like a raw private key pattern
        assert!(!json.contains("private"));
        assert!(!json.contains("secret_key"));
        assert!(!json.contains("sk_"));
    }

    #[test]
    fn test_ritual_message_is_cash() {
        let ev = run_demo();
        assert_eq!(ev.ritual_message, "CASH");
    }
}
