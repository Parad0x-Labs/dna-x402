use sha2::{Sha256, Digest};

#[derive(Debug, Clone, PartialEq)]
pub enum FogGrade {
    Clear,
    Warm,
    Hot,
    Storm,
}

#[derive(Debug, Clone)]
pub struct AccountHeat {
    pub account_hash: [u8; 32],
    pub recent_fee_lamports: u64,
    pub heat_index: f32,
}

#[derive(Debug, Clone)]
pub struct RouteWeather {
    pub route_hash: [u8; 32],
    pub accounts: Vec<AccountHeat>,
    pub composite_heat: f32,
    pub fog_grade: FogGrade,
    pub estimated_fee_lamports: u64,
}

#[derive(Debug, Clone)]
pub struct SavingsReceipt {
    pub hot_route_fee: u64,
    pub cold_route_fee: u64,
    pub savings_lamports: u64,
    pub protocol_fee_lamports: u64,
    pub receipt_hash: [u8; 32],
}

#[derive(Debug, Clone)]
pub struct StormWarning {
    pub account_hash: [u8; 32],
    pub heat_index: f32,
    pub recommended_delay_slots: u64,
}

pub fn score_account_heat(
    account_hash: &[u8; 32],
    recent_fee: u64,
    baseline_fee: u64,
) -> AccountHeat {
    let base = baseline_fee.max(1);
    let raw = recent_fee as f32 / base as f32;
    let heat_index = raw.min(1.0);
    AccountHeat {
        account_hash: *account_hash,
        recent_fee_lamports: recent_fee,
        heat_index,
    }
}

pub fn score_route_weather(route_hash: &[u8; 32], accounts: Vec<AccountHeat>) -> RouteWeather {
    let composite_heat = if accounts.is_empty() {
        0.0
    } else {
        let sum: f32 = accounts.iter().map(|a| a.heat_index).sum();
        sum / accounts.len() as f32
    };

    let fog_grade = if composite_heat < 0.25 {
        FogGrade::Clear
    } else if composite_heat < 0.5 {
        FogGrade::Warm
    } else if composite_heat < 0.75 {
        FogGrade::Hot
    } else {
        FogGrade::Storm
    };

    let estimated_fee_lamports: u64 = accounts.iter().map(|a| a.recent_fee_lamports).sum();

    RouteWeather {
        route_hash: *route_hash,
        accounts,
        composite_heat,
        fog_grade,
        estimated_fee_lamports,
    }
}

pub fn select_coldest_route(routes: Vec<RouteWeather>) -> Option<RouteWeather> {
    routes
        .into_iter()
        .min_by(|a, b| a.composite_heat.partial_cmp(&b.composite_heat).unwrap_or(std::cmp::Ordering::Equal))
}

pub fn mint_savings_receipt(hot_fee: u64, cold_fee: u64) -> SavingsReceipt {
    let savings_lamports = hot_fee.saturating_sub(cold_fee);
    let protocol_fee_lamports = savings_lamports / 10;

    let mut hasher = Sha256::new();
    hasher.update(b"savings-receipt-v1");
    hasher.update(hot_fee.to_le_bytes());
    hasher.update(cold_fee.to_le_bytes());
    hasher.update(savings_lamports.to_le_bytes());
    let receipt_hash: [u8; 32] = hasher.finalize().into();

    SavingsReceipt {
        hot_route_fee: hot_fee,
        cold_route_fee: cold_fee,
        savings_lamports,
        protocol_fee_lamports,
        receipt_hash,
    }
}

pub fn check_storm_warning(heat: &AccountHeat) -> Option<StormWarning> {
    if heat.heat_index >= 0.75 {
        Some(StormWarning {
            account_hash: heat.account_hash,
            heat_index: heat.heat_index,
            recommended_delay_slots: ((heat.heat_index * 100.0) as u64).saturating_sub(75),
        })
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_hash(seed: u8) -> [u8; 32] {
        let mut h = [0u8; 32];
        h[0] = seed;
        h
    }

    #[test]
    fn test_cold_account_scores_low() {
        let heat = score_account_heat(&dummy_hash(1), 100, 10_000);
        assert!(heat.heat_index < 0.25, "expected low heat, got {}", heat.heat_index);
    }

    #[test]
    fn test_hot_account_scores_high() {
        let heat = score_account_heat(&dummy_hash(2), 10_000, 1_000);
        assert_eq!(heat.heat_index, 1.0, "heat capped at 1.0");
    }

    #[test]
    fn test_composite_heat_is_average() {
        let h1 = score_account_heat(&dummy_hash(1), 250, 1_000);  // 0.25
        let h2 = score_account_heat(&dummy_hash(2), 750, 1_000);  // 0.75
        let route = score_route_weather(&dummy_hash(99), vec![h1, h2]);
        let expected = 0.5f32;
        assert!(
            (route.composite_heat - expected).abs() < 1e-5,
            "expected ~0.5, got {}",
            route.composite_heat
        );
    }

    #[test]
    fn test_fog_grade_clear_below_025() {
        let h = score_account_heat(&dummy_hash(1), 100, 10_000); // 0.01
        let route = score_route_weather(&dummy_hash(1), vec![h]);
        assert_eq!(route.fog_grade, FogGrade::Clear);
    }

    #[test]
    fn test_fog_grade_storm_above_075() {
        let h = score_account_heat(&dummy_hash(1), 800, 1_000); // 0.8
        let route = score_route_weather(&dummy_hash(1), vec![h]);
        assert_eq!(route.fog_grade, FogGrade::Storm);
    }

    #[test]
    fn test_coldest_route_selected() {
        let cold_h = score_account_heat(&dummy_hash(1), 100, 10_000);
        let hot_h = score_account_heat(&dummy_hash(2), 9_000, 10_000);

        let cold_route = score_route_weather(&dummy_hash(10), vec![cold_h]);
        let hot_route = score_route_weather(&dummy_hash(11), vec![hot_h]);

        let selected = select_coldest_route(vec![hot_route, cold_route]).unwrap();
        assert_eq!(selected.route_hash[0], 10, "should pick cold route");
    }

    #[test]
    fn test_savings_receipt_protocol_fee_is_10pct() {
        let receipt = mint_savings_receipt(10_000, 4_000);
        assert_eq!(receipt.savings_lamports, 6_000);
        assert_eq!(receipt.protocol_fee_lamports, 600);
    }

    #[test]
    fn test_storm_warning_triggered_above_075() {
        let hot_hash = dummy_hash(5);
        let heat = score_account_heat(&hot_hash, 900, 1_000); // 0.9
        let warning = check_storm_warning(&heat);
        assert!(warning.is_some(), "storm warning expected");

        let cold_hash = dummy_hash(6);
        let cold = score_account_heat(&cold_hash, 100, 1_000); // 0.1
        let no_warning = check_storm_warning(&cold);
        assert!(no_warning.is_none(), "no warning expected for cold account");
    }
}
