use sha2::{Digest, Sha256};

/// A mocked fee sample per writable account
#[derive(Clone, Debug)]
pub struct FeeSample {
    pub account: [u8; 32],
    pub slot: u64,
    pub prioritization_fee_micro_lamports: u64,
}

#[derive(Clone, Debug)]
pub struct AccountHeat {
    pub account: [u8; 32],
    pub sample_count: u32,
    pub mean_fee: u64,
    pub max_fee: u64,
    pub heat_score: f32, // 0.0 (cold) to 1.0 (hot)
}

pub const STALE_SLOT_THRESHOLD: u64 = 150; // ~1 minute at 400ms/slot

/// Compute heat map from fee samples, ignoring stale ones
pub fn compute_heat_map(samples: &[FeeSample], current_slot: u64) -> Vec<AccountHeat> {
    let mut acc: std::collections::HashMap<[u8; 32], Vec<u64>> = std::collections::HashMap::new();
    for s in samples {
        if current_slot.saturating_sub(s.slot) <= STALE_SLOT_THRESHOLD {
            acc.entry(s.account)
                .or_default()
                .push(s.prioritization_fee_micro_lamports);
        }
    }
    let mut heats: Vec<AccountHeat> = acc
        .into_iter()
        .map(|(account, fees)| {
            let mean = fees.iter().sum::<u64>() / fees.len() as u64;
            let max = *fees.iter().max().unwrap_or(&0);
            AccountHeat {
                account,
                sample_count: fees.len() as u32,
                mean_fee: mean,
                max_fee: max,
                heat_score: 0.0,
            }
        })
        .collect();
    // Normalize heat_score: mean_fee / global_max_fee
    if let Some(global_max) = heats.iter().map(|h| h.mean_fee).max() {
        if global_max > 0 {
            for h in &mut heats {
                h.heat_score = h.mean_fee as f32 / global_max as f32;
            }
        }
    }
    heats.sort_by(|a, b| {
        b.heat_score
            .partial_cmp(&a.heat_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    heats
}

/// Given candidates (account pubkeys), return the one with lowest heat
pub fn select_coolest(candidates: &[[u8; 32]], heat_map: &[AccountHeat]) -> Option<[u8; 32]> {
    candidates
        .iter()
        .min_by_key(|c| {
            heat_map
                .iter()
                .find(|h| &h.account == *c)
                .map(|h| (h.mean_fee, 0u8))
                .unwrap_or((0, 0))
        })
        .copied()
}

/// True if any writable account in proposed_writables is in the hot set (heat > threshold)
pub fn has_hot_account(
    proposed_writables: &[[u8; 32]],
    heat_map: &[AccountHeat],
    threshold: f32,
) -> bool {
    proposed_writables.iter().any(|w| {
        heat_map
            .iter()
            .any(|h| &h.account == w && h.heat_score > threshold)
    })
}

/// Stale samples are silently ignored (tested separately)
pub fn count_stale(samples: &[FeeSample], current_slot: u64) -> usize {
    samples
        .iter()
        .filter(|s| current_slot.saturating_sub(s.slot) > STALE_SLOT_THRESHOLD)
        .count()
}

// Suppress unused import warning — sha2 is a declared dep even if not used directly in lib
fn _sha2_used() {
    let _ = Sha256::new();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_account(byte: u8) -> [u8; 32] {
        let mut a = [0u8; 32];
        a[0] = byte;
        a
    }

    #[test]
    fn test_heat_map_basic() {
        let acct = make_account(1);
        let samples = vec![
            FeeSample {
                account: acct,
                slot: 100,
                prioritization_fee_micro_lamports: 500,
            },
            FeeSample {
                account: acct,
                slot: 101,
                prioritization_fee_micro_lamports: 700,
            },
        ];
        let map = compute_heat_map(&samples, 150);
        assert_eq!(map.len(), 1);
        assert_eq!(map[0].sample_count, 2);
        assert_eq!(map[0].mean_fee, 600);
        assert_eq!(map[0].max_fee, 700);
    }

    #[test]
    fn test_stale_samples_ignored() {
        let acct = make_account(2);
        // slot 0, current_slot 200 => diff 200 > 150, stale
        let samples = vec![FeeSample {
            account: acct,
            slot: 0,
            prioritization_fee_micro_lamports: 9999,
        }];
        let map = compute_heat_map(&samples, 200);
        assert!(map.is_empty());
        assert_eq!(count_stale(&samples, 200), 1);
    }

    #[test]
    fn test_hot_account_detected() {
        let hot = make_account(3);
        let cold = make_account(4);
        let samples = vec![
            FeeSample {
                account: hot,
                slot: 100,
                prioritization_fee_micro_lamports: 1000,
            },
            FeeSample {
                account: cold,
                slot: 100,
                prioritization_fee_micro_lamports: 100,
            },
        ];
        let map = compute_heat_map(&samples, 150);
        // hot should have heat_score = 1.0
        assert!(has_hot_account(&[hot], &map, 0.9));
        assert!(!has_hot_account(&[cold], &map, 0.9));
    }

    #[test]
    fn test_coolest_selected() {
        let a = make_account(5);
        let b = make_account(6);
        let samples = vec![
            FeeSample {
                account: a,
                slot: 100,
                prioritization_fee_micro_lamports: 1000,
            },
            FeeSample {
                account: b,
                slot: 100,
                prioritization_fee_micro_lamports: 200,
            },
        ];
        let map = compute_heat_map(&samples, 150);
        let coolest = select_coolest(&[a, b], &map);
        assert_eq!(coolest, Some(b));
    }

    #[test]
    fn test_heat_score_normalized() {
        let a = make_account(7);
        let b = make_account(8);
        let samples = vec![
            FeeSample {
                account: a,
                slot: 100,
                prioritization_fee_micro_lamports: 1000,
            },
            FeeSample {
                account: b,
                slot: 100,
                prioritization_fee_micro_lamports: 500,
            },
        ];
        let map = compute_heat_map(&samples, 150);
        // hottest must be 1.0
        assert!((map[0].heat_score - 1.0).abs() < 1e-5);
        // second must be 0.5
        assert!((map[1].heat_score - 0.5).abs() < 1e-5);
    }

    #[test]
    fn test_no_samples_no_heat() {
        let map = compute_heat_map(&[], 1000);
        assert!(map.is_empty());
    }
}
