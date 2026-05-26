use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WritableFeeSample {
    pub account_hash: [u8; 32],
    pub slot: u64,
    pub prioritization_fee_lamports: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteCandidate {
    pub route_id: [u8; 32],
    pub writable_account_hashes: Vec<[u8; 32]>,
    pub expected_priority_fee: u64,
    pub shape_hash: [u8; 32],
    pub k_shape: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteScore {
    pub route_id: [u8; 32],
    pub combined_score: f64,
    pub expected_savings_lamports: u64,
}

#[derive(Debug, PartialEq)]
pub enum RouteError {
    NoSafeCandidates,
    StaleFeeSamples,
    PrivacyTooLow,
}

pub fn score_route(
    candidate: &RouteCandidate,
    _samples: &[WritableFeeSample],
    reference_fee: u64,
) -> RouteScore {
    let fee_ratio = if reference_fee == 0 {
        0.0f64
    } else {
        candidate.expected_priority_fee as f64 / reference_fee as f64
    };
    let k_shape_score = (candidate.k_shape as f64 / 5.0f64).min(1.0f64);
    let combined_score = (1.0 - fee_ratio) * 0.5 + k_shape_score * 0.5;
    let savings = reference_fee.saturating_sub(candidate.expected_priority_fee);

    RouteScore {
        route_id: candidate.route_id,
        combined_score,
        expected_savings_lamports: savings,
    }
}

pub fn select_coldest_safe_route(
    candidates: Vec<RouteCandidate>,
    samples: &[WritableFeeSample],
    reference_fee: u64,
    min_k_shape: u32,
) -> Result<RouteCandidate, RouteError> {
    let filtered: Vec<&RouteCandidate> = candidates
        .iter()
        .filter(|c| c.k_shape >= min_k_shape)
        .collect();

    if filtered.is_empty() {
        return Err(RouteError::NoSafeCandidates);
    }

    let best = filtered
        .iter()
        .max_by(|a, b| {
            let sa = score_route(a, samples, reference_fee);
            let sb = score_route(b, samples, reference_fee);
            sa.combined_score
                .partial_cmp(&sb.combined_score)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap();

    Ok((*best).clone())
}

pub fn is_sample_fresh(sample: &WritableFeeSample, current_slot: u64, max_age_slots: u64) -> bool {
    current_slot.saturating_sub(sample.slot) <= max_age_slots
}

pub fn estimate_dark_null_cut(savings_lamports: u64, cut_bps: u64) -> u64 {
    savings_lamports * cut_bps / 10_000
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_candidate(id: u8, fee: u64, k: u32) -> RouteCandidate {
        RouteCandidate {
            route_id: [id; 32],
            writable_account_hashes: vec![[id; 32]],
            expected_priority_fee: fee,
            shape_hash: [id; 32],
            k_shape: k,
        }
    }

    #[test]
    fn test_lower_fee_route_selected() {
        let candidates = vec![make_candidate(1, 10_000, 3), make_candidate(2, 5_000, 3)];
        let result = select_coldest_safe_route(candidates, &[], 20_000, 1).unwrap();
        assert_eq!(result.expected_priority_fee, 5_000);
    }

    #[test]
    fn test_high_k_shape_beats_cheap_unique() {
        // k=5 with slightly higher fee should beat k=1 with lower fee
        let c1 = make_candidate(1, 1_000, 5); // k=5, high privacy score
        let c2 = make_candidate(2, 500, 1); // k=1, cheap but low privacy
        let reference = 10_000u64;

        let s1 = score_route(&c1, &[], reference);
        let s2 = score_route(&c2, &[], reference);
        // k=5: k_shape_score = 1.0, fee_ratio=0.1 → combined = 0.45+0.5 = 0.95
        // k=1: k_shape_score = 0.2, fee_ratio=0.05 → combined = 0.475+0.1 = 0.575
        assert!(s1.combined_score > s2.combined_score);
    }

    #[test]
    fn test_stale_samples_still_score() {
        let stale_sample = WritableFeeSample {
            account_hash: [0u8; 32],
            slot: 1,
            prioritization_fee_lamports: 100,
        };
        let candidate = make_candidate(1, 5_000, 3);
        let score = score_route(&candidate, &[stale_sample], 10_000);
        assert!(score.combined_score > 0.0);
    }

    #[test]
    fn test_min_k_shape_filter() {
        let candidates = vec![make_candidate(1, 1_000, 1), make_candidate(2, 2_000, 3)];
        let result = select_coldest_safe_route(candidates, &[], 10_000, 2).unwrap();
        assert_eq!(result.k_shape, 3);
    }

    #[test]
    fn test_savings_positive() {
        let candidates = vec![make_candidate(1, 4_000, 3)];
        let result = select_coldest_safe_route(candidates, &[], 10_000, 1).unwrap();
        let score = score_route(&result, &[], 10_000);
        assert!(score.expected_savings_lamports > 0);
    }

    #[test]
    fn test_protocol_cut_bounded() {
        let savings = 5_000u64;
        let cut = estimate_dark_null_cut(savings, 500); // 5%
        assert!(cut <= savings);
    }
}
