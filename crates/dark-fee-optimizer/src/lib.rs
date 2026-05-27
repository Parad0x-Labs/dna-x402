//! dark-fee-optimizer — Solana Fee Optimization Analysis for Dark Null
//!
//! P-Token (SIMD-0266): 98% CU reduction on SPL Token transfers.
//! Live on mainnet since epoch 971 (Agave ≥v3.1.7).
//! Source: https://www.helius.dev/blog/solana-p-token
//!
//! ZK Compression: ~1,000x cheaper state storage.
//! Light Protocol v2 live on mainnet.
//! Source: https://www.zkcompression.com/home
//!
//! Daily use case: Dark Null vault payout uses SPL Token TransferChecked.
//! With p-token live, that instruction costs ~111 CU instead of ~6,200 CU.
//! At 10,000 transactions/day that's 98% reduction in compute fee spend.
//!
//! NOT_PRODUCTION. Estimates only. Real costs vary with network conditions.

// ---------------------------------------------------------------------------
// Constants — P-Token CU costs (live on mainnet epoch 971)
// Source: https://www.helius.dev/blog/solana-p-token
// ---------------------------------------------------------------------------

pub const SPL_TOKEN_TRANSFER_CU_LEGACY: u64 = 4_645;
pub const P_TOKEN_TRANSFER_CU: u64 = 79;
pub const SPL_TOKEN_TRANSFER_CHECKED_CU_LEGACY: u64 = 6_200;
pub const P_TOKEN_TRANSFER_CHECKED_CU: u64 = 111;
pub const SPL_TOKEN_CLOSE_ACCOUNT_CU_LEGACY: u64 = 4_240;
pub const P_TOKEN_CLOSE_ACCOUNT_CU: u64 = 120;

// ---------------------------------------------------------------------------
// Constants — ZK Compression costs (Light Protocol v2 mainnet)
// Source: https://www.zkcompression.com/home
// ---------------------------------------------------------------------------

pub const ZK_PROOF_VERIFICATION_CU: u64 = 100_000;
pub const COMPRESSED_LEAF_LAMPORTS: u64 = 2_000;
/// Rent-exempt threshold for a ~128-byte Solana account (approximate).
pub const FULL_ACCOUNT_RENT_LAMPORTS: u64 = 890_880;

// ---------------------------------------------------------------------------
// Constants — Batch receipt checkpoint
// ---------------------------------------------------------------------------

pub const RECEIPTS_PER_CHECKPOINT: u64 = 100;
/// A checkpoint account holds only a 32-byte Merkle root + small header.
pub const CHECKPOINT_ACCOUNT_SIZE_BYTES: u64 = 64;

// ---------------------------------------------------------------------------
// Constants — Base fee
// ---------------------------------------------------------------------------

pub const BASE_FEE_LAMPORTS: u64 = 5_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct FeeProfile {
    pub instruction: String,
    pub legacy_cu: u64,
    pub optimized_cu: u64,
    pub cu_savings_pct: f32,
    pub source: String,
}

#[derive(Debug, Clone)]
pub struct DeploymentCostEstimate {
    pub receipts_per_day: u64,
    /// Total compute units consumed by token transfers (optimised p-token).
    pub transfer_cu_per_day: u64,
    /// Estimated transaction fee lamports for those transfers.
    pub transfer_fee_lamports_per_day: u64,
    /// Rent cost if every receipt used a full on-chain account.
    pub state_rent_lamports_if_full_accounts: u64,
    /// Rent cost using ZK Compression leaves.
    pub state_rent_lamports_if_compressed: u64,
    /// Absolute lamport savings from compression.
    pub state_savings_lamports: u64,
    /// Percentage of rent saved by compression.
    pub state_savings_pct: f32,
}

