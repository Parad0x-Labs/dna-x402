use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct VaultDeposit {
    /// SHA256("vault-deposit-v1" || amount_le || secret || deposited_at_le)
    pub vault_id: [u8; 32],
    /// SHA256("vault-commit-v1" || amount_le || secret)
    pub amount_commitment: [u8; 32],
    pub lock_until_unix: i64,
    pub deposited_at_unix: i64,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone)]
pub struct VaultWithdrawal {
    pub vault_id: [u8; 32],
    pub amount: u64,
    pub withdrawn_at_unix: i64,
    /// SHA256("vault-withdraw-v1" || vault_id || amount_le || current_unix_le)
    pub withdrawal_proof: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum VaultError {
    TooEarlyToWithdraw { unlock_at: i64, current: i64 },
    CommitmentMismatch,
    ZeroAmount,
}

fn hash_amount_commitment(amount: u64, secret: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"vault-commit-v1");
    h.update(amount.to_le_bytes());
    h.update(secret);
    h.finalize().into()
}

pub fn create_deposit(
    amount: u64,
    secret: &[u8; 32],
    deposited_at_unix: i64,
    lock_until_unix: i64,
) -> Result<VaultDeposit, VaultError> {
    if amount == 0 {
        return Err(VaultError::ZeroAmount);
    }

    let mut vault_hasher = Sha256::new();
    vault_hasher.update(b"vault-deposit-v1");
    vault_hasher.update(amount.to_le_bytes());
    vault_hasher.update(secret);
    vault_hasher.update(deposited_at_unix.to_le_bytes());
    let vault_id: [u8; 32] = vault_hasher.finalize().into();

    let amount_commitment = hash_amount_commitment(amount, secret);

    Ok(VaultDeposit {
        vault_id,
        amount_commitment,
        lock_until_unix,
        deposited_at_unix,
        mainnet_ready: false,
    })
}

pub fn withdraw_vault(
    deposit: &VaultDeposit,
    amount: u64,
    secret: &[u8; 32],
    current_unix: i64,
) -> Result<VaultWithdrawal, VaultError> {
    if current_unix < deposit.lock_until_unix {
        return Err(VaultError::TooEarlyToWithdraw {
            unlock_at: deposit.lock_until_unix,
            current: current_unix,
        });
    }

    let computed_commitment = hash_amount_commitment(amount, secret);
    if computed_commitment != deposit.amount_commitment {
        return Err(VaultError::CommitmentMismatch);
    }

    let mut proof_hasher = Sha256::new();
    proof_hasher.update(b"vault-withdraw-v1");
    proof_hasher.update(deposit.vault_id);
    proof_hasher.update(amount.to_le_bytes());
    proof_hasher.update(current_unix.to_le_bytes());
    let withdrawal_proof: [u8; 32] = proof_hasher.finalize().into();

    Ok(VaultWithdrawal {
        vault_id: deposit.vault_id,
        amount,
        withdrawn_at_unix: current_unix,
        withdrawal_proof,
        mainnet_ready: false,
    })
}

pub fn vault_public_record(deposit: &VaultDeposit) -> String {
    let vault_id_hex = deposit
        .vault_id
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>();

    serde_json::json!({
        "vault_id": vault_id_hex,
        "lock_until_unix": deposit.lock_until_unix,
        "deposited_at_unix": deposit.deposited_at_unix,
        "mainnet_ready": deposit.mainnet_ready,
    })
    .to_string()
}

