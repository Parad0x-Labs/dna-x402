use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MixNote {
    pub commitment: [u8; 32],
    pub amount: u64,
    pub asset_tag: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MixPool {
    pub pool_root: [u8; 32],
    pub note_count: u32,
    pub total_committed: u64,
    pub nullifiers: Vec<[u8; 32]>,
    pub commitments: Vec<[u8; 32]>,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum MixError {
    ZeroAmount,
    NullifierAlreadySpent,
    CommitmentNotFound,
    AssetTagMismatch,
}

fn sha256_hash(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

fn make_asset_tag(asset_id: &[u8]) -> [u8; 32] {
    let mut input = b"asset-tag-v1".to_vec();
    input.extend_from_slice(asset_id);
    sha256_hash(&input)
}

fn make_commitment(secret: &[u8; 32], amount: u64, asset_tag: &[u8; 32]) -> [u8; 32] {
    let mut input = b"mix-note-v1".to_vec();
    input.extend_from_slice(&amount.to_le_bytes());
    input.extend_from_slice(asset_tag);
    input.extend_from_slice(secret);
    sha256_hash(&input)
}

pub fn create_mix_note(
    secret: &[u8; 32],
    amount: u64,
    asset_id: &[u8],
) -> Result<MixNote, MixError> {
    if amount == 0 {
        return Err(MixError::ZeroAmount);
    }
    let asset_tag = make_asset_tag(asset_id);
    let commitment = make_commitment(secret, amount, &asset_tag);
    Ok(MixNote {
        commitment,
        amount,
        asset_tag,
        mainnet_ready: false,
    })
}

pub fn new_mix_pool() -> MixPool {
    MixPool {
        pool_root: [0u8; 32],
        note_count: 0,
        total_committed: 0,
        nullifiers: Vec::new(),
        commitments: Vec::new(),
        mainnet_ready: false,
    }
}

pub fn deposit_note(pool: &mut MixPool, note: &MixNote) {
    // XOR commitment into pool root
    for (r, c) in pool.pool_root.iter_mut().zip(note.commitment.iter()) {
        *r ^= c;
    }
    pool.commitments.push(note.commitment);
    pool.note_count += 1;
    pool.total_committed = pool.total_committed.saturating_add(note.amount);
}

pub fn withdraw_note(
    pool: &mut MixPool,
    note: &MixNote,
    secret: &[u8; 32],
) -> Result<[u8; 32], MixError> {
    // Check commitment exists in pool
    let pos = pool
        .commitments
        .iter()
        .position(|c| *c == note.commitment)
        .ok_or(MixError::CommitmentNotFound)?;

    // Verify recomputed commitment matches
    let recomputed = make_commitment(secret, note.amount, &note.asset_tag);
    if recomputed != note.commitment {
        return Err(MixError::CommitmentNotFound);
    }

    // Compute nullifier
    let mut null_input = b"mix-null-v1".to_vec();
    null_input.extend_from_slice(&note.commitment);
    null_input.extend_from_slice(&pool.pool_root);
    let nullifier: [u8; 32] = sha256_hash(&null_input);

    // Check nullifier not already spent
    if pool.nullifiers.contains(&nullifier) {
        return Err(MixError::NullifierAlreadySpent);
    }

    pool.nullifiers.push(nullifier);
    pool.commitments.remove(pos);
    pool.note_count = pool.note_count.saturating_sub(1);
    pool.total_committed = pool.total_committed.saturating_sub(note.amount);
    // XOR the commitment back out of pool_root to reflect the withdrawal
    // NOTE: pool_root is snapshotted *before* we modify it so nullifier is stable
    for (r, c) in pool.pool_root.iter_mut().zip(note.commitment.iter()) {
        *r ^= c;
    }

    Ok(nullifier)
}

pub fn pool_public_record(pool: &MixPool) -> String {
    let root_hex = hex_encode(&pool.pool_root);
    serde_json::json!({
        "pool_root": root_hex,
        "note_count": pool.note_count,
        "mainnet_ready": pool.mainnet_ready,
    })
    .to_string()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secret(seed: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = seed;
        s[1] = 0xab;
        s
    }

    #[test]
    fn test_deposit_and_withdraw() {
        let note = create_mix_note(&secret(1), 100, b"SOL").unwrap();
        assert!(!note.mainnet_ready);
        let mut pool = new_mix_pool();
        deposit_note(&mut pool, &note);
        assert_eq!(pool.note_count, 1);
        let nullifier = withdraw_note(&mut pool, &note, &secret(1)).unwrap();
        assert_ne!(nullifier, [0u8; 32]);
        assert_eq!(pool.note_count, 0);
    }

    #[test]
    fn test_double_spend_rejected() {
        let note = create_mix_note(&secret(2), 200, b"USDC").unwrap();
        let mut pool = new_mix_pool();
        deposit_note(&mut pool, &note);
        withdraw_note(&mut pool, &note, &secret(2)).unwrap();

        // Re-deposit to simulate same nullifier scenario
        deposit_note(&mut pool, &note);
        // Nullifier already in pool.nullifiers so should be rejected
        let err = withdraw_note(&mut pool, &note, &secret(2)).unwrap_err();
        assert_eq!(err, MixError::NullifierAlreadySpent);
    }

    #[test]
    fn test_commitment_not_in_pool_rejected() {
        let note = create_mix_note(&secret(3), 50, b"BTC").unwrap();
        let mut pool = new_mix_pool();
        // Do NOT deposit — try to withdraw directly
        let err = withdraw_note(&mut pool, &note, &secret(3)).unwrap_err();
        assert_eq!(err, MixError::CommitmentNotFound);
    }

    #[test]
    fn test_zero_amount_rejected() {
        let err = create_mix_note(&secret(4), 0, b"SOL").unwrap_err();
        assert_eq!(err, MixError::ZeroAmount);
    }

    #[test]
    fn test_pool_root_changes_on_deposit() {
        let mut pool = new_mix_pool();
        let root_before = pool.pool_root;
        let note = create_mix_note(&secret(5), 300, b"SOL").unwrap();
        deposit_note(&mut pool, &note);
        assert_ne!(pool.pool_root, root_before);
    }

    #[test]
    fn test_public_record_hides_total() {
        let note = create_mix_note(&secret(6), 999_000, b"SOL").unwrap();
        let mut pool = new_mix_pool();
        deposit_note(&mut pool, &note);
        let record: serde_json::Value =
            serde_json::from_str(&pool_public_record(&pool)).unwrap();
        // total_committed must NOT appear
        assert!(record.get("total_committed").is_none());
        assert_eq!(record["note_count"], 1);
        assert!(!record["mainnet_ready"].as_bool().unwrap());
    }
}
