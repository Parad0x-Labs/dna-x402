//! dark-meme-risk — Private Memecoin Risk Oracle
//!
//! User pays x402, submits tokenHash = SHA256(token_mint),
//! receives private risk score. Token identity stays hashed in receipt.
//!
//! Research basis: MemeTrans (arXiv:2602.13480) — 41,470 pump.fun tokens,
//! 122 risk features, 21.4% wash trade rate.
//!
//! Daily use case: Before aping, pay 0.005 SOL, get risk score privately.
//! Public receipt log: tokenHash + riskBand only. No one knows you checked.
//!
//! NOT_PRODUCTION — oracle logic uses mock/simulated on-chain data.
//! Real production requires Helius RPC integration + live account queries.
//! Not audited. mainnet_ready = false.

use sha2::{Digest, Sha256};
use thiserror::Error;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RiskBand {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone)]
pub struct RiskSignal {
    pub name: String,
    pub weight: u8,
    pub value: f32,
    pub triggered: bool,
}

#[derive(Debug, Clone)]
pub struct RiskReport {
    pub score: u8,
    pub risk_band: RiskBand,
    pub signals: Vec<RiskSignal>,
    pub token_hash: [u8; 32],
    pub epoch_slot: u64,
    pub score_hash: [u8; 32],
}

/// Public receipt — MUST NOT contain raw token_mint.
#[derive(Debug, Clone)]
pub struct RiskReceipt {
    pub token_hash: [u8; 32],
    pub score_hash: [u8; 32],
    pub risk_band: RiskBand,
    pub epoch_slot: u64,
    pub x402_receipt_hash: [u8; 32],
    pub receipt_hash: [u8; 32],
}

#[derive(Debug, Clone)]
pub struct MockOnChainData {
    /// Percentage of supply held by dev wallet (0.0–100.0)
    pub dev_wallet_concentration_pct: f32,
    /// Number of bundle snipe transactions detected
    pub bundle_snipe_count: u32,
    /// Average age in days of early holder wallets
    pub early_holder_wallet_age_days: f32,
    /// Number of detected wash trade loops
    pub wash_trade_loop_count: u32,
    /// Unique buyers in first 100 blocks
    pub unique_buyers_first_100_blocks: u32,
    /// LP pool concentration (single provider %, 0.0–100.0)
    pub lp_concentration_pct: f32,
}