pub fn verify_withdrawal(deposit: &VaultDeposit, withdrawal: &VaultWithdrawal) -> bool {
    if deposit.vault_id != withdrawal.vault_id {
        return false;
    }

    let mut proof_hasher = Sha256::new();
    proof_hasher.update(b"vault-withdraw-v1");
    proof_hasher.update(withdrawal.vault_id);
    proof_hasher.update(withdrawal.amount.to_le_bytes());
    proof_hasher.update(withdrawal.withdrawn_at_unix.to_le_bytes());
    let expected_proof: [u8; 32] = proof_hasher.finalize().into();

    expected_proof == withdrawal.withdrawal_proof
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_secret(byte: u8) -> [u8; 32] {
        [byte; 32]
    }

    #[test]
    fn test_deposit_and_withdraw_happy_path() {
        let secret = make_secret(0xAB);
        let deposit = create_deposit(1_000_000, &secret, 1_000_000, 2_000_000).unwrap();
        assert!(!deposit.mainnet_ready);

        let withdrawal = withdraw_vault(&deposit, 1_000_000, &secret, 2_000_000).unwrap();
        assert_eq!(withdrawal.vault_id, deposit.vault_id);
        assert_eq!(withdrawal.amount, 1_000_000);
        assert_eq!(withdrawal.withdrawn_at_unix, 2_000_000);
        assert!(!withdrawal.mainnet_ready);
    }

    #[test]
    fn test_too_early_rejected() {
        let secret = make_secret(0x11);
        let deposit = create_deposit(500, &secret, 1_000, 5_000).unwrap();

        let err = withdraw_vault(&deposit, 500, &secret, 4_999).unwrap_err();
        assert_eq!(
            err,
            VaultError::TooEarlyToWithdraw {
                unlock_at: 5_000,
                current: 4_999,
            }
        );
    }

    #[test]
    fn test_wrong_secret_fails_withdrawal() {
        let secret = make_secret(0x22);
        let wrong_secret = make_secret(0x99);
        let deposit = create_deposit(100, &secret, 0, 0).unwrap();

        let err = withdraw_vault(&deposit, 100, &wrong_secret, 0).unwrap_err();
        assert_eq!(err, VaultError::CommitmentMismatch);
    }

    #[test]
    fn test_zero_amount_rejected() {
        let secret = make_secret(0x00);
        let err = create_deposit(0, &secret, 0, 0).unwrap_err();
        assert_eq!(err, VaultError::ZeroAmount);
    }

    #[test]
    fn test_public_record_hides_amount() {
        let secret = make_secret(0x77);
        let amount: u64 = 9_999_888;
        let deposit = create_deposit(amount, &secret, 100, 200).unwrap();

        let record = vault_public_record(&deposit);
        // The amount must not appear as a plain number string in the JSON output
        assert!(!record.contains(&amount.to_string()));
        // Sanity: the record should contain the vault_id key
        assert!(record.contains("vault_id"));
        assert!(record.contains("lock_until_unix"));
        assert!(record.contains("deposited_at_unix"));
        assert!(record.contains("mainnet_ready"));
    }

    #[test]
    fn test_verify_withdrawal_passes() {
        let secret = make_secret(0x55);
        let deposit = create_deposit(42_000, &secret, 10_000, 20_000).unwrap();
        let withdrawal = withdraw_vault(&deposit, 42_000, &secret, 20_000).unwrap();

        assert!(verify_withdrawal(&deposit, &withdrawal));
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_mainnet_ready_always_false() {
        let d = create_deposit(100, &make_secret(0x01), 0, 0).unwrap();
        assert!(!d.mainnet_ready);
        let w = withdraw_vault(&d, 100, &make_secret(0x01), 0).unwrap();
        assert!(!w.mainnet_ready);
    }

    #[test]
    fn test_vault_id_deterministic() {
        let s = make_secret(0x02);
        let d1 = create_deposit(500, &s, 1000, 2000).unwrap();
        let d2 = create_deposit(500, &s, 1000, 2000).unwrap();
        assert_eq!(d1.vault_id, d2.vault_id);
    }

    #[test]
    fn test_vault_id_sensitive_to_secret() {
        let d1 = create_deposit(500, &make_secret(0x03), 1000, 2000).unwrap();
        let d2 = create_deposit(500, &make_secret(0x04), 1000, 2000).unwrap();
        assert_ne!(d1.vault_id, d2.vault_id);
    }

    #[test]
    fn test_withdraw_at_exact_lock_time_succeeds() {
        let secret = make_secret(0x05);
        let deposit = create_deposit(1000, &secret, 0, 5000).unwrap();
        let w = withdraw_vault(&deposit, 1000, &secret, 5000).unwrap();
        assert_eq!(w.withdrawn_at_unix, 5000);
    }

    #[test]
    fn test_withdrawal_proof_deterministic() {
        let secret = make_secret(0x06);
        let d = create_deposit(200, &secret, 0, 0).unwrap();
        let w1 = withdraw_vault(&d, 200, &secret, 100).unwrap();
        let w2 = withdraw_vault(&d, 200, &secret, 100).unwrap();
        assert_eq!(w1.withdrawal_proof, w2.withdrawal_proof);
    }

    #[test]
    fn test_withdrawal_proof_sensitive_to_amount() {
        let secret = make_secret(0x07);
        let d1 = create_deposit(300, &secret, 0, 0).unwrap();
        let d2 = create_deposit(400, &secret, 0, 0).unwrap();
        let w1 = withdraw_vault(&d1, 300, &secret, 0).unwrap();
        let w2 = withdraw_vault(&d2, 400, &secret, 0).unwrap();
        assert_ne!(w1.withdrawal_proof, w2.withdrawal_proof);
    }

    #[test]
    fn test_commitment_changes_with_secret() {
        let d1 = create_deposit(100, &make_secret(0x08), 0, 0).unwrap();
        let d2 = create_deposit(100, &make_secret(0x09), 0, 0).unwrap();
        assert_ne!(d1.amount_commitment, d2.amount_commitment);
    }

    #[test]
    fn test_lock_until_stored() {
        let d = create_deposit(100, &make_secret(0x0A), 0, 99999).unwrap();
        assert_eq!(d.lock_until_unix, 99999);
    }

    #[test]
    fn test_deposited_at_stored() {
        let d = create_deposit(100, &make_secret(0x0B), 12345, 99999).unwrap();
        assert_eq!(d.deposited_at_unix, 12345);
    }

    #[test]
    fn test_different_amounts_different_commitments() {
        let s = make_secret(0x0C);
        let d1 = create_deposit(100, &s, 0, 0).unwrap();
        let d2 = create_deposit(200, &s, 0, 0).unwrap();
        assert_ne!(d1.amount_commitment, d2.amount_commitment);
    }
}
