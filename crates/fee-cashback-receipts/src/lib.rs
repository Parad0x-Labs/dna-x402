use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeeCashbackReceipt {
    pub receipt_id: [u8; 32],
    pub user_hash: [u8; 32],
    pub original_fee_estimate: u64,
    pub actual_fee: u64,
    pub savings_lamports: u64,
    pub protocol_cut_lamports: u64,
    pub cashback_lamports: u64,
    pub route_hash: [u8; 32],
    pub slot: u64,
}

#[derive(Debug, PartialEq)]
pub enum CashbackError {
    NegativeSavings,
    CashbackExceedsSavings,
    ProtocolCutExceedsSavings,
}

pub fn compute_savings(original_estimate: u64, actual_fee: u64) -> Result<u64, CashbackError> {
    if actual_fee >= original_estimate {
        return Err(CashbackError::NegativeSavings);
    }
    Ok(original_estimate - actual_fee)
}

pub fn split_savings(
    savings: u64,
    protocol_bps: u64,
    cashback_bps: u64,
) -> Result<(u64, u64), CashbackError> {
    if protocol_bps + cashback_bps > 10_000 {
        return Err(CashbackError::CashbackExceedsSavings);
    }
    let protocol_cut = savings * protocol_bps / 10_000;
    let cashback = savings * cashback_bps / 10_000;
    Ok((protocol_cut, cashback))
}

pub fn mint_cashback_receipt(
    user_hash: [u8; 32],
    original: u64,
    actual: u64,
    route_hash: [u8; 32],
    protocol_bps: u64,
    cashback_bps: u64,
    slot: u64,
) -> Result<FeeCashbackReceipt, CashbackError> {
    let savings = compute_savings(original, actual)?;
    let (protocol_cut, cashback) = split_savings(savings, protocol_bps, cashback_bps)?;

    let mut h = Sha256::new();
    h.update(b"fee_cashback_receipt_v1");
    h.update(user_hash);
    h.update(savings.to_le_bytes());
    h.update(route_hash);
    let receipt_id: [u8; 32] = h.finalize().into();

    Ok(FeeCashbackReceipt {
        receipt_id,
        user_hash,
        original_fee_estimate: original,
        actual_fee: actual,
        savings_lamports: savings,
        protocol_cut_lamports: protocol_cut,
        cashback_lamports: cashback,
        route_hash,
        slot,
    })
}

