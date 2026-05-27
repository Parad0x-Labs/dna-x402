#[derive(Clone, Debug)]
pub struct TxMetadata {
    pub signer_count: u8,
    pub writable_account_count: u8,
    pub readonly_account_count: u8,
    pub program_count: u8,
    pub amount_is_exact: bool, // true if exact amount visible (vs bucket)
    pub uses_alt: bool,
    pub has_memo: bool,
    pub memo_entropy_bits: u8, // bits of entropy in memo (0 = fixed phrase)
    pub shape_class_pool_size: u32, // how many others share this tx shape
    pub delay_applied: bool,   // strategy cloak applied
    pub route_class: u8,       // 0=direct, 1=jito, 2=swqos
    pub is_devnet: bool,
}

#[derive(Debug)]
pub struct LeakReport {
    pub timing_leak_score: f32, // 0.0 (no leak) to 1.0 (full leak)
    pub account_uniqueness_score: f32,
    pub route_leak_score: f32,
    pub amount_leak_score: f32,
    pub copy_sniper_risk: f32,
    pub public_demo_safe: bool,
    pub overall_risk: f32,
    pub notes: Vec<&'static str>,
}

pub fn score_tx(meta: &TxMetadata) -> LeakReport {
    let mut notes = vec![];

    // Timing leak: did they apply cloak delay?
    let timing_leak = if meta.delay_applied { 0.1 } else { 0.8 };
    if !meta.delay_applied {
        notes.push("no timing delay applied");
    }

    // Account uniqueness: smaller pool = more unique = more leak
    let account_uniqueness = if meta.shape_class_pool_size >= 100 {
        0.05
    } else if meta.shape_class_pool_size >= 10 {
        0.3
    } else {
        0.9
    };
    if meta.shape_class_pool_size < 10 {
        notes.push("highly unique account pattern");
    }

    // Route leak: direct is more fingerprintable
    let route_leak = match meta.route_class {
        0 => 0.7,
        1 => 0.2,
        2 => 0.3,
        _ => 0.5,
    };
    if meta.route_class == 0 {
        notes.push("direct RPC route is fingerprintable");
    }

    // Amount leak: exact amount reveals more
    let amount_leak = if meta.amount_is_exact { 0.8 } else { 0.2 };
    if meta.amount_is_exact {
        notes.push("exact amount visible");
    }

    // Memo leak
    if meta.has_memo && meta.memo_entropy_bits < 32 {
        notes.push("low-entropy memo phrase");
    }

    // ALT helps
    if !meta.uses_alt && meta.writable_account_count > 3 {
        notes.push("consider ALT for account camouflage");
    }

    // Copy sniper risk
    let copy_sniper_risk =
        (timing_leak * 0.4_f32 + account_uniqueness * 0.3_f32 + amount_leak * 0.3_f32).min(1.0_f32);

    let overall = (timing_leak + account_uniqueness + route_leak + amount_leak) / 4.0;

    // Public demo safe if devnet + overall risk below threshold
    let demo_safe = meta.is_devnet && overall < 0.7;

    LeakReport {
        timing_leak_score: timing_leak,
        account_uniqueness_score: account_uniqueness,
        route_leak_score: route_leak,
        amount_leak_score: amount_leak,
        copy_sniper_risk,
        public_demo_safe: demo_safe,
        overall_risk: overall,
        notes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_meta() -> TxMetadata {
        TxMetadata {
            signer_count: 1,
            writable_account_count: 2,
            readonly_account_count: 1,
            program_count: 1,
            amount_is_exact: false,
            uses_alt: false,
            has_memo: false,
            memo_entropy_bits: 64,
            shape_class_pool_size: 100,
            delay_applied: true,
            route_class: 1,
            is_devnet: false,
        }
    }

    #[test]
    fn test_unique_account_high_risk() {
        let mut meta = base_meta();
        meta.shape_class_pool_size = 1; // extremely unique
        let report = score_tx(&meta);
        assert!(report.account_uniqueness_score > 0.8);
        assert!(report.notes.contains(&"highly unique account pattern"));
    }

    #[test]
    fn test_common_shape_lowers_risk() {
        let mut meta = base_meta();
        meta.shape_class_pool_size = 1000; // very common shape
        let report = score_tx(&meta);
        assert!(report.account_uniqueness_score < 0.1);
        assert!(!report.notes.contains(&"highly unique account pattern"));
    }

    #[test]
    fn test_exact_amount_higher_risk() {
        let mut meta_exact = base_meta();
        meta_exact.amount_is_exact = true;
        let mut meta_bucket = base_meta();
        meta_bucket.amount_is_exact = false;
        let exact_report = score_tx(&meta_exact);
        let bucket_report = score_tx(&meta_bucket);
        assert!(exact_report.amount_leak_score > bucket_report.amount_leak_score);
        assert!(exact_report.notes.contains(&"exact amount visible"));
    }

    #[test]
    fn test_delayed_lowers_timing_risk() {
        let mut meta_delayed = base_meta();
        meta_delayed.delay_applied = true;
        let mut meta_no_delay = base_meta();
        meta_no_delay.delay_applied = false;
        let delayed = score_tx(&meta_delayed);
        let no_delay = score_tx(&meta_no_delay);
        assert!(delayed.timing_leak_score < no_delay.timing_leak_score);
        assert!(no_delay.notes.contains(&"no timing delay applied"));
    }

    #[test]
    fn test_memo_low_entropy_noted() {
        let mut meta = base_meta();
        meta.has_memo = true;
        meta.memo_entropy_bits = 8; // very low
        let report = score_tx(&meta);
        assert!(report.notes.contains(&"low-entropy memo phrase"));
    }

    #[test]
    fn test_devnet_demo_safe() {
        // Low-risk devnet scenario should be demo-safe
        let meta = TxMetadata {
            signer_count: 1,
            writable_account_count: 2,
            readonly_account_count: 1,
            program_count: 1,
            amount_is_exact: false,
            uses_alt: true,
            has_memo: false,
            memo_entropy_bits: 64,
            shape_class_pool_size: 500,
            delay_applied: true,
            route_class: 1,
            is_devnet: true,
        };
        let report = score_tx(&meta);
        assert!(report.public_demo_safe);

        // High-risk mainnet should NOT be demo-safe
        let mut risky = base_meta();
        risky.is_devnet = false;
        risky.delay_applied = false;
        risky.amount_is_exact = true;
        risky.shape_class_pool_size = 1;
        let risky_report = score_tx(&risky);
        assert!(!risky_report.public_demo_safe);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_overall_risk_bounded() {
        let report = score_tx(&base_meta());
        assert!(report.overall_risk >= 0.0 && report.overall_risk <= 1.0);
    }

    #[test]
    fn test_direct_route_higher_leak_than_jito() {
        let mut direct = base_meta();
        direct.route_class = 0;
        let mut jito = base_meta();
        jito.route_class = 1;
        assert!(score_tx(&direct).route_leak_score > score_tx(&jito).route_leak_score);
    }

    #[test]
    fn test_direct_route_notes_rpc() {
        let mut meta = base_meta();
        meta.route_class = 0;
        let report = score_tx(&meta);
        assert!(report
            .notes
            .contains(&"direct RPC route is fingerprintable"));
    }

    #[test]
    fn test_copy_sniper_risk_bounded() {
        let report = score_tx(&base_meta());
        assert!(report.copy_sniper_risk >= 0.0 && report.copy_sniper_risk <= 1.0);
    }

    #[test]
    fn test_high_entropy_memo_no_low_entropy_note() {
        let mut meta = base_meta();
        meta.has_memo = true;
        meta.memo_entropy_bits = 64;
        let report = score_tx(&meta);
        assert!(!report.notes.contains(&"low-entropy memo phrase"));
    }

    #[test]
    fn test_many_writables_no_alt_noted() {
        let mut meta = base_meta();
        meta.uses_alt = false;
        meta.writable_account_count = 5;
        let report = score_tx(&meta);
        assert!(report
            .notes
            .contains(&"consider ALT for account camouflage"));
    }

    #[test]
    fn test_with_alt_no_camouflage_note() {
        let mut meta = base_meta();
        meta.uses_alt = true;
        meta.writable_account_count = 5;
        let report = score_tx(&meta);
        assert!(!report
            .notes
            .contains(&"consider ALT for account camouflage"));
    }

    #[test]
    fn test_mainnet_not_demo_safe() {
        let mut meta = base_meta();
        meta.is_devnet = false;
        let report = score_tx(&meta);
        assert!(!report.public_demo_safe);
    }

    #[test]
    fn test_unique_shape_raises_copy_sniper_risk() {
        let mut common = base_meta();
        common.shape_class_pool_size = 1000;
        let mut unique = base_meta();
        unique.shape_class_pool_size = 1;
        assert!(score_tx(&unique).copy_sniper_risk > score_tx(&common).copy_sniper_risk);
    }

    #[test]
    fn test_no_delay_appears_in_notes() {
        let mut meta = base_meta();
        meta.delay_applied = false;
        let report = score_tx(&meta);
        assert!(report.notes.contains(&"no timing delay applied"));
    }
}
