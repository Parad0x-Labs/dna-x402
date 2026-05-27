use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Constants ──────────────────────────────────────────────────────────────

pub const MAX_VALIDATORS: usize = 128;

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidatorSet {
    pub set_id: [u8; 32],
    pub validator_root: [u8; 32],
    pub quorum: u8,
    pub active_count: u32,
    pub epoch: u64,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Validator {
    pub validator_hash: [u8; 32],
    pub stake_commitment: [u8; 32],
    pub active: bool,
}

#[derive(Debug, PartialEq)]
pub enum ValidatorError {
    ZeroOperatorSecret,
    QuorumZero,
    QuorumExceedsMax,
    EpochMismatch,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

fn hex(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn xor_fold(hashes: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = [0u8; 32];
    for h in hashes {
        for i in 0..32 {
            acc[i] ^= h[i];
        }
    }
    acc
}

fn compute_validator_hash(operator_secret: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"vset-validator-v1");
    d.extend_from_slice(operator_secret);
    sha256(&d)
}

fn compute_stake_commitment(validator_hash: &[u8; 32], stake: u64) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"vset-stake-v1");
    d.extend_from_slice(validator_hash);
    d.extend_from_slice(&stake.to_le_bytes());
    sha256(&d)
}

fn compute_validator_root(
    validator_hashes: &[[u8; 32]],
    active_count: u32,
    epoch: u64,
) -> [u8; 32] {
    let xored = xor_fold(validator_hashes);
    let mut d = Vec::new();
    d.extend_from_slice(b"vset-root-v1");
    d.extend_from_slice(&xored);
    d.extend_from_slice(&active_count.to_le_bytes());
    d.extend_from_slice(&epoch.to_le_bytes());
    sha256(&d)
}

fn compute_set_id(validator_root: &[u8; 32], quorum: u8, epoch: u64) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"vset-id-v1");
    d.extend_from_slice(validator_root);
    d.push(quorum);
    d.extend_from_slice(&epoch.to_le_bytes());
    sha256(&d)
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn create_set(
    operator_secrets: &[[u8; 32]],
    stakes: &[u64],
    quorum: u8,
    epoch: u64,
) -> Result<(ValidatorSet, Vec<Validator>), ValidatorError> {
    for secret in operator_secrets {
        if secret == &[0u8; 32] {
            return Err(ValidatorError::ZeroOperatorSecret);
        }
    }
    if quorum == 0 {
        return Err(ValidatorError::QuorumZero);
    }
    let count = operator_secrets.len() as u32;
    if quorum as u32 > count {
        return Err(ValidatorError::QuorumExceedsMax);
    }

    let mut validators = Vec::new();
    let mut validator_hashes = Vec::new();

    for (i, secret) in operator_secrets.iter().enumerate() {
        let validator_hash = compute_validator_hash(secret);
        let stake = stakes.get(i).copied().unwrap_or(0);
        let stake_commitment = compute_stake_commitment(&validator_hash, stake);
        validator_hashes.push(validator_hash);
        validators.push(Validator {
            validator_hash,
            stake_commitment,
            active: true,
        });
    }

    let validator_root = compute_validator_root(&validator_hashes, count, epoch);
    let set_id = compute_set_id(&validator_root, quorum, epoch);

    Ok((
        ValidatorSet {
            set_id,
            validator_root,
            quorum,
            active_count: count,
            epoch,
            mainnet_ready: false,
        },
        validators,
    ))
}

pub fn rotate_epoch(
    set: &mut ValidatorSet,
    validator_hashes: &[[u8; 32]],
    new_epoch: u64,
) -> Result<(), ValidatorError> {
    if new_epoch <= set.epoch {
        return Err(ValidatorError::EpochMismatch);
    }
    set.epoch = new_epoch;
    set.validator_root = compute_validator_root(validator_hashes, set.active_count, new_epoch);
    set.set_id = compute_set_id(&set.validator_root, set.quorum, new_epoch);
    Ok(())
}

