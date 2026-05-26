use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpendingAccount {
    pub account_id: [u8; 32],
    pub cumulative_spend: u64,
    pub cap_lamports: u64,
    pub epoch: u64,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpendReceipt {
    pub account_id: [u8; 32],
    pub amount: u64,
    pub new_total: u64,
    pub receipt_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum SpendError {
    CapExceeded { cap: u64, attempted: u64 },
    ZeroAmount,
    AccountIdZero,
}

pub fn new_account(
    account_id: [u8; 32],
    cap_lamports: u64,
    epoch: u64,
) -> Result<SpendingAccount, SpendError> {
    if account_id == [0u8; 32] {
        return Err(SpendError::AccountIdZero);
    }
    Ok(SpendingAccount {
        account_id,
        cumulative_spend: 0,
        cap_lamports,
        epoch,
        mainnet_ready: false,
    })
}

pub fn record_spend(
    account: &mut SpendingAccount,
    amount: u64,
) -> Result<SpendReceipt, SpendError> {
    if amount == 0 {
        return Err(SpendError::ZeroAmount);
    }
    let new_total = account
        .cumulative_spend
        .checked_add(amount)
        .unwrap_or(u64::MAX);
    if new_total > account.cap_lamports {
        return Err(SpendError::CapExceeded {
            cap: account.cap_lamports,
            attempted: new_total,
        });
    }
    account.cumulative_spend = new_total;

    // receipt_hash = SHA256("spend-receipt-v1" || account_id || amount_le || new_total_le || epoch_le)
    let mut hasher = Sha256::new();
    hasher.update(b"spend-receipt-v1");
    hasher.update(account.account_id);
    hasher.update(amount.to_le_bytes());
    hasher.update(new_total.to_le_bytes());
    hasher.update(account.epoch.to_le_bytes());
    let receipt_hash: [u8; 32] = hasher.finalize().into();

    Ok(SpendReceipt {
        account_id: account.account_id,
        amount,
        new_total,
        receipt_hash,
        mainnet_ready: false,
    })
}

pub fn reset_epoch(account: &mut SpendingAccount, new_epoch: u64) {
    account.epoch = new_epoch;
    account.cumulative_spend = 0;
}

pub fn account_public_record(account: &SpendingAccount) -> String {
    let id_hex: String = account.account_id.iter().map(|b| format!("{:02x}", b)).collect();
    serde_json::json!({
        "account_id": id_hex,
        "cumulative_spend": account.cumulative_spend,
        "cap_lamports": account.cap_lamports,
        "epoch": account.epoch,
        "mainnet_ready": account.mainnet_ready,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_id() -> [u8; 32] {
        let mut id = [0u8; 32];
        id[0] = 0xAB;
        id[31] = 0xCD;
        id
    }

    #[test]
    fn test_record_spend_succeeds() {
        let mut acct = new_account(test_id(), 1_000_000, 1).unwrap();
        let receipt = record_spend(&mut acct, 500_000).unwrap();
        assert_eq!(receipt.amount, 500_000);
        assert_eq!(receipt.new_total, 500_000);
        assert_eq!(acct.cumulative_spend, 500_000);
        assert!(!receipt.mainnet_ready);
    }

    #[test]
    fn test_cap_exceeded_rejected() {
        let mut acct = new_account(test_id(), 100, 1).unwrap();
        let err = record_spend(&mut acct, 101).unwrap_err();
        assert_eq!(err, SpendError::CapExceeded { cap: 100, attempted: 101 });
    }

    #[test]
    fn test_zero_amount_rejected() {
        let mut acct = new_account(test_id(), 1_000, 1).unwrap();
        let err = record_spend(&mut acct, 0).unwrap_err();
        assert_eq!(err, SpendError::ZeroAmount);
    }

    #[test]
    fn test_reset_epoch_clears_spend() {
        let mut acct = new_account(test_id(), 1_000_000, 1).unwrap();
        record_spend(&mut acct, 500_000).unwrap();
        assert_eq!(acct.cumulative_spend, 500_000);
        reset_epoch(&mut acct, 2);
        assert_eq!(acct.cumulative_spend, 0);
        assert_eq!(acct.epoch, 2);
    }

    #[test]
    fn test_cumulative_tracking_multiple_spends() {
        let mut acct = new_account(test_id(), 1_000_000, 1).unwrap();
        record_spend(&mut acct, 100_000).unwrap();
        record_spend(&mut acct, 200_000).unwrap();
        record_spend(&mut acct, 300_000).unwrap();
        assert_eq!(acct.cumulative_spend, 600_000);
        // one more that would exceed should fail
        let err = record_spend(&mut acct, 500_000).unwrap_err();
        assert_eq!(err, SpendError::CapExceeded { cap: 1_000_000, attempted: 1_100_000 });
    }

    #[test]
    fn test_public_record_has_all_fields() {
        let acct = new_account(test_id(), 999, 7).unwrap();
        let json_str = account_public_record(&acct);
        let v: serde_json::Value = serde_json::from_str(&json_str).unwrap();
        assert!(v["account_id"].is_string());
        assert_eq!(v["cumulative_spend"], 0u64);
        assert_eq!(v["cap_lamports"], 999u64);
        assert_eq!(v["epoch"], 7u64);
        assert_eq!(v["mainnet_ready"], false);
        assert!(!v["mainnet_ready"].as_bool().unwrap());
    }
}