pub fn aggregate_cashback_epoch(receipts: &[FeeCashbackReceipt]) -> [u8; 32] {
    let mut h = Sha256::new();
    for r in receipts {
        h.update(r.receipt_id);
    }
    h.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user() -> [u8; 32] {
        [0x11u8; 32]
    }
    fn route() -> [u8; 32] {
        [0x22u8; 32]
    }

    #[test]
    fn test_negative_savings_rejected() {
        assert_eq!(
            compute_savings(1000, 1000),
            Err(CashbackError::NegativeSavings)
        );
        assert_eq!(
            compute_savings(500, 1000),
            Err(CashbackError::NegativeSavings)
        );
    }

    #[test]
    fn test_cashback_bounded_by_savings() {
        // protocol_bps + cashback_bps > 10000 should error
        assert_eq!(
            split_savings(1000, 6000, 5000),
            Err(CashbackError::CashbackExceedsSavings)
        );
        // valid case
        let (protocol, cashback) = split_savings(10_000, 500, 2000).unwrap();
        assert!(protocol + cashback <= 10_000);
    }

    #[test]
    fn test_protocol_cut_bounded() {
        let (protocol_cut, _cashback) = split_savings(10_000, 500, 2000).unwrap();
        assert_eq!(protocol_cut, 500); // 5% of 10000
        assert!(protocol_cut <= 10_000);
    }

    #[test]
    fn test_receipt_hash_deterministic() {
        let r1 = mint_cashback_receipt(user(), 10_000, 6_000, route(), 500, 2000, 100).unwrap();
        let r2 = mint_cashback_receipt(user(), 10_000, 6_000, route(), 500, 2000, 100).unwrap();
        assert_eq!(r1.receipt_id, r2.receipt_id);
    }

    #[test]
    fn test_epoch_aggregate_deterministic() {
        let r1 = mint_cashback_receipt(user(), 10_000, 6_000, route(), 500, 2000, 100).unwrap();
        let r2 = mint_cashback_receipt(user(), 8_000, 5_000, route(), 500, 2000, 200).unwrap();
        let agg1 = aggregate_cashback_epoch(&[r1.clone(), r2.clone()]);
        let agg2 = aggregate_cashback_epoch(&[r1, r2]);
        assert_eq!(agg1, agg2);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_savings_computed_correctly() {
        assert_eq!(compute_savings(10_000, 6_000).unwrap(), 4_000);
    }

    #[test]
    fn test_mint_receipt_savings_nonzero() {
        let r = mint_cashback_receipt(user(), 10_000, 6_000, route(), 500, 2000, 1).unwrap();
        assert!(r.savings_lamports > 0);
    }

    #[test]
    fn test_mint_receipt_id_nonzero() {
        let r = mint_cashback_receipt(user(), 10_000, 6_000, route(), 500, 2000, 1).unwrap();
        assert_ne!(r.receipt_id, [0u8; 32]);
    }

    #[test]
    fn test_split_savings_at_boundary_10000_bps_ok() {
        // exactly 10_000 total bps is allowed (condition is >, not >=)
        let result = split_savings(10_000, 5_000, 5_000);
        assert!(result.is_ok());
    }

    #[test]
    fn test_split_savings_protocol_at_full() {
        // 100% → protocol_cut == savings
        let (protocol_cut, cashback) = split_savings(10_000, 10_000, 0).unwrap();
        assert_eq!(protocol_cut, 10_000);
        assert_eq!(cashback, 0);
    }

    #[test]
    fn test_cashback_preserves_user_hash() {
        let u = user();
        let r = mint_cashback_receipt(u, 10_000, 6_000, route(), 500, 2000, 1).unwrap();
        assert_eq!(r.user_hash, u);
    }

    #[test]
    fn test_cashback_preserves_slot() {
        let r = mint_cashback_receipt(user(), 10_000, 6_000, route(), 500, 2000, 777).unwrap();
        assert_eq!(r.slot, 777);
    }

    #[test]
    fn test_cashback_actual_fee_matches() {
        let r = mint_cashback_receipt(user(), 10_000, 4_000, route(), 500, 2000, 1).unwrap();
        assert_eq!(r.actual_fee, 4_000);
    }

    #[test]
    fn test_aggregate_epoch_nonzero() {
        let r = mint_cashback_receipt(user(), 10_000, 6_000, route(), 500, 2000, 1).unwrap();
        let agg = aggregate_cashback_epoch(&[r]);
        assert_ne!(agg, [0u8; 32]);
    }

    #[test]
    fn test_aggregate_order_sensitive() {
        let r1 = mint_cashback_receipt(user(), 10_000, 6_000, route(), 500, 2000, 1).unwrap();
        let r2 = mint_cashback_receipt(user(), 8_000, 5_000, route(), 500, 2000, 2).unwrap();
        let agg_12 = aggregate_cashback_epoch(&[r1.clone(), r2.clone()]);
        let agg_21 = aggregate_cashback_epoch(&[r2, r1]);
        assert_ne!(
            agg_12, agg_21,
            "different order must produce different aggregate"
        );
    }

    #[test]
    fn test_cashback_route_hash_matches() {
        let r_hash = route();
        let r = mint_cashback_receipt(user(), 10_000, 6_000, r_hash, 500, 2000, 1).unwrap();
        assert_eq!(r.route_hash, r_hash);
    }
}
