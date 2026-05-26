use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShieldedPool {
    pub pool_id: [u8; 32],
    pub asset_hash: [u8; 32],
    pub deposit_root: [u8; 32],
    pub deposit_count: u32,
    pub total_shielded: u64,
    pub mainnet_ready: bool,
    #[serde(skip)]
    note_ids: Vec<[u8; 32]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DepositNote {
    pub note_id: [u8; 32],
    pub shielder_hash: [u8; 32],
    pub amount: u64,
    pub nullifier_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum PoolError {
    ZeroAsset,
    ZeroShielderSecret,
    ZeroAmount,
    NullifierSpent,
    PoolEmpty,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn hex32(b: &[u8; 32]) -> String {
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

fn compute_asset_hash(asset_bytes: &[u8]) -> [u8; 32] {
    sha256_multi(&[b"pool-asset-v1", asset_bytes])
}

fn compute_pool_id(asset_hash: &[u8; 32], nonce: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"pool-id-v1", asset_hash, nonce])
}

fn compute_shielder_hash(shielder_secret: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"pool-shielder-v1", shielder_secret])
}

fn compute_note_id(
    pool_id: &[u8; 32],
    shielder_hash: &[u8; 32],
    amount: u64,
    nonce_note: &[u8; 32],
) -> [u8; 32] {
    sha256_multi(&[
        b"pool-note-v1",
        pool_id,
        shielder_hash,
        &amount.to_le_bytes(),
        nonce_note,
    ])
}

fn compute_deposit_root(note_ids: &[[u8; 32]], deposit_count: u32) -> [u8; 32] {
    let folded = xor_fold(note_ids);
    sha256_multi(&[b"pool-root-v1", &folded, &deposit_count.to_le_bytes()])
}

fn compute_nullifier_hash(note_id: &[u8; 32], shielder_hash: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"pool-null-v1", note_id, shielder_hash])
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn create_pool(asset_bytes: &[u8], nonce: &[u8; 32]) -> Result<ShieldedPool, PoolError> {
    if asset_bytes.is_empty() {
        return Err(PoolError::ZeroAsset);
    }
    let asset_hash = compute_asset_hash(asset_bytes);
    let pool_id = compute_pool_id(&asset_hash, nonce);
    let deposit_root = compute_deposit_root(&[], 0);
    Ok(ShieldedPool {
        pool_id,
        asset_hash,
        deposit_root,
        deposit_count: 0,
        total_shielded: 0,
        mainnet_ready: false,
        note_ids: Vec::new(),
    })
}

pub fn shield(
    pool: &mut ShieldedPool,
    shielder_secret: &[u8; 32],
    amount: u64,
    nonce_note: &[u8; 32],
) -> Result<DepositNote, PoolError> {
    if shielder_secret == &[0u8; 32] {
        return Err(PoolError::ZeroShielderSecret);
    }
    if amount == 0 {
        return Err(PoolError::ZeroAmount);
    }
    let shielder_hash = compute_shielder_hash(shielder_secret);
    let note_id = compute_note_id(&pool.pool_id, &shielder_hash, amount, nonce_note);
    let nullifier_hash = compute_nullifier_hash(&note_id, &shielder_hash);
    pool.note_ids.push(note_id);
    pool.deposit_count += 1;
    pool.total_shielded += amount;
    pool.deposit_root = compute_deposit_root(&pool.note_ids, pool.deposit_count);
    Ok(DepositNote {
        note_id,
        shielder_hash,
        amount,
        nullifier_hash,
        mainnet_ready: false,
    })
}

pub fn unshield(pool: &ShieldedPool, note: &DepositNote) -> Result<[u8; 32], PoolError> {
    if pool.deposit_count == 0 {
        return Err(PoolError::PoolEmpty);
    }
    Ok(note.nullifier_hash)
}

pub fn pool_public_record(pool: &ShieldedPool) -> String {
    serde_json::json!({
        "pool_id":        hex32(&pool.pool_id),
        "asset_hash":     hex32(&pool.asset_hash),
        "deposit_count":  pool.deposit_count,
        "total_shielded": pool.total_shielded,
        "mainnet_ready":  pool.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn secret(b: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = b;
        s
    }
    fn nonce(b: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = b;
        s
    }

    // Test 1: shield + unshield
    #[test]
    fn test_shield_and_unshield() {
        let mut pool = create_pool(b"usdc-mint", &nonce(0x01)).unwrap();
        let note = shield(&mut pool, &secret(0x11), 1000, &nonce(0x02)).unwrap();
        assert_eq!(pool.deposit_count, 1);
        assert_eq!(pool.total_shielded, 1000);
        assert!(!note.mainnet_ready);
        let nullifier = unshield(&pool, &note).unwrap();
        assert_eq!(nullifier, note.nullifier_hash);
    }

    // Test 2: zero shielder rejected
    #[test]
    fn test_zero_shielder_rejected() {
        let mut pool = create_pool(b"usdc-mint", &nonce(0x01)).unwrap();
        let err = shield(&mut pool, &[0u8; 32], 100, &nonce(0x02)).unwrap_err();
        assert_eq!(err, PoolError::ZeroShielderSecret);
    }

    // Test 3: zero amount rejected
    #[test]
    fn test_zero_amount_rejected() {
        let mut pool = create_pool(b"usdc-mint", &nonce(0x01)).unwrap();
        let err = shield(&mut pool, &secret(0x11), 0, &nonce(0x02)).unwrap_err();
        assert_eq!(err, PoolError::ZeroAmount);
    }

    // Test 4: deposit_root changes on shield
    #[test]
    fn test_deposit_root_changes_on_shield() {
        let mut pool = create_pool(b"usdc-mint", &nonce(0x01)).unwrap();
        let root_before = pool.deposit_root;
        shield(&mut pool, &secret(0x11), 500, &nonce(0x02)).unwrap();
        let root_after = pool.deposit_root;
        assert_ne!(root_before, root_after);
        let root_mid = root_after;
        shield(&mut pool, &secret(0x22), 300, &nonce(0x03)).unwrap();
        assert_ne!(root_mid, pool.deposit_root);
    }

    // Test 5: nullifier unique per note
    #[test]
    fn test_nullifier_unique_per_note() {
        let mut pool = create_pool(b"usdc-mint", &nonce(0x01)).unwrap();
        let note1 = shield(&mut pool, &secret(0x11), 100, &nonce(0x02)).unwrap();
        let note2 = shield(&mut pool, &secret(0x11), 100, &nonce(0x03)).unwrap();
        // Different nonce → different note_id → different nullifier
        assert_ne!(note1.note_id, note2.note_id);
        assert_ne!(note1.nullifier_hash, note2.nullifier_hash);
    }

    // Test 6: public record correct
    #[test]
    fn test_public_record_correct() {
        let mut pool = create_pool(b"sol-mint", &nonce(0x01)).unwrap();
        shield(&mut pool, &secret(0x11), 250, &nonce(0x02)).unwrap();
        let record = pool_public_record(&pool);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["pool_id"].is_string());
        assert!(v["asset_hash"].is_string());
        assert_eq!(v["deposit_count"], 1);
        assert_eq!(v["total_shielded"], 250);
        assert_eq!(v["mainnet_ready"], false);
    }
}