#[derive(Debug, Error)]
pub enum MemeRiskError {
    #[error("raw token mint leaked into public output")]
    RawTokenLeaked,
    #[error("invalid token hash")]
    InvalidTokenHash,
    #[error("invalid score: {0}")]
    InvalidScore(u8),
    #[error("receipt hash mismatch")]
    ReceiptHashMismatch,
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/// Normalizes a concentration percentage to 0.0–1.0.
fn norm_pct(v: f32) -> f32 {
    (v / 100.0).clamp(0.0, 1.0)
}

/// Normalizes a count by a max cap to 0.0–1.0.
fn norm_count(v: u32, cap: u32) -> f32 {
    ((v as f32) / (cap as f32)).clamp(0.0, 1.0)
}

/// Computes risk score (0–100) from on-chain signals.
///
/// Weights:
///   dev_wallet_concentration : 25
///   bundle_snipe_density     : 25
///   wash_trade               : 30
///   lp_concentration         : 20
pub fn compute_risk_score(data: &MockOnChainData) -> u8 {
    let dev_signal = norm_pct(data.dev_wallet_concentration_pct);
    let bundle_signal = norm_count(data.bundle_snipe_count, 20);
    let wash_signal = norm_count(data.wash_trade_loop_count, 10);
    let lp_signal = norm_pct(data.lp_concentration_pct);

    let raw = dev_signal * 25.0 + bundle_signal * 25.0 + wash_signal * 30.0 + lp_signal * 20.0;
    raw.round().clamp(0.0, 100.0) as u8
}

/// Maps score to risk band: 0–25=Low, 26–50=Medium, 51–75=High, 76–100=Critical.
pub fn score_to_risk_band(score: u8) -> RiskBand {
    match score {
        0..=25 => RiskBand::Low,
        26..=50 => RiskBand::Medium,
        51..=75 => RiskBand::High,
        _ => RiskBand::Critical,
    }
}

/// Builds a full risk report.
/// score_hash = SHA256("dark-null-risk-v1" || token_hash || [score] || epoch_slot.le)
pub fn build_risk_report(
    token_hash: &[u8; 32],
    data: &MockOnChainData,
    epoch_slot: u64,
) -> RiskReport {
    let score = compute_risk_score(data);
    let risk_band = score_to_risk_band(score);

    let mut hasher = Sha256::new();
    hasher.update(b"dark-null-risk-v1");
    hasher.update(token_hash);
    hasher.update([score]);
    hasher.update(epoch_slot.to_le_bytes());
    let score_hash: [u8; 32] = hasher.finalize().into();

    let signals = vec![
        RiskSignal {
            name: "dev_wallet_concentration".to_string(),
            weight: 25,
            value: data.dev_wallet_concentration_pct,
            triggered: data.dev_wallet_concentration_pct > 20.0,
        },
        RiskSignal {
            name: "bundle_snipe_density".to_string(),
            weight: 25,
            value: data.bundle_snipe_count as f32,
            triggered: data.bundle_snipe_count > 3,
        },
        RiskSignal {
            name: "wash_trade_loops".to_string(),
            weight: 30,
            value: data.wash_trade_loop_count as f32,
            triggered: data.wash_trade_loop_count > 0,
        },
        RiskSignal {
            name: "lp_concentration".to_string(),
            weight: 20,
            value: data.lp_concentration_pct,
            triggered: data.lp_concentration_pct > 50.0,
        },
        RiskSignal {
            name: "early_holder_wallet_age".to_string(),
            weight: 0,
            value: data.early_holder_wallet_age_days,
            triggered: data.early_holder_wallet_age_days < 7.0,
        },
        RiskSignal {
            name: "unique_buyers_first_100_blocks".to_string(),
            weight: 0,
            value: data.unique_buyers_first_100_blocks as f32,
            triggered: data.unique_buyers_first_100_blocks < 10,
        },
    ];

    RiskReport {
        score,
        risk_band,
        signals,
        token_hash: *token_hash,
        epoch_slot,
        score_hash,
    }
}

/// Creates a private receipt. Does NOT contain raw token_mint.
/// receipt_hash = SHA256("dark-null-risk-receipt-v1" || token_hash || score_hash || x402_receipt_hash || epoch_slot.le)
pub fn create_risk_receipt(report: &RiskReport, x402_receipt_hash: &[u8; 32]) -> RiskReceipt {
    let mut hasher = Sha256::new();
    hasher.update(b"dark-null-risk-receipt-v1");
    hasher.update(report.token_hash);
    hasher.update(report.score_hash);
    hasher.update(x402_receipt_hash);
    hasher.update(report.epoch_slot.to_le_bytes());
    let receipt_hash: [u8; 32] = hasher.finalize().into();

    RiskReceipt {
        token_hash: report.token_hash,
        score_hash: report.score_hash,
        risk_band: report.risk_band.clone(),
        epoch_slot: report.epoch_slot,
        x402_receipt_hash: *x402_receipt_hash,
        receipt_hash,
    }
}

/// Verifies receipt integrity — recomputes receipt_hash and checks it matches.
pub fn verify_risk_receipt(receipt: &RiskReceipt) -> Result<(), MemeRiskError> {
    let mut hasher = Sha256::new();
    hasher.update(b"dark-null-risk-receipt-v1");
    hasher.update(receipt.token_hash);
    hasher.update(receipt.score_hash);
    hasher.update(receipt.x402_receipt_hash);
    hasher.update(receipt.epoch_slot.to_le_bytes());
    let expected: [u8; 32] = hasher.finalize().into();
    if expected == receipt.receipt_hash {
        Ok(())
    } else {
        Err(MemeRiskError::ReceiptHashMismatch)
    }
}

/// Checks that no raw token mint bytes appear in the receipt JSON (safety check).
/// Encodes token_mint_bytes as a hex string and searches for it.
pub fn assert_no_raw_token(
    receipt_json: &str,
    token_mint_bytes: &[u8; 32],
) -> Result<(), MemeRiskError> {
    let hex_str: String = token_mint_bytes
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    if receipt_json.contains(&hex_str) {
        return Err(MemeRiskError::RawTokenLeaked);
    }
    // Also check upper-case hex
    let hex_upper: String = token_mint_bytes
        .iter()
        .map(|b| format!("{:02X}", b))
        .collect();
    if receipt_json.contains(&hex_upper) {
        return Err(MemeRiskError::RawTokenLeaked);
    }
    Ok(())
}

/// Generates deterministic mock on-chain data from a token hash.
pub fn mock_on_chain_data_from_hash(token_hash: &[u8; 32]) -> MockOnChainData {
    // Use bytes from the hash to seed all fields deterministically.
    let dev_pct = (token_hash[0] as f32 / 255.0) * 80.0; // 0–80%
    let bundle_count = (token_hash[1] % 25) as u32;
    let wallet_age = (token_hash[2] as f32 / 255.0) * 365.0; // 0–365 days
    let wash_loops = (token_hash[3] % 12) as u32;
    let unique_buyers = ((token_hash[4] as u32) % 200) + 1;
    let lp_pct = (token_hash[5] as f32 / 255.0) * 95.0; // 0–95%
    MockOnChainData {
        dev_wallet_concentration_pct: dev_pct,
        bundle_snipe_count: bundle_count,
        early_holder_wallet_age_days: wallet_age,
        wash_trade_loop_count: wash_loops,
        unique_buyers_first_100_blocks: unique_buyers,
        lp_concentration_pct: lp_pct,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn clean_data() -> MockOnChainData {
        MockOnChainData {
            dev_wallet_concentration_pct: 2.0,
            bundle_snipe_count: 0,
            early_holder_wallet_age_days: 180.0,
            wash_trade_loop_count: 0,
            unique_buyers_first_100_blocks: 150,
            lp_concentration_pct: 5.0,
        }
    }

    fn concentrated_dev_data() -> MockOnChainData {
        MockOnChainData {
            dev_wallet_concentration_pct: 99.0,
            bundle_snipe_count: 20,
            early_holder_wallet_age_days: 1.0,
            wash_trade_loop_count: 10,
            unique_buyers_first_100_blocks: 2,
            lp_concentration_pct: 90.0,
        }
    }

    fn dummy_hash(seed: u8) -> [u8; 32] {
        let mut h = [0u8; 32];
        h[0] = seed;
        h[1] = 0xde;
        h
    }

    #[test]
    fn test_risk_score_low_for_clean_token() {
        let score = compute_risk_score(&clean_data());
        assert!(score <= 25, "expected Low band but got score {}", score);
    }

    #[test]
    fn test_risk_score_critical_for_concentrated_dev() {
        let score = compute_risk_score(&concentrated_dev_data());
        assert!(
            score >= 76,
            "expected Critical band but got score {}",
            score
        );
    }

    #[test]
    fn test_risk_band_boundaries() {
        assert_eq!(score_to_risk_band(0), RiskBand::Low);
        assert_eq!(score_to_risk_band(25), RiskBand::Low);
        assert_eq!(score_to_risk_band(26), RiskBand::Medium);
        assert_eq!(score_to_risk_band(50), RiskBand::Medium);
        assert_eq!(score_to_risk_band(51), RiskBand::High);
        assert_eq!(score_to_risk_band(75), RiskBand::High);
        assert_eq!(score_to_risk_band(76), RiskBand::Critical);
        assert_eq!(score_to_risk_band(100), RiskBand::Critical);
    }

    #[test]
    fn test_report_score_hash_deterministic() {
        let th = dummy_hash(10);
        let data = clean_data();
        let r1 = build_risk_report(&th, &data, 9999);
        let r2 = build_risk_report(&th, &data, 9999);
        assert_eq!(r1.score_hash, r2.score_hash);
        assert_eq!(r1.score, r2.score);
    }

    #[test]
    fn test_receipt_hash_deterministic() {
        let th = dummy_hash(11);
        let xh = dummy_hash(12);
        let report = build_risk_report(&th, &clean_data(), 1000);
        let rec1 = create_risk_receipt(&report, &xh);
        let rec2 = create_risk_receipt(&report, &xh);
        assert_eq!(rec1.receipt_hash, rec2.receipt_hash);
    }

    #[test]
    fn test_receipt_integrity_valid() {
        let th = dummy_hash(13);
        let xh = dummy_hash(14);
        let report = build_risk_report(&th, &clean_data(), 2000);
        let receipt = create_risk_receipt(&report, &xh);
        assert!(verify_risk_receipt(&receipt).is_ok());
    }

    #[test]
    fn test_receipt_no_raw_token_mint() {
        let token_mint: [u8; 32] = {
            let mut m = [0u8; 32];
            for (i, b) in m.iter_mut().enumerate() {
                *b = (i as u8).wrapping_add(0x42);
            }
            m
        };
        // Derive token_hash from mint
        let mut hasher = sha2::Sha256::new();
        hasher.update(token_mint);
        let token_hash: [u8; 32] = hasher.finalize().into();

        let xh = dummy_hash(20);
        let report = build_risk_report(&token_hash, &clean_data(), 3000);
        let receipt = create_risk_receipt(&report, &xh);

        // Serialize receipt fields to JSON manually (no raw token_mint should appear)
        let token_hash_hex: String = receipt
            .token_hash
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();
        let score_hash_hex: String = receipt
            .score_hash
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();
        let json = serde_json::json!({
            "token_hash": token_hash_hex,
            "score_hash": score_hash_hex,
            "epoch_slot": receipt.epoch_slot,
        });
        let json_str = json.to_string();

        // Ensure raw token_mint hex does not appear
        let result = assert_no_raw_token(&json_str, &token_mint);
        assert!(
            result.is_ok(),
            "raw token mint should not appear in receipt JSON"
        );
    }

    #[test]
    fn test_mock_data_deterministic() {
        let th = dummy_hash(30);
        let d1 = mock_on_chain_data_from_hash(&th);
        let d2 = mock_on_chain_data_from_hash(&th);
        assert_eq!(
            d1.dev_wallet_concentration_pct,
            d2.dev_wallet_concentration_pct
        );
        assert_eq!(d1.bundle_snipe_count, d2.bundle_snipe_count);
        assert_eq!(d1.wash_trade_loop_count, d2.wash_trade_loop_count);
    }

    #[test]
    fn test_risk_report_signals_populated() {
        let th = dummy_hash(40);
        let report = build_risk_report(&th, &clean_data(), 5000);
        assert!(report.signals.len() >= 4, "expected at least 4 signals");
    }

    #[test]
    fn test_high_wash_trade_triggers_high_score() {
        let data = MockOnChainData {
            dev_wallet_concentration_pct: 5.0,
            bundle_snipe_count: 0,
            early_holder_wallet_age_days: 200.0,
            wash_trade_loop_count: 10, // max
            unique_buyers_first_100_blocks: 100,
            lp_concentration_pct: 5.0,
        };
        let score = compute_risk_score(&data);
        // wash_trade at max (1.0) * 30 = 30, plus small dev/lp contributions
        assert!(
            score >= 30,
            "high wash trade should raise score above 30, got {}",
            score
        );
        let band = score_to_risk_band(score);
        assert!(
            band == RiskBand::Medium || band == RiskBand::High || band == RiskBand::Critical,
            "expected at least Medium band"
        );
    }
}
