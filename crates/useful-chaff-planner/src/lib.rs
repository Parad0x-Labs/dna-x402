//! Useful Chaff Planner — every decoy transaction does janitor work.
//!
//! Metric: privacy_noise_efficiency = useful maintenance ops per chaff tx.
//! A chaff tx that achieves 0 maintenance is wasted rent.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MaintenanceOp {
    CloseExpiredScratch { expires_at_slot: u64 },
    RotateEpoch { old_epoch: u64, new_epoch: u64 },
    CompactReceiptRoot { old_count: u32 },
    UpdateMetricsRoot,
    ReclaimRent { account_key: [u8; 32] },
}

#[derive(Debug, Clone)]
pub struct ChaffPlan {
    pub maintenance_ops: Vec<MaintenanceOp>,
    /// Number of decoy account references added for chain-analysis obfuscation.
    pub decoy_account_count: usize,
}

impl ChaffPlan {
    /// Efficiency score: maintenance ops per chaff tx. Minimum 1 is required.
    pub fn efficiency(&self) -> f32 {
        if self.decoy_account_count == 0 {
            return self.maintenance_ops.len() as f32;
        }
        self.maintenance_ops.len() as f32 / self.decoy_account_count as f32
    }

    /// A chaff plan is considered useful if it has at least one maintenance op.
    pub fn is_useful(&self) -> bool {
        !self.maintenance_ops.is_empty()
    }
}

/// Build a chaff plan from a list of pending maintenance ops.
/// Selects up to `max_ops` ops and adds `decoy_count` decoy accounts.
pub fn plan(pending: Vec<MaintenanceOp>, max_ops: usize, decoy_count: usize) -> ChaffPlan {
    let maintenance_ops = pending.into_iter().take(max_ops).collect();
    ChaffPlan {
        maintenance_ops,
        decoy_account_count: decoy_count,
    }
}

/// A chaff plan with zero maintenance ops fails validation.
pub fn validate(plan: &ChaffPlan) -> Result<(), &'static str> {
    if plan.maintenance_ops.is_empty() {
        return Err("chaff plan has no maintenance ops — pure waste");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_ops(n: usize) -> Vec<MaintenanceOp> {
        (0..n as u64)
            .map(|i| MaintenanceOp::CloseExpiredScratch { expires_at_slot: i })
            .collect()
    }

    #[test]
    fn test_plan_picks_up_to_max() {
        let pending = make_ops(10);
        let p = plan(pending, 3, 0);
        assert_eq!(p.maintenance_ops.len(), 3);
    }

    #[test]
    fn test_useful_plan_validates() {
        let p = plan(make_ops(2), 5, 1);
        assert!(validate(&p).is_ok());
    }

    #[test]
    fn test_empty_plan_fails_validation() {
        let p = plan(vec![], 5, 2);
        assert!(validate(&p).is_err());
    }

    #[test]
    fn test_efficiency_with_decoys() {
        let p = plan(make_ops(2), 10, 4);
        let eff = p.efficiency();
        let expected = 2.0_f32 / 4.0_f32;
        assert!(
            (eff - expected).abs() < 1e-6,
            "expected {}, got {}",
            expected,
            eff
        );
    }

    #[test]
    fn test_efficiency_no_decoys() {
        let p = plan(make_ops(3), 10, 0);
        let eff = p.efficiency();
        assert!((eff - 3.0_f32).abs() < 1e-6, "expected 3.0, got {}", eff);
    }

    #[test]
    fn test_is_useful_false_when_empty() {
        let p = plan(vec![], 10, 5);
        assert!(!p.is_useful());
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_plan_with_fewer_than_max_ops() {
        let pending = make_ops(2);
        let p = plan(pending, 5, 0);
        assert_eq!(p.maintenance_ops.len(), 2);
    }

    #[test]
    fn test_non_empty_plan_is_useful() {
        let p = plan(make_ops(1), 5, 2);
        assert!(p.is_useful());
    }

    #[test]
    fn test_efficiency_one_op_one_decoy() {
        let p = plan(make_ops(1), 5, 1);
        assert!((p.efficiency() - 1.0_f32).abs() < 1e-6);
    }

    #[test]
    fn test_efficiency_zero_ops_zero_decoys() {
        let p = plan(vec![], 5, 0);
        assert!((p.efficiency() - 0.0_f32).abs() < 1e-6);
    }

    #[test]
    fn test_decoy_count_stored() {
        let p = plan(make_ops(3), 5, 7);
        assert_eq!(p.decoy_account_count, 7);
    }

    #[test]
    fn test_maintenance_ops_capped_at_max() {
        let pending = make_ops(100);
        let p = plan(pending, 10, 0);
        assert_eq!(p.maintenance_ops.len(), 10);
    }

    #[test]
    fn test_rotate_epoch_op_preserved() {
        let ops = vec![MaintenanceOp::RotateEpoch {
            old_epoch: 5,
            new_epoch: 6,
        }];
        let p = plan(ops, 5, 0);
        assert_eq!(p.maintenance_ops.len(), 1);
        matches!(
            p.maintenance_ops[0],
            MaintenanceOp::RotateEpoch {
                old_epoch: 5,
                new_epoch: 6
            }
        );
    }

    #[test]
    fn test_validate_error_contains_waste() {
        let p = plan(vec![], 5, 2);
        let err = validate(&p).unwrap_err();
        assert!(err.contains("waste"));
    }

    #[test]
    fn test_efficiency_high_decoy_low_ops() {
        // 1 op, 100 decoys → 1.0/100.0 = 0.01
        let p = plan(make_ops(1), 5, 100);
        let eff = p.efficiency();
        assert!((eff - 0.01_f32).abs() < 1e-6, "expected 0.01, got {}", eff);
    }

    #[test]
    fn test_all_ops_preserved_when_under_max() {
        let ops = vec![
            MaintenanceOp::UpdateMetricsRoot,
            MaintenanceOp::CompactReceiptRoot { old_count: 42 },
            MaintenanceOp::ReclaimRent {
                account_key: [0xAAu8; 32],
            },
        ];
        let p = plan(ops, 10, 1);
        assert_eq!(p.maintenance_ops.len(), 3);
    }
}
