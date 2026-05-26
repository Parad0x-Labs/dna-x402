use sha2::{Digest, Sha256};

pub struct TokenMixer {
    pub mixer_id: [u8; 32],
    pub deposit_root: [u8; 32],
    pub nullifier_root: [u8; 32],
    pub deposit_count: u32,
    pub withdrawal_count: u32,
    pub denomination: u64,
    pub mainnet_ready: bool,
    deposit_ids: Vec<[u8; 32]>,
    nullifiers: Vec<[u8; 32]>,
}

pub struct MixerDeposit {
    pub deposit_id: [u8; 32],
    pub commitment: [u8; 32],
}

pub struct MixerWithdrawal {
    pub withdrawal_id: [u8; 32],
    pub nullifier: [u8; 32],
}

#[derive(Debug, PartialEq)]
pub enum MixerError {
    WrongDenomination,
    NullifierAlreadyUsed,
    ZeroSecret,
}

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts { h.update(p); }
    h.finalize().into()
}

fn xor_fold(ids: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = [0u8; 32];
    for id in ids {
        for i in 0..32 { acc[i] ^= id[i]; }
    }
    acc
}

pub fn new_mixer(denomination: u64) -> TokenMixer {
    let denom_le = denomination.to_le_bytes();
    let mixer_id = sha256_multi(&[b"mixer-id-v1", &denom_le]);
    TokenMixer {
        mixer_id,
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
    mixer: &mut TokenMixer,
    depositor_secret: &[u8; 32],
    nonce: &[u8; 32],
    amount: u64,
) -> Result<MixerDeposit, MixerError> {
    if depositor_secret == &[0u8; 32] {
        return Err(MixerError::ZeroSecret);
    }
    if amount != mixer.denomination {
        return Err(MixerError::WrongDenomination);
    }
    let dep_hash = sha256_multi(&[b"mixer-dep-v1", depositor_secret]);
    let commitment = sha256_multi(&[b"mixer-commit-v1", &dep_hash, nonce]);
    let count_le = mixer.deposit_count.to_le_bytes();
    let deposit_id = sha256_multi(&[b"mixer-did-v1", &commitment, &count_le]);

    mixer.deposit_ids.push(deposit_id);
    mixer.deposit_count += 1;
    let new_count_le = mixer.deposit_count.to_le_bytes();
    let folded = xor_fold(&mixer.deposit_ids);
    mixer.deposit_root = sha256_multi(&[b"mixer-droot-v1", &folded, &new_count_le]);

    Ok(MixerDeposit { deposit_id, commitment })
}

pub fn withdraw(
    mixer: &mut TokenMixer,
    depositor_secret: &[u8; 32],
) -> Result<MixerWithdrawal, MixerError> {
    let dep_hash = sha256_multi(&[b"mixer-dep-v1", depositor_secret]);
    let nullifier = sha256_multi(&[b"mixer-null-v1", &dep_hash, &mixer.mixer_id]);

    if mixer.nullifiers.contains(&nullifier) {
        return Err(MixerError::NullifierAlreadyUsed);
    }

    let count_le = mixer.withdrawal_count.to_le_bytes();
    let withdrawal_id = sha256_multi(&[b"mixer-wid-v1", &nullifier, &count_le]);

    mixer.nullifiers.push(nullifier);
    mixer.withdrawal_count += 1;
    let new_count_le = mixer.withdrawal_count.to_le_bytes();
    let folded = xor_fold(&mixer.nullifiers);
    mixer.nullifier_root = sha256_multi(&[b"mixer-nroot-v1", &folded, &new_count_le]);

    Ok(MixerWithdrawal { withdrawal_id, nullifier })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secret1() -> [u8; 32] { [0x01u8; 32] }
    fn nonce1() -> [u8; 32] { [0x02u8; 32] }

    #[test]
    fn new_mixer_mainnet_ready_false() {
        let m = new_mixer(1_000_000);
        assert_eq!(m.mainnet_ready, false);
        assert_ne!(m.mixer_id, [0u8; 32]);
        assert_eq!(m.deposit_count, 0);
        assert_eq!(m.denomination, 1_000_000);
    }

    #[test]
    fn deposit_succeeds() {
        let mut m = new_mixer(1_000_000);
        let root_before = m.deposit_root;
        let d = deposit(&mut m, &secret1(), &nonce1(), 1_000_000).unwrap();
        assert_ne!(d.deposit_id, [0u8; 32]);
        assert_ne!(m.deposit_root, root_before);
        assert_eq!(m.deposit_count, 1);
    }

    #[test]
    fn wrong_denomination_rejected() {
        let mut m = new_mixer(1_000_000);
        let result = deposit(&mut m, &secret1(), &nonce1(), 500_000);
        assert_eq!(result.err(), Some(MixerError::WrongDenomination));
    }

    #[test]
    fn withdraw_succeeds() {
        let mut m = new_mixer(1_000_000);
        deposit(&mut m, &secret1(), &nonce1(), 1_000_000).unwrap();
        let w = withdraw(&mut m, &secret1()).unwrap();
        assert_ne!(w.nullifier, [0u8; 32]);
        assert_ne!(w.withdrawal_id, [0u8; 32]);
        assert_eq!(m.withdrawal_count, 1);
    }

    #[test]
    fn double_withdraw_rejected() {
        let mut m = new_mixer(1_000_000);
        deposit(&mut m, &secret1(), &nonce1(), 1_000_000).unwrap();
        withdraw(&mut m, &secret1()).unwrap();
        let result = withdraw(&mut m, &secret1());
        assert_eq!(result.err(), Some(MixerError::NullifierAlreadyUsed));
    }

    #[test]
    fn mainnet_ready_false() {
        let m = new_mixer(500_000);
        assert_eq!(m.mainnet_ready, false);
    }
}
