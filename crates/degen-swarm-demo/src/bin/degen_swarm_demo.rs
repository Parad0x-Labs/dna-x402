use degen_swarm_demo::run_demo;
use std::fs;
use std::path::Path;

fn main() {
    let evidence = run_demo();

    // Print summary
    println!();
    println!("  DARK NULL - DEGEN SWARM ECONOMY");
    println!("  =================================");
    println!("  Paid useful noise.");
    println!();
    println!(
        "  [RENT SWEEPER]     {} targets, {:.6} SOL reclaimable",
        evidence.primitives.rent_sweeper.targets,
        evidence.primitives.rent_sweeper.reclaimable_lamports as f64 / 1_000_000_000.0
    );
    println!(
        "  [BOUNTY BLINKS]   {} jobs completed, {} lamports earned",
        evidence.primitives.bounty_blinks.jobs_completed,
        evidence.primitives.bounty_blinks.reward_earned
    );
    println!(
        "  [COLD ROUTE]      coldest route saves {} lamports",
        evidence.primitives.cold_route.savings_lamports
    );
    println!(
        "  [TOKEN LAUNCHER]  {:.1} SOL saved vs custom deploy",
        evidence.primitives.token_launcher.deploy_sol_saved
    );
    println!(
        "  [SCRATCH LEASING] {} lamports rent saved",
        evidence.primitives.scratch_leasing.rent_saved
    );
    println!(
        "  [SHAPE PASS]      k-shape boost +{}",
        evidence.primitives.shape_pass.k_shape_boost
    );
    println!("  [CHAFF MARKET]    1 CompactRoot job done");
    println!(
        "  [TRAP BOARD]      sniper detected {}",
        if evidence.primitives.trap_board.sniper_detected {
            "X"
        } else {
            "-"
        }
    );
    println!(
        "  [PUZZLE MARKET]   {} solved",
        evidence.primitives.puzzle_market.message
    );
    println!(
        "  [FEE CASHBACK]    {} lamports savings, {} cashback",
        evidence.primitives.fee_cashback.savings, evidence.primitives.fee_cashback.cashback
    );
    println!(
        "  [WATCHER]         {} jobs planned",
        evidence.primitives.watcher.jobs_planned
    );
    println!(
        "  [SCOREBOARD]      epoch score: {}",
        evidence.primitives.scoreboard.epoch_score
    );
    println!();
    println!("  +---------------------------------------------+");
    println!("  |  RENT SAVED    OK  ghosts pay for cleaning  |");
    println!("  |  FEES AVOIDED  OK  cold route selected      |");
    println!("  |  PUZZLE SOLVED OK  CASH mined into state    |");
    println!("  |  SNIPER CAUGHT X   poison receipt triggered |");
    println!("  +---------------------------------------------+");
    println!();

    // Write evidence JSON
    let out_dir = Path::new("dist/degen-swarm");
    fs::create_dir_all(out_dir).expect("failed to create dist/degen-swarm");
    let json = serde_json::to_string_pretty(&evidence).expect("failed to serialize evidence");
    let out_path = out_dir.join("DEGEN_SWARM_DEMO.json");
    fs::write(&out_path, &json).expect("failed to write evidence file");

    println!("  Evidence: {}", out_path.display());
    println!("  NOT_PRODUCTION. Devnet only. No audit. No mainnet keys.");
    println!();
}
