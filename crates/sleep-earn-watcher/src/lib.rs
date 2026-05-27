use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum WatcherJobKind {
    RentSweeper,
    ChaffMarket,
    RitualPuzzle,
    AlphaReveal,
    SessionCleanup,
    ShapeFill,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatcherConfig {
    pub max_sol_float_lamports: u64,
    pub allowed_kinds: Vec<WatcherJobKind>,
    pub min_reward_lamports: u64,
    pub max_tx_per_hour: u32,
    pub dry_run: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatcherJob {
    pub job_hash: [u8; 32],
    pub kind: WatcherJobKind,
    pub estimated_reward_lamports: u64,
    pub estimated_cost_lamports: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatcherPlan {
    pub jobs_to_execute: Vec<WatcherJob>,
    pub estimated_profit_lamports: u64,
    pub tx_count: u32,
    pub dry_run: bool,
}

pub fn scan_jobs(available: Vec<WatcherJob>, config: &WatcherConfig) -> Vec<WatcherJob> {
    available
        .into_iter()
        .filter(|job| {
            config.allowed_kinds.contains(&job.kind)
                && job.estimated_reward_lamports > config.min_reward_lamports
                && job.estimated_reward_lamports > job.estimated_cost_lamports
        })
        .collect()
}

pub fn estimate_profit(jobs: &[WatcherJob]) -> u64 {
    jobs.iter()
        .map(|j| {
            j.estimated_reward_lamports
                .saturating_sub(j.estimated_cost_lamports)
        })
        .sum()
}

pub fn build_execution_plan(jobs: Vec<WatcherJob>, config: &WatcherConfig) -> WatcherPlan {
    let limited = enforce_rate_limit(jobs, config.max_tx_per_hour);
    let profit = estimate_profit(&limited);
    let tx_count = limited.len() as u32;
    WatcherPlan {
        jobs_to_execute: limited,
        estimated_profit_lamports: profit,
        tx_count,
        dry_run: config.dry_run,
    }
}

pub fn enforce_rate_limit(jobs: Vec<WatcherJob>, max_tx_per_hour: u32) -> Vec<WatcherJob> {
    jobs.into_iter().take(max_tx_per_hour as usize).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_config() -> WatcherConfig {
        WatcherConfig {
            max_sol_float_lamports: 1_000_000_000,
            allowed_kinds: vec![WatcherJobKind::RentSweeper, WatcherJobKind::ChaffMarket],
            min_reward_lamports: 1_000,
            max_tx_per_hour: 10,
            dry_run: false,
        }
    }

    fn make_job(kind: WatcherJobKind, reward: u64, cost: u64) -> WatcherJob {
        WatcherJob {
            job_hash: [0xABu8; 32],
            kind,
            estimated_reward_lamports: reward,
            estimated_cost_lamports: cost,
        }
    }

    #[test]
    fn test_unprofitable_job_skipped() {
        let config = default_config();
        let jobs = vec![
            make_job(WatcherJobKind::RentSweeper, 500, 1000), // cost > reward
        ];
        let result = scan_jobs(jobs, &config);
        assert!(result.is_empty());
    }

    #[test]
    fn test_rate_limit_enforced() {
        let jobs: Vec<WatcherJob> = (0..20)
            .map(|i| make_job(WatcherJobKind::RentSweeper, 5_000, 100))
            .collect();
        let limited = enforce_rate_limit(jobs, 5);
        assert_eq!(limited.len(), 5);
    }

    #[test]
    fn test_kind_filter_works() {
        let config = default_config(); // only RentSweeper + ChaffMarket
        let jobs = vec![
            make_job(WatcherJobKind::RentSweeper, 5_000, 100),
            make_job(WatcherJobKind::RitualPuzzle, 5_000, 100), // not in allowed
        ];
        let result = scan_jobs(jobs, &config);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].kind, WatcherJobKind::RentSweeper);
    }

    #[test]
    fn test_dry_run_flag_propagated() {
        let mut config = default_config();
        config.dry_run = true;
        let plan = build_execution_plan(vec![], &config);
        assert!(plan.dry_run);
    }

    #[test]
    fn test_profit_estimate_correct() {
        let jobs = vec![
            make_job(WatcherJobKind::RentSweeper, 5_000, 500),
            make_job(WatcherJobKind::ChaffMarket, 3_000, 200),
        ];
        let profit = estimate_profit(&jobs);
        assert_eq!(profit, 4_500 + 2_800);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_scan_empty_jobs_returns_empty() {
        let config = default_config();
        let result = scan_jobs(vec![], &config);
        assert!(result.is_empty());
    }

    #[test]
    fn test_job_at_min_reward_skipped() {
        // reward == min_reward (1000) is NOT > min_reward → filtered out
        let config = default_config();
        let jobs = vec![make_job(WatcherJobKind::RentSweeper, 1_000, 100)];
        let result = scan_jobs(jobs, &config);
        assert!(result.is_empty(), "reward == min must be skipped");
    }

    #[test]
    fn test_profitable_job_passes_scan() {
        let config = default_config();
        let jobs = vec![make_job(WatcherJobKind::RentSweeper, 5_000, 100)];
        let result = scan_jobs(jobs, &config);
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn test_estimate_profit_empty_zero() {
        assert_eq!(estimate_profit(&[]), 0);
    }

    #[test]
    fn test_estimate_profit_single_job() {
        let jobs = vec![make_job(WatcherJobKind::RentSweeper, 3_000, 800)];
        assert_eq!(estimate_profit(&jobs), 2_200);
    }

    #[test]
    fn test_execution_plan_tx_count() {
        let config = default_config();
        let jobs = vec![
            make_job(WatcherJobKind::RentSweeper, 5_000, 100),
            make_job(WatcherJobKind::ChaffMarket, 4_000, 200),
        ];
        let plan = build_execution_plan(jobs, &config);
        assert_eq!(plan.tx_count, 2);
    }

    #[test]
    fn test_execution_plan_profit_matches_estimate() {
        let config = default_config();
        let jobs = vec![make_job(WatcherJobKind::RentSweeper, 6_000, 600)];
        let plan = build_execution_plan(jobs, &config);
        assert_eq!(plan.estimated_profit_lamports, 5_400);
    }

    #[test]
    fn test_rate_limit_fewer_than_max_not_truncated() {
        let jobs: Vec<WatcherJob> = (0..3)
            .map(|_i| make_job(WatcherJobKind::RentSweeper, 5_000, 100))
            .collect();
        let limited = enforce_rate_limit(jobs, 10);
        assert_eq!(limited.len(), 3, "fewer than max must not be truncated");
    }

    #[test]
    fn test_plan_dry_run_false_by_default() {
        let config = default_config(); // dry_run = false
        let plan = build_execution_plan(vec![], &config);
        assert!(!plan.dry_run);
    }

    #[test]
    fn test_allowed_kinds_all_pass() {
        let config = default_config(); // allows RentSweeper + ChaffMarket
        let jobs = vec![
            make_job(WatcherJobKind::RentSweeper, 5_000, 100),
            make_job(WatcherJobKind::ChaffMarket, 4_000, 200),
        ];
        let result = scan_jobs(jobs, &config);
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn test_scan_reward_must_exceed_cost() {
        // reward == cost → reward > cost is false → filtered
        let config = default_config();
        let jobs = vec![make_job(WatcherJobKind::RentSweeper, 5_000, 5_000)];
        let result = scan_jobs(jobs, &config);
        assert!(result.is_empty(), "reward == cost must be skipped");
    }
}
