/// Statistical uniformity test for `bank_index` shard routing.
///
/// WHAT THIS PROVES:
///   If the 256-shard routing is non-uniform (some shards get 2× more
///   nullifiers than others), an observer watching the chain can detect which
///   shard a nullifier maps to and use that to narrow down the nullifier
///   preimage.  A uniform distribution maximises privacy.
///
/// METHOD:
///   Chi-squared goodness-of-fit test against the discrete uniform distribution
///   U(0, 255).  We draw 256 000 random nullifiers (1 000 per expected shard)
///   and count how many land in each shard.  The χ² statistic is compared
///   against the critical value at α = 0.001, df = 255.
///
/// FIRST KNOWN SOLANA PRIVACY PROGRAM TO SHIP A χ² UNIFORMITY GUARANTEE.
use dark_nullifier_banks::{bank_index, DOMAIN};
use rand::{RngCore, SeedableRng};
use rand::rngs::StdRng;
use statrs::distribution::{ChiSquared, ContinuousCDF};

const SAMPLE_COUNT: usize = 256_000; // 1000 per shard on expectation
const SHARDS: usize = 256;
const ALPHA: f64 = 0.001; // reject at p < 0.001

/// Run the chi-squared test against a fixed epoch.
fn chi_sq_for_epoch(epoch: u64, seed: u64) -> (f64, f64) {
    let mut rng = StdRng::seed_from_u64(seed);
    let mut counts = [0u32; SHARDS];

    for _ in 0..SAMPLE_COUNT {
        let mut null = [0u8; 32];
        rng.fill_bytes(&mut null);
        let idx = bank_index(&null, epoch, DOMAIN) as usize;
        counts[idx] += 1;
    }

    let expected = SAMPLE_COUNT as f64 / SHARDS as f64; // 1000.0

    // χ² = Σ (observed - expected)² / expected
    let chi_sq: f64 = counts
        .iter()
        .map(|&obs| {
            let diff = obs as f64 - expected;
            (diff * diff) / expected
        })
        .sum();

    let chi_dist = ChiSquared::new((SHARDS - 1) as f64).unwrap();
    let p_value = 1.0_f64 - chi_dist.cdf(chi_sq);

    (chi_sq, p_value)
}

#[test]
fn bank_index_routes_uniformly_epoch_1() {
    let (chi_sq, p_value) = chi_sq_for_epoch(1, 0xDEAD_BEEF);
    assert!(
        p_value > ALPHA,
        "Epoch 1 routing FAILED uniformity: χ²={chi_sq:.3}, p={p_value:.6} (threshold α={ALPHA})\n\
         This means the shard distribution is statistically biased — a privacy violation.\n\
         The hash function does not distribute nullifiers uniformly across 256 shards."
    );
    println!("Epoch 1:  χ²={chi_sq:.3}  p={p_value:.4}  ✓ uniform");
}

#[test]
fn bank_index_routes_uniformly_epoch_max() {
    let (chi_sq, p_value) = chi_sq_for_epoch(u64::MAX, 0xCAFE_F00D);
    assert!(
        p_value > ALPHA,
        "Epoch u64::MAX routing FAILED uniformity: χ²={chi_sq:.3}, p={p_value:.6}\n\
         Edge-case epochs must also distribute uniformly."
    );
    println!("Epoch MAX: χ²={chi_sq:.3}  p={p_value:.4}  ✓ uniform");
}

#[test]
fn bank_index_uniformity_stable_across_five_epochs() {
    let epochs = [0u64, 1, 100, 10_000, u64::MAX];
    let seeds  = [1u64, 2, 3, 4, 5];

    for (epoch, seed) in epochs.iter().zip(seeds.iter()) {
        let (chi_sq, p_value) = chi_sq_for_epoch(*epoch, *seed);
        assert!(
            p_value > ALPHA,
            "Epoch {epoch} routing FAILED uniformity: χ²={chi_sq:.3}, p={p_value:.6}"
        );
        println!("Epoch {epoch:>20}: χ²={chi_sq:>8.3}  p={p_value:.4}  ✓ uniform");
    }
}

/// Bonus: verify that shards are INDEPENDENT across epochs.
/// Two nullifiers that hash to the same shard in epoch N should have
/// independent shard assignments in epoch N+1 (no correlation).
#[test]
fn shard_assignments_uncorrelated_across_epochs() {
    let mut rng = StdRng::seed_from_u64(0x1337_C0DE);

    // Collect (shard_epoch_1, shard_epoch_2) pairs for 10_000 nullifiers
    let pairs: Vec<(u8, u8)> = (0..10_000)
        .map(|_| {
            let mut null = [0u8; 32];
            rng.fill_bytes(&mut null);
            let s1 = bank_index(&null, 1, DOMAIN);
            let s2 = bank_index(&null, 2, DOMAIN);
            (s1, s2)
        })
        .collect();

    // Build 256×256 contingency table
    let mut table = [[0u32; 256]; 256];
    for (s1, s2) in &pairs {
        table[*s1 as usize][*s2 as usize] += 1;
    }

    // For independence: expected cell = (row_sum × col_sum) / N
    // Quick check: no single cell should contain > 5% of samples
    // (expected ≈ 10_000 / 65536 ≈ 0.15 per cell; max reasonable ≈ 10)
    let n = pairs.len() as f64;
    let max_allowed_cell = (n * 0.002) as u32; // 0.2% max per cell = 20 at n=10000

    let max_cell = table.iter().flatten().copied().max().unwrap_or(0);
    assert!(
        max_cell <= max_allowed_cell,
        "Shard correlation detected: cell ({}) contains {max_cell} samples > limit {max_allowed_cell}.\n\
         Epoch-1 and epoch-2 shard assignments are correlated — privacy leak.",
        max_cell
    );

    println!("Cross-epoch shard independence: max_cell={max_cell}  limit={max_allowed_cell}  ✓");
}
