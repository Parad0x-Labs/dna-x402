pub const LEGACY_TRANSFER_CU: u64 = 4_645;
pub const LEGACY_TRANSFER_CHECKED_CU: u64 = 6_200;
pub const LEGACY_CLOSE_CU: u64 = 4_240;
pub const P_TOKEN_TRANSFER_CU: u64 = 79;
pub const P_TOKEN_TRANSFER_CHECKED_CU: u64 = 111;
pub const P_TOKEN_CLOSE_CU: u64 = 120;
pub const MIGRATION_OVERHEAD_CU: u64 = 50_000;

#[derive(Debug, Clone)]
pub struct TokenVolumeInput {
    pub daily_transfers: u64,
    pub daily_transfer_checked: u64,
    pub daily_close_accounts: u64,
}

#[derive(Debug, Clone)]
pub struct ROIReport {
    pub legacy_cu_per_day: u64,
    pub p_token_cu_per_day: u64,
    pub cu_saved_per_day: u64,
    pub savings_pct: f32,
    pub break_even_days: u32,
    pub migration_recommended: bool,
    pub checklist: Vec<&'static str>,
}

pub fn compute_roi(input: &TokenVolumeInput) -> ROIReport {
    let legacy_cu_per_day = input.daily_transfers * LEGACY_TRANSFER_CU
        + input.daily_transfer_checked * LEGACY_TRANSFER_CHECKED_CU
        + input.daily_close_accounts * LEGACY_CLOSE_CU;

    let p_token_cu_per_day = input.daily_transfers * P_TOKEN_TRANSFER_CU
        + input.daily_transfer_checked * P_TOKEN_TRANSFER_CHECKED_CU
        + input.daily_close_accounts * P_TOKEN_CLOSE_CU;

    let cu_saved_per_day = legacy_cu_per_day.saturating_sub(p_token_cu_per_day);

    let savings_pct = if legacy_cu_per_day == 0 {
        0.0
    } else {
        cu_saved_per_day as f32 / legacy_cu_per_day as f32 * 100.0
    };

    let break_even_days = if cu_saved_per_day == 0 {
        u32::MAX
    } else {
        let days = MIGRATION_OVERHEAD_CU / cu_saved_per_day;
        days.min(u32::MAX as u64) as u32
    };

    let migration_recommended = savings_pct > 50.0;

    ROIReport {
        legacy_cu_per_day,
        p_token_cu_per_day,
        cu_saved_per_day,
        savings_pct,
        break_even_days,
        migration_recommended,
        checklist: migration_checklist(),
    }
}

pub fn migration_checklist() -> Vec<&'static str> {
    vec![
        "Verify token accounts use SPL Token program",
        "Check downstream integrations for program ID assumptions",
        "Test TransferChecked hook compatibility",
        "Run migration on devnet first",
        "Monitor CU usage for 24h post-migration",
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_high_volume_recommends_migration() {
        let input = TokenVolumeInput {
            daily_transfers: 100_000,
            daily_transfer_checked: 100_000,
            daily_close_accounts: 10_000,
        };
        let report = compute_roi(&input);
        assert!(report.migration_recommended, "high volume should recommend migration");
    }

    #[test]
    fn test_zero_volume_no_recommendation() {
        let input = TokenVolumeInput {
            daily_transfers: 0,
            daily_transfer_checked: 0,
            daily_close_accounts: 0,
        };
        let report = compute_roi(&input);
        assert!(!report.migration_recommended);
        assert_eq!(report.savings_pct, 0.0);
    }

    #[test]
    fn test_cu_saved_matches_formula() {
        let input = TokenVolumeInput {
            daily_transfers: 1_000,
            daily_transfer_checked: 0,
            daily_close_accounts: 0,
        };
        let report = compute_roi(&input);
        let expected_legacy = 1_000 * LEGACY_TRANSFER_CU;
        let expected_p = 1_000 * P_TOKEN_TRANSFER_CU;
        let expected_saved = expected_legacy - expected_p;
        assert_eq!(report.legacy_cu_per_day, expected_legacy);
        assert_eq!(report.p_token_cu_per_day, expected_p);
        assert_eq!(report.cu_saved_per_day, expected_saved);
    }

    #[test]
    fn test_savings_pct_above_98pct_for_transfer_checked() {
        let input = TokenVolumeInput {
            daily_transfers: 0,
            daily_transfer_checked: 1_000_000,
            daily_close_accounts: 0,
        };
        let report = compute_roi(&input);
        assert!(
            report.savings_pct > 98.0,
            "TransferChecked savings should be >98%, got {}",
            report.savings_pct
        );
    }

    #[test]
    fn test_checklist_has_5_items() {
        let list = migration_checklist();
        assert_eq!(list.len(), 5);
    }

    #[test]
    fn test_break_even_within_reasonable_range() {
        let input = TokenVolumeInput {
            daily_transfers: 10_000,
            daily_transfer_checked: 0,
            daily_close_accounts: 0,
        };
        let report = compute_roi(&input);
        assert!(
            report.break_even_days < 30,
            "break_even_days should be <30, got {}",
            report.break_even_days
        );
    }
}
