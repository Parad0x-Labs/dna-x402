//! Rent Blast Radius — answer "how much SOL does this feature lock?"
//! before writing a single account struct.
//!
//! Formula: rent_exempt = (ACCOUNT_OVERHEAD_BYTES + data_len) * LAMPORTS_PER_BYTE_YEAR * 2
//! Current Solana mainnet rate: 3480 lamports / byte / year (approximate).

pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;
pub const ACCOUNT_OVERHEAD_BYTES: u64 = 128; // account metadata overhead
pub const LAMPORTS_PER_BYTE_YEAR: u64 = 3_480;
pub const RENT_EXEMPT_YEARS: u64 = 2;

/// Minimum rent-exempt deposit for an account with `data_len` bytes.
pub fn rent_exempt_lamports(data_len: usize) -> u64 {
    (ACCOUNT_OVERHEAD_BYTES + data_len as u64) * LAMPORTS_PER_BYTE_YEAR * RENT_EXEMPT_YEARS
}

/// Convert lamports to SOL (floating point for display).
pub fn lamports_to_sol(lamports: u64) -> f64 {
    lamports as f64 / LAMPORTS_PER_SOL as f64
}

/// Project total SOL locked if `account_count` accounts of `data_len` bytes each are created.
pub fn blast_radius_sol(data_len: usize, account_count: u64) -> f64 {
    lamports_to_sol(rent_exempt_lamports(data_len) * account_count)
}

/// Compare a "naive" design (many large accounts) vs "shoestring" design (small headers).
pub struct BlastComparison {
    pub naive_sol: f64,
    pub shoestring_sol: f64,
    pub savings_sol: f64,
    pub accounts_avoided: u64,
}

pub fn compare(
    naive_bytes: usize,
    shoestring_bytes: usize,
    account_count: u64,
    shoestring_account_count: u64,
) -> BlastComparison {
    let naive_sol = blast_radius_sol(naive_bytes, account_count);
    let shoestring_sol = blast_radius_sol(shoestring_bytes, shoestring_account_count);
    BlastComparison {
        naive_sol,
        shoestring_sol,
        savings_sol: naive_sol - shoestring_sol,
        accounts_avoided: account_count.saturating_sub(shoestring_account_count),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rent_zero_bytes() {
        let lamports = rent_exempt_lamports(0);
        // overhead only: 128 * 3480 * 2 = 890_880
        assert_eq!(
            lamports,
            ACCOUNT_OVERHEAD_BYTES * LAMPORTS_PER_BYTE_YEAR * RENT_EXEMPT_YEARS
        );
        assert!(lamports > 0);
    }

    #[test]
    fn test_rent_increases_with_size() {
        let small = rent_exempt_lamports(50);
        let large = rent_exempt_lamports(100);
        assert!(large > small);
    }

    #[test]
    fn test_blast_radius_scales_linearly() {
        let one = blast_radius_sol(200, 1);
        let thousand = blast_radius_sol(200, 1000);
        let diff = (thousand - one * 1000.0).abs();
        assert!(
            diff < 1e-6,
            "blast radius should scale linearly: diff = {}",
            diff
        );
    }

    #[test]
    fn test_compare_saves_sol() {
        // 1000 big accounts (1000 bytes each) vs 1 small header (32 bytes)
        let cmp = compare(1000, 32, 1000, 1);
        assert!(cmp.savings_sol > 0.0, "shoestring design should save SOL");
        assert_eq!(cmp.accounts_avoided, 999);
    }

    #[test]
    fn test_lamports_to_sol_roundtrip() {
        let sol = lamports_to_sol(1_000_000_000);
        let diff = (sol - 1.0_f64).abs();
        assert!(
            diff < 1e-9,
            "1_000_000_000 lamports should equal 1.0 SOL, got {}",
            sol
        );
    }
}
