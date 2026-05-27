use sha2::{Digest, Sha256};

pub struct TokenShieldLedger {
    pub ledger_id: [u8; 32],
    pub deposit_root: [u8; 32],
    pub nullifier_root: [u8; 32],
    pub deposit_count: u32,
    pub withdrawal_count: u32,
    pub denomination: u64,
    pub mainnet_ready: bool,
    deposit_ids: Vec<[u8; 32]>,
    nullifiers: Vec<[u8; 32]>,
}

#[derive(Debug)]
pub struct ShieldDeposit {
    pub deposit_id: [u8; 32],
    pub commitment: [u8; 32],
}

pub struct ShieldWithdrawal {
    pub withdrawal_id: [u8; 32],
    pub nullifier: [u8; 32],
}

#[derive(Debug, PartialEq)]
pub enum ShieldError {
    WrongDenomination,
    NullifierAlreadyUsed,
    ZeroSecret,
}

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn xor_fold(ids: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = [0u8; 32];
    for id in ids {
        for i in 0..32 {
            acc[i] ^= id[i];
        }
    }
    acc
}

pub fn new_shield_ledger(denomination: u64) -> TokenShieldLedger {
    let denom_le = denomination.to_le_bytes();
    let ledger_id = sha256_multi(&[b"shield-id-v1", &denom_le]);
    TokenShieldLedger {
        ledger_id,
        deposit_root: [0u8; 32],
        nullifier_root: [0u8; 32],
        deposit_count: 0,
        withdrawal_count: 0,
        denomination,
        mainnet_ready: false,
        deposit_ids: Vec::new(),
        nullifiers: Vec::new(),
    }
}

pub fn deposit(
    ledger: &mut TokenShieldLedger,
    depositor_secret: &[u8; 32],
    nonce: &[u8; 32],
    amount: u64,
) -> Result<ShieldDeposit, ShieldError> {
    if depositor_secret == &[0u8; 32] {
        return Err(ShieldError::ZeroSecret);
    }
    if amount != ledger.denomination {
        return Err(ShieldError::WrongDenomination);
    }
    let dep_hash = sha256_multi(&[b"shield-dep-v1", depositor_secret]);
    let commitment = sha256_multi(&[b"shield-commit-v1", &dep_hash, nonce]);
    let count_le = ledger.deposit_count.to_le_bytes();
    let deposit_id = sha256_multi(&[b"shield-did-v1", &commitment, &count_le]);

    ledger.deposit_ids.push(deposit_id);
    ledger.deposit_count += 1;
    let new_count_le = ledger.deposit_count.to_le_bytes();
    let folded = xor_fold(&ledger.deposit_ids);
    ledger.deposit_root = sha256_multi(&[b"shield-droot-v1", &folded, &new_count_le]);

    Ok(ShieldDeposit {
        deposit_id,
        commitment,
    })
}