pub fn set_public_record(set: &ValidatorSet) -> String {
    serde_json::json!({
        "set_id":         hex(&set.set_id),
        "validator_root": hex(&set.validator_root),
        "quorum":         set.quorum,
        "active_count":   set.active_count,
        "epoch":          set.epoch,
        "mainnet_ready":  set.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn secret(byte: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = byte;
        s
    }

    // Test 1: create set successfully
    #[test]
    fn test_create_set() {
        let secrets = [secret(0x11), secret(0x22), secret(0x33)];
        let stakes = [1000u64, 2000, 3000];
        let (set, validators) = create_set(&secrets, &stakes, 2, 1).unwrap();
        assert_eq!(set.active_count, 3);
        assert_eq!(set.quorum, 2);
        assert_eq!(set.epoch, 1);
        assert!(!set.mainnet_ready);
        assert_eq!(validators.len(), 3);
        for v in &validators {
            assert!(v.active);
        }
    }

    // Test 2: rotate epoch
    #[test]
    fn test_rotate_epoch() {
        let secrets = [secret(0x11), secret(0x22)];
        let stakes = [100u64, 200];
        let (mut set, validators) = create_set(&secrets, &stakes, 1, 1).unwrap();
        let old_set_id = set.set_id;
        let hashes: Vec<[u8; 32]> = validators.iter().map(|v| v.validator_hash).collect();
        rotate_epoch(&mut set, &hashes, 2).unwrap();
        assert_eq!(set.epoch, 2);
        assert_ne!(set.set_id, old_set_id);
    }

    // Test 3: quorum zero rejected
    #[test]
    fn test_quorum_zero_rejected() {
        let secrets = [secret(0x11)];
        let err = create_set(&secrets, &[100], 0, 1).unwrap_err();
        assert_eq!(err, ValidatorError::QuorumZero);
    }

    // Test 4: quorum exceeds validator count rejected
    #[test]
    fn test_quorum_exceeds_max_rejected() {
        let secrets = [secret(0x11), secret(0x22)];
        let err = create_set(&secrets, &[100, 200], 3, 1).unwrap_err();
        assert_eq!(err, ValidatorError::QuorumExceedsMax);
    }

    // Test 5: validator_root changes on epoch rotation
    #[test]
    fn test_validator_root_changes_on_epoch_rotation() {
        let secrets = [secret(0x11), secret(0x22)];
        let stakes = [100u64, 200];
        let (mut set, validators) = create_set(&secrets, &stakes, 1, 1).unwrap();
        let old_root = set.validator_root;
        let hashes: Vec<[u8; 32]> = validators.iter().map(|v| v.validator_hash).collect();
        rotate_epoch(&mut set, &hashes, 5).unwrap();
        assert_ne!(set.validator_root, old_root);
    }

    // Test 6: public record correct
    #[test]
    fn test_public_record_correct() {
        let secrets = [secret(0x11), secret(0x22)];
        let stakes = [100u64, 200];
        let (set, _) = create_set(&secrets, &stakes, 2, 1).unwrap();
        let record = set_public_record(&set);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["set_id"].is_string());
        assert!(v["validator_root"].is_string());
        assert_eq!(v["quorum"], 2);
        assert_eq!(v["active_count"], 2);
        assert_eq!(v["epoch"], 1);
        assert_eq!(v["mainnet_ready"], false);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_set_id_nonzero() {
        let (set, _) = create_set(&[secret(0x11)], &[100], 1, 1).unwrap();
        assert_ne!(set.set_id, [0u8; 32]);
    }

    #[test]
    fn test_validator_root_nonzero() {
        let (set, _) = create_set(&[secret(0x22)], &[200], 1, 1).unwrap();
        assert_ne!(set.validator_root, [0u8; 32]);
    }

    #[test]
    fn test_validator_hash_nonzero() {
        let (_, validators) = create_set(&[secret(0x33)], &[300], 1, 1).unwrap();
        assert_ne!(validators[0].validator_hash, [0u8; 32]);
    }

    #[test]
    fn test_stake_commitment_nonzero() {
        let (_, validators) = create_set(&[secret(0x44)], &[400], 1, 1).unwrap();
        assert_ne!(validators[0].stake_commitment, [0u8; 32]);
    }

    #[test]
    fn test_mainnet_ready_false() {
        let (set, _) = create_set(&[secret(0x55)], &[500], 1, 1).unwrap();
        assert!(!set.mainnet_ready);
    }

    #[test]
    fn test_zero_operator_secret_rejected() {
        let secrets = [[0u8; 32]];
        let err = create_set(&secrets, &[100], 1, 1).unwrap_err();
        assert_eq!(err, ValidatorError::ZeroOperatorSecret);
    }

    #[test]
    fn test_epoch_rotation_must_advance() {
        let (mut set, _) = create_set(&[secret(0x66)], &[100], 1, 5).unwrap();
        // Same epoch → EpochMismatch
        let err = rotate_epoch(&mut set, &[], 5).unwrap_err();
        assert_eq!(err, ValidatorError::EpochMismatch);
        // Lower epoch → EpochMismatch
        let err2 = rotate_epoch(&mut set, &[], 3).unwrap_err();
        assert_eq!(err2, ValidatorError::EpochMismatch);
    }

    #[test]
    fn test_active_validators_all_true() {
        let secrets = [secret(0x77), secret(0x88), secret(0x99)];
        let (_, validators) = create_set(&secrets, &[100, 200, 300], 2, 1).unwrap();
        assert!(validators.iter().all(|v| v.active));
    }

    #[test]
    fn test_max_validators_constant() {
        assert_eq!(MAX_VALIDATORS, 128);
    }

    #[test]
    fn test_set_id_epoch_sensitive() {
        let (set1, _) = create_set(&[secret(0xAA)], &[100], 1, 10).unwrap();
        let (set2, _) = create_set(&[secret(0xAA)], &[100], 1, 20).unwrap();
        assert_ne!(set1.set_id, set2.set_id);
    }
}
