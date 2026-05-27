/// Naive follower copies every visible receipt event
#[derive(Debug, Default)]
pub struct NaiveFollower {
    pub copied_count: u32,
    pub false_positive_count: u32,
    pub true_positive_count: u32,
}

impl NaiveFollower {
    /// Simulate copying: if follower can't distinguish real from poison, rate of false copies
    /// is = poison_ratio in the stream
    pub fn simulate(&mut self, total_events: u32, real_count: u32) {
        let poison_count = total_events - real_count;
        self.copied_count += total_events; // naive follower copies everything
        self.false_positive_count += poison_count;
        self.true_positive_count += real_count;
    }

    pub fn false_positive_rate(&self) -> f32 {
        if self.copied_count == 0 {
            return 0.0;
        }
        self.false_positive_count as f32 / self.copied_count as f32
    }

    pub fn precision(&self) -> f32 {
        if self.copied_count == 0 {
            return 1.0;
        }
        self.true_positive_count as f32 / self.copied_count as f32
    }
}

#[derive(Debug)]
pub struct SimReport {
    pub total_events: u32,
    pub real_events: u32,
    pub poison_events: u32,
    pub follower_false_positive_rate: f32,
    pub follower_precision: f32,
    pub edge_destroyed: bool, // true if precision < 0.5
}

pub fn run_simulation(total_events: u32, poison_ratio: f32) -> SimReport {
    let poison_count = (total_events as f32 * poison_ratio) as u32;
    let real_count = total_events - poison_count;
    let mut follower = NaiveFollower::default();
    follower.simulate(total_events, real_count);
    let fp_rate = follower.false_positive_rate();
    let precision = follower.precision();
    SimReport {
        total_events,
        real_events: real_count,
        poison_events: poison_count,
        follower_false_positive_rate: fp_rate,
        follower_precision: precision,
        edge_destroyed: precision < 0.5,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_no_poison_perfect_precision() {
        let report = run_simulation(100, 0.0);
        assert_eq!(report.poison_events, 0);
        assert_eq!(report.real_events, 100);
        assert!((report.follower_precision - 1.0).abs() < 1e-5);
        assert!((report.follower_false_positive_rate - 0.0).abs() < 1e-5);
        assert!(!report.edge_destroyed);
    }

    #[test]
    fn test_half_poison_half_precision() {
        let report = run_simulation(100, 0.5);
        assert_eq!(report.poison_events, 50);
        assert_eq!(report.real_events, 50);
        assert!((report.follower_precision - 0.5).abs() < 1e-5);
        assert!((report.follower_false_positive_rate - 0.5).abs() < 1e-5);
        // precision == 0.5, edge_destroyed is false (strictly < 0.5)
        assert!(!report.edge_destroyed);
    }

    #[test]
    fn test_high_poison_destroys_edge() {
        let report = run_simulation(100, 0.8);
        // precision should be ~0.2, well below 0.5
        assert!(report.follower_precision < 0.5);
        assert!(report.edge_destroyed);
    }

    #[test]
    fn test_false_positive_rate() {
        let report = run_simulation(200, 0.25);
        // poison = 50, real = 150, fp_rate = 50/200 = 0.25
        assert!((report.follower_false_positive_rate - 0.25).abs() < 1e-4);
        assert!((report.follower_precision - 0.75).abs() < 1e-4);
    }

    #[test]
    fn test_zero_events() {
        let report = run_simulation(0, 0.5);
        assert_eq!(report.total_events, 0);
        let mut follower = NaiveFollower::default();
        assert_eq!(follower.false_positive_rate(), 0.0);
        assert_eq!(follower.precision(), 1.0);
        follower.simulate(0, 0);
        assert_eq!(follower.false_positive_rate(), 0.0);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_full_poison_zero_precision() {
        let report = run_simulation(100, 1.0);
        assert_eq!(report.poison_events, 100);
        assert_eq!(report.real_events, 0);
        assert!((report.follower_precision - 0.0).abs() < 1e-5);
        assert!(report.edge_destroyed);
    }

    #[test]
    fn test_edge_destroyed_just_below_half() {
        // poison_ratio 0.51 → poison=51, real=49, precision=0.49 < 0.5 → destroyed
        let report = run_simulation(100, 0.51);
        assert!(
            report.follower_precision < 0.5,
            "precision must be below 0.5 when 51% is poison"
        );
        assert!(report.edge_destroyed);
    }

    #[test]
    fn test_total_events_field() {
        let report = run_simulation(250, 0.3);
        assert_eq!(report.total_events, 250);
    }

    #[test]
    fn test_poison_plus_real_equals_total() {
        let report = run_simulation(200, 0.4);
        assert_eq!(
            report.poison_events + report.real_events,
            report.total_events
        );
    }

    #[test]
    fn test_naive_follower_simulate_accumulates() {
        let mut follower = NaiveFollower::default();
        follower.simulate(100, 70);
        follower.simulate(100, 70);
        assert_eq!(follower.copied_count, 200);
        assert_eq!(follower.true_positive_count, 140);
        assert_eq!(follower.false_positive_count, 60);
    }

    #[test]
    fn test_naive_follower_default_all_zeros() {
        let follower = NaiveFollower::default();
        assert_eq!(follower.copied_count, 0);
        assert_eq!(follower.false_positive_count, 0);
        assert_eq!(follower.true_positive_count, 0);
    }

    #[test]
    fn test_poison_zero_ratio_no_poison_events() {
        let report = run_simulation(50, 0.0);
        assert_eq!(report.poison_events, 0);
    }

    #[test]
    fn test_follower_copies_everything() {
        let mut follower = NaiveFollower::default();
        follower.simulate(100, 70);
        assert_eq!(
            follower.copied_count, 100,
            "naive follower must copy all events"
        );
    }

    #[test]
    fn test_precision_one_when_no_copies() {
        let follower = NaiveFollower::default();
        assert!((follower.precision() - 1.0).abs() < 1e-5);
    }

    #[test]
    fn test_false_positive_rate_zero_when_no_copies() {
        let follower = NaiveFollower::default();
        assert!((follower.false_positive_rate() - 0.0).abs() < 1e-5);
    }

    #[test]
    fn test_high_precision_low_poison_no_edge_destroyed() {
        // 10% poison → real=90, precision≈0.9 → not destroyed
        let report = run_simulation(100, 0.1);
        assert!(report.follower_precision > 0.5);
        assert!(!report.edge_destroyed);
    }
}