#[derive(Debug, Clone)]
pub struct BatchReceiptSaving {
    pub receipts: u64,
    pub on_chain_writes_naive: u64,
    pub on_chain_writes_batched: u64,
    pub saves_writes: u64,
    pub saves_lamports: u64,
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/// Returns p-token fee profiles for the three major SPL Token instructions.
pub fn p_token_fee_profiles() -> Vec<FeeProfile> {
    let source = "https://www.helius.dev/blog/solana-p-token".to_string();
    vec![
        FeeProfile {
            instruction: "Transfer".to_string(),
            legacy_cu: SPL_TOKEN_TRANSFER_CU_LEGACY,
            optimized_cu: P_TOKEN_TRANSFER_CU,
            cu_savings_pct: cu_savings_pct(SPL_TOKEN_TRANSFER_CU_LEGACY, P_TOKEN_TRANSFER_CU),
            source: source.clone(),
        },
        FeeProfile {
            instruction: "TransferChecked".to_string(),
            legacy_cu: SPL_TOKEN_TRANSFER_CHECKED_CU_LEGACY,
            optimized_cu: P_TOKEN_TRANSFER_CHECKED_CU,
            cu_savings_pct: cu_savings_pct(
                SPL_TOKEN_TRANSFER_CHECKED_CU_LEGACY,
                P_TOKEN_TRANSFER_CHECKED_CU,
            ),
            source: source.clone(),
        },
        FeeProfile {
            instruction: "CloseAccount".to_string(),
            legacy_cu: SPL_TOKEN_CLOSE_ACCOUNT_CU_LEGACY,
            optimized_cu: P_TOKEN_CLOSE_ACCOUNT_CU,
            cu_savings_pct: cu_savings_pct(
                SPL_TOKEN_CLOSE_ACCOUNT_CU_LEGACY,
                P_TOKEN_CLOSE_ACCOUNT_CU,
            ),
            source,
        },
    ]
}

fn cu_savings_pct(legacy: u64, optimized: u64) -> f32 {
    if legacy == 0 {
        return 0.0;
    }
    let saved = legacy.saturating_sub(optimized);
    (saved as f32 / legacy as f32) * 100.0
}

/// Estimates daily cost for a deployment with `receipts_per_day` receipts and
/// `token_transfers_per_day` SPL Token TransferChecked instructions.
pub fn estimate_deployment_cost(
    receipts_per_day: u64,
    token_transfers_per_day: u64,
) -> DeploymentCostEstimate {
    // CU from p-token TransferChecked
    let transfer_cu_per_day = token_transfers_per_day.saturating_mul(P_TOKEN_TRANSFER_CHECKED_CU);

    // Rough fee: 1 lamport per 1000 CU (very conservative; actual priority fees vary)
    // We use a simple proportional model: BASE_FEE per tx, ~1 tx per transfer.
    let transfer_fee_lamports_per_day = token_transfers_per_day.saturating_mul(BASE_FEE_LAMPORTS);

    let state_rent_lamports_if_full_accounts =
        receipts_per_day.saturating_mul(FULL_ACCOUNT_RENT_LAMPORTS);
    let state_rent_lamports_if_compressed =
        receipts_per_day.saturating_mul(COMPRESSED_LEAF_LAMPORTS);
    let state_savings_lamports =
        state_rent_lamports_if_full_accounts.saturating_sub(state_rent_lamports_if_compressed);

    let state_savings_pct = if state_rent_lamports_if_full_accounts == 0 {
        0.0
    } else {
        (state_savings_lamports as f32 / state_rent_lamports_if_full_accounts as f32) * 100.0
    };

    DeploymentCostEstimate {
        receipts_per_day,
        transfer_cu_per_day,
        transfer_fee_lamports_per_day,
        state_rent_lamports_if_full_accounts,
        state_rent_lamports_if_compressed,
        state_savings_lamports,
        state_savings_pct,
    }
}

/// Calculates batch receipt savings.
/// Naive: 1 account write per receipt.
/// Batched: 1 Merkle root commit per RECEIPTS_PER_CHECKPOINT receipts.
pub fn batch_receipt_savings(receipt_count: u64) -> BatchReceiptSaving {
    let on_chain_writes_naive = receipt_count;
    let on_chain_writes_batched =
        receipt_count.saturating_add(RECEIPTS_PER_CHECKPOINT - 1) / RECEIPTS_PER_CHECKPOINT;
    let saves_writes = on_chain_writes_naive.saturating_sub(on_chain_writes_batched);
    let saves_lamports = saves_writes.saturating_mul(BASE_FEE_LAMPORTS);
    BatchReceiptSaving {
        receipts: receipt_count,
        on_chain_writes_naive,
        on_chain_writes_batched,
        saves_writes,
        saves_lamports,
    }
}

/// Returns total CU savings ratio for p-token on TransferChecked (~0.982).
pub fn p_token_cu_savings_ratio() -> f32 {
    let saved = SPL_TOKEN_TRANSFER_CHECKED_CU_LEGACY.saturating_sub(P_TOKEN_TRANSFER_CHECKED_CU);
    saved as f32 / SPL_TOKEN_TRANSFER_CHECKED_CU_LEGACY as f32
}

/// Returns SOL saved per 1M token transfers with p-token, in lamports.
/// Uses a simple model: each transfer saves (legacy_cu - p_token_cu) * lamports_per_cu.
/// We approximate 1 lamport per CU for priority-fee estimation.
pub fn sol_saved_per_million_transfers() -> u64 {
    let cu_saved_per_transfer =
        SPL_TOKEN_TRANSFER_CHECKED_CU_LEGACY.saturating_sub(P_TOKEN_TRANSFER_CHECKED_CU);
    // 1 lamport per CU is a rough upper bound for priority fees;
    // even at this conservative estimate, savings are substantial.
    cu_saved_per_transfer.saturating_mul(1_000_000)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_p_token_transfer_cu_correct() {
        assert_eq!(P_TOKEN_TRANSFER_CU, 79);
    }

    #[test]
    fn test_p_token_savings_ratio() {
        let ratio = p_token_cu_savings_ratio();
        // (6200 - 111) / 6200 ≈ 0.9821
        assert!(ratio > 0.97, "expected >97% savings, got {:.4}", ratio);
        assert!(ratio < 1.0, "savings ratio must be < 1.0");
    }

    #[test]
    fn test_fee_profiles_not_empty() {
        let profiles = p_token_fee_profiles();
        assert!(!profiles.is_empty());
        assert_eq!(profiles.len(), 3);
        for p in &profiles {
            assert!(
                p.cu_savings_pct > 90.0,
                "expected >90% savings for {}",
                p.instruction
            );
        }
    }

    #[test]
    fn test_deployment_cost_zero_receipts() {
        let est = estimate_deployment_cost(0, 0);
        assert_eq!(est.receipts_per_day, 0);
        assert_eq!(est.transfer_cu_per_day, 0);
        assert_eq!(est.state_rent_lamports_if_full_accounts, 0);
        assert_eq!(est.state_rent_lamports_if_compressed, 0);
        assert_eq!(est.state_savings_lamports, 0);
        assert_eq!(est.state_savings_pct, 0.0);
    }

    #[test]
    fn test_deployment_cost_1k_receipts() {
        let est = estimate_deployment_cost(1_000, 1_000);
        assert!(est.state_savings_lamports > 0);
        assert!(est.state_rent_lamports_if_compressed < est.state_rent_lamports_if_full_accounts);
    }

    #[test]
    fn test_batch_receipt_savings_100() {
        let saving = batch_receipt_savings(100);
        assert_eq!(saving.receipts, 100);
        assert_eq!(saving.on_chain_writes_naive, 100);
        assert_eq!(saving.on_chain_writes_batched, 1);
        assert_eq!(saving.saves_writes, 99);
        assert!(saving.saves_lamports > 0);
    }

    #[test]
    fn test_compressed_leaf_cheaper_than_full_account() {
        assert!(
            COMPRESSED_LEAF_LAMPORTS < FULL_ACCOUNT_RENT_LAMPORTS,
            "compressed leaf ({}) must be cheaper than full account ({})",
            COMPRESSED_LEAF_LAMPORTS,
            FULL_ACCOUNT_RENT_LAMPORTS
        );
    }

    #[test]
    fn test_sol_saved_per_million_positive() {
        let saved = sol_saved_per_million_transfers();
        assert!(saved > 0, "must save lamports per million transfers");
    }

    #[test]
    fn test_deployment_cost_savings_pct_high() {
        let est = estimate_deployment_cost(10_000, 0);
        // (890880 - 2000) / 890880 * 100 ≈ 99.77%
        assert!(
            est.state_savings_pct > 99.0,
            "expected >99% state savings, got {:.2}%",
            est.state_savings_pct
        );
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_p_token_transfer_checked_cu_correct() {
        assert_eq!(P_TOKEN_TRANSFER_CHECKED_CU, 111);
    }

    #[test]
    fn test_transfer_cu_per_day_calculation() {
        let est = estimate_deployment_cost(0, 1_000);
        assert_eq!(est.transfer_cu_per_day, 1_000 * P_TOKEN_TRANSFER_CHECKED_CU);
    }

    #[test]
    fn test_batch_savings_zero_receipts() {
        let saving = batch_receipt_savings(0);
        assert_eq!(saving.receipts, 0);
        assert_eq!(saving.on_chain_writes_naive, 0);
        assert_eq!(saving.on_chain_writes_batched, 0);
        assert_eq!(saving.saves_writes, 0);
        assert_eq!(saving.saves_lamports, 0);
    }

    #[test]
    fn test_batch_savings_one_checkpoint_for_99() {
        let saving = batch_receipt_savings(99);
        // ceil(99/100) = 1 checkpoint
        assert_eq!(saving.on_chain_writes_batched, 1);
        assert_eq!(saving.saves_writes, 98);
    }

    #[test]
    fn test_sol_saved_large_amount() {
        let saved = sol_saved_per_million_transfers();
        let expected =
            (SPL_TOKEN_TRANSFER_CHECKED_CU_LEGACY - P_TOKEN_TRANSFER_CHECKED_CU) * 1_000_000;
        assert_eq!(saved, expected);
    }

    #[test]
    fn test_p_token_profiles_all_have_source_url() {
        let profiles = p_token_fee_profiles();
        for p in &profiles {
            assert!(
                !p.source.is_empty(),
                "source url must not be empty for {}",
                p.instruction
            );
            assert!(
                p.source.contains("http"),
                "source must look like a URL for {}",
                p.instruction
            );
        }
    }

    #[test]
    fn test_fee_profiles_instruction_names() {
        let profiles = p_token_fee_profiles();
        assert_eq!(profiles[0].instruction, "Transfer");
        assert_eq!(profiles[1].instruction, "TransferChecked");
        assert_eq!(profiles[2].instruction, "CloseAccount");
    }
}