pub fn withdraw(
    ledger: &mut TokenShieldLedger,
    depositor_secret: &[u8; 32],
) -> Result<ShieldWithdrawal, ShieldError> {
    let dep_hash = sha256_multi(&[b"shield-dep-v1", depositor_secret]);
    let nullifier = sha256_multi(&[b"shield-null-v1", &dep_hash, &ledger.ledger_id]);

    if ledger.nullifiers.contains(&nullifier) {
        return Err(ShieldError::NullifierAlreadyUsed);
    }

    let count_le = ledger.withdrawal_count.to_le_bytes();
    let withdrawal_id = sha256_multi(&[b"shield-wid-v1", &nullifier, &count_le]);

    ledger.nullifiers.push(nullifier);
    ledger.withdrawal_count += 1;
    let new_count_le = ledger.withdrawal_count.to_le_bytes();
    let folded = xor_fold(&ledger.nullifiers);
    ledger.nullifier_root = sha256_multi(&[b"shield-nroot-v1", &folded, &new_count_le]);

    Ok(ShieldWithdrawal {
        withdrawal_id,
        nullifier,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secret1() -> [u8; 32] {
        [0x01u8; 32]
    }
    fn nonce1() -> [u8; 32] {
        [0x02u8; 32]
    }

    #[test]
    fn new_shield_ledger_mainnet_ready_false() {
        let m = new_shield_ledger(1_000_000);
        assert_eq!(m.mainnet_ready, false);
        assert_ne!(m.ledger_id, [0u8; 32]);
        assert_eq!(m.deposit_count, 0);
        assert_eq!(m.denomination, 1_000_000);
    }

    #[test]
    fn deposit_succeeds() {
        let mut m = new_shield_ledger(1_000_000);
        let root_before = m.deposit_root;
        let d = deposit(&mut m, &secret1(), &nonce1(), 1_000_000).unwrap();
        assert_ne!(d.deposit_id, [0u8; 32]);
        assert_ne!(m.deposit_root, root_before);
        assert_eq!(m.deposit_count, 1);
    }

    #[test]
    fn wrong_denomination_rejected() {
        let mut m = new_shield_ledger(1_000_000);
        let result = deposit(&mut m, &secret1(), &nonce1(), 500_000);
        assert_eq!(result.err(), Some(ShieldError::WrongDenomination));
    }

    #[test]
    fn withdraw_succeeds() {
        let mut m = new_shield_ledger(1_000_000);
        deposit(&mut m, &secret1(), &nonce1(), 1_000_000).unwrap();
        let w = withdraw(&mut m, &secret1()).unwrap();
        assert_ne!(w.nullifier, [0u8; 32]);
        assert_ne!(w.withdrawal_id, [0u8; 32]);
        assert_eq!(m.withdrawal_count, 1);
    }

    #[test]
    fn double_withdraw_rejected() {
        let mut m = new_shield_ledger(1_000_000);
        deposit(&mut m, &secret1(), &nonce1(), 1_000_000).unwrap();
        withdraw(&mut m, &secret1()).unwrap();
        let result = withdraw(&mut m, &secret1());
        assert_eq!(result.err(), Some(ShieldError::NullifierAlreadyUsed));
    }

    #[test]
    fn mainnet_ready_false() {
        let m = new_shield_ledger(500_000);
        assert_eq!(m.mainnet_ready, false);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_deposit_root_changes_on_second_deposit() {
        let mut m = new_shield_ledger(1_000_000);
        deposit(&mut m, &secret1(), &nonce1(), 1_000_000).unwrap();
        let root1 = m.deposit_root;
        let s2 = [0x03u8; 32];
        let n2 = [0x04u8; 32];
        deposit(&mut m, &s2, &n2, 1_000_000).unwrap();
        assert_ne!(m.deposit_root, root1);
    }

    #[test]
    fn test_zero_depositor_secret_rejected() {
        let mut m = new_shield_ledger(1_000_000);
        let err = deposit(&mut m, &[0u8; 32], &nonce1(), 1_000_000).unwrap_err();
        assert_eq!(err, ShieldError::ZeroSecret);
    }

    #[test]
    fn test_nullifier_deterministic() {
        let mut m1 = new_shield_ledger(1_000_000);
        deposit(&mut m1, &secret1(), &nonce1(), 1_000_000).unwrap();
        let w1 = withdraw(&mut m1, &secret1()).unwrap();

        let mut m2 = new_shield_ledger(1_000_000);
        deposit(&mut m2, &secret1(), &nonce1(), 1_000_000).unwrap();
        let w2 = withdraw(&mut m2, &secret1()).unwrap();

        assert_eq!(w1.nullifier, w2.nullifier);
    }

    #[test]
    fn test_withdrawal_count_increments() {
        let mut m = new_shield_ledger(1_000_000);
        deposit(&mut m, &secret1(), &nonce1(), 1_000_000).unwrap();
        withdraw(&mut m, &secret1()).unwrap();
        assert_eq!(m.withdrawal_count, 1);
        let s2 = [0x05u8; 32];
        deposit(&mut m, &s2, &nonce1(), 1_000_000).unwrap();
        withdraw(&mut m, &s2).unwrap();
        assert_eq!(m.withdrawal_count, 2);
    }

    #[test]
    fn test_different_secrets_different_nullifiers() {
        let mut m = new_shield_ledger(1_000_000);
        let s2 = [0x06u8; 32];
        deposit(&mut m, &secret1(), &nonce1(), 1_000_000).unwrap();
        let w1 = withdraw(&mut m, &secret1()).unwrap();
        deposit(&mut m, &s2, &nonce1(), 1_000_000).unwrap();
        let w2 = withdraw(&mut m, &s2).unwrap();
        assert_ne!(w1.nullifier, w2.nullifier);
    }

    #[test]
    fn test_deposit_commitment_depends_on_nonce() {
        let mut m1 = new_shield_ledger(1_000_000);
        let mut m2 = new_shield_ledger(1_000_000);
        let n2 = [0xFFu8; 32];
        let d1 = deposit(&mut m1, &secret1(), &nonce1(), 1_000_000).unwrap();
        let d2 = deposit(&mut m2, &secret1(), &n2, 1_000_000).unwrap();
        assert_ne!(d1.commitment, d2.commitment);
    }

    #[test]
    fn test_deposit_count_increments() {
        let mut m = new_shield_ledger(1_000_000);
        assert_eq!(m.deposit_count, 0);
        deposit(&mut m, &secret1(), &nonce1(), 1_000_000).unwrap();
        assert_eq!(m.deposit_count, 1);
    }

    #[test]
    fn test_ledger_id_deterministic() {
        let m1 = new_shield_ledger(1_000_000);
        let m2 = new_shield_ledger(1_000_000);
        assert_eq!(m1.ledger_id, m2.ledger_id);
    }

    #[test]
    fn test_nullifier_root_changes_after_withdrawal() {
        let mut m = new_shield_ledger(1_000_000);
        let root_before = m.nullifier_root;
        deposit(&mut m, &secret1(), &nonce1(), 1_000_000).unwrap();
        withdraw(&mut m, &secret1()).unwrap();
        assert_ne!(m.nullifier_root, root_before);
    }

    #[test]
    fn test_deposit_id_not_zero() {
        let mut m = new_shield_ledger(1_000_000);
        let d = deposit(&mut m, &secret1(), &nonce1(), 1_000_000).unwrap();
        assert_ne!(d.deposit_id, [0u8; 32]);
    }
}
