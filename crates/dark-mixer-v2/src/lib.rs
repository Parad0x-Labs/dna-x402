use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Constants ──────────────────────────────────────────────────────────────

pub const VALID_DENOMINATIONS: [u64; 5] = [
    1_000_000_000,
    10_000_000_000,
    100_000_000_000,
    1_000_000_000_000,
    10_000_000_000_000,
];

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShieldPool {
    pub pool_id: [u8; 32],
    pub denomination: u64,
    pub pool_root: [u8; 32],
    pub deposit_count: u32,
    pub version: u32,
    pub mainnet_ready: bool,
    /// Internal: all commitments deposited so far.
    #[serde(skip)]
    pub(crate) commitments: Vec<[u8; 32]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShieldNote {
    pub commitment: [u8; 32],
    pub nullifier_hash: [u8; 32],
    pub denomination: u64,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum ShieldError {
    InvalidDenomination,
    NullifierAlreadySpent,
    PoolEmpty,
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

fn compute_pool_root(commitments: &[[u8; 32]], deposit_count: u32) -> [u8; 32] {
    let xor = xor_fold(commitments);
    let mut d = Vec::new();
    d.extend_from_slice(b"shield-v2-root-v1");
    d.extend_from_slice(&xor);
    d.extend_from_slice(&deposit_count.to_le_bytes());
    sha256(&d)
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn create_pool(denomination: u64, version: u32) -> Result<ShieldPool, ShieldError> {
    if !VALID_DENOMINATIONS.contains(&denomination) {
        return Err(ShieldError::InvalidDenomination);
    }

    // pool_id = SHA256("shield-v2-pool-v1" || denomination_le || version_le)
    let pool_id = {
        let mut d = Vec::new();
        d.extend_from_slice(b"shield-v2-pool-v1");
        d.extend_from_slice(&denomination.to_le_bytes());
        d.extend_from_slice(&version.to_le_bytes());
        sha256(&d)
    };

    // initial pool_root with zero commitments
    let pool_root = compute_pool_root(&[], 0);

    Ok(ShieldPool {
        pool_id,
        denomination,
        pool_root,
        deposit_count: 0,
        version,
        mainnet_ready: false,
        commitments: Vec::new(),
    })
}

pub fn deposit(pool: &mut ShieldPool, secret: &[u8; 32]) -> ShieldNote {
    // commitment = SHA256("shield-v2-commit-v1" || denomination_le || secret)
    let commitment = {
        let mut d = Vec::new();
        d.extend_from_slice(b"shield-v2-commit-v1");
        d.extend_from_slice(&pool.denomination.to_le_bytes());
        d.extend_from_slice(secret);
        sha256(&d)
    };

    pool.commitments.push(commitment);
    pool.deposit_count += 1;
    pool.pool_root = compute_pool_root(&pool.commitments, pool.deposit_count);

    // nullifier_hash = SHA256("shield-v2-null-v1" || commitment || pool_root)
    let nullifier_hash = {
        let mut d = Vec::new();
        d.extend_from_slice(b"shield-v2-null-v1");
        d.extend_from_slice(&commitment);
        d.extend_from_slice(&pool.pool_root);
        sha256(&d)
    };

    ShieldNote {
        commitment,
        nullifier_hash,
        denomination: pool.denomination,
        mainnet_ready: false,
    }
}

pub fn withdraw(pool: &ShieldPool, note: &ShieldNote) -> Result<[u8; 32], ShieldError> {
    if pool.deposit_count == 0 {
        return Err(ShieldError::PoolEmpty);
    }
    Ok(note.nullifier_hash)
}

pub fn pool_public_record(pool: &ShieldPool) -> String {
    serde_json::json!({
        "pool_id": hex(&pool.pool_id),
        "denomination": pool.denomination,
        "pool_root": hex(&pool.pool_root),
        "deposit_count": pool.deposit_count,
        "version": pool.version,
        "mainnet_ready": pool.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn secret_a() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xAA;
        s
    }
    fn secret_b() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xBB;
        s
    }

    // Test 1: deposit + withdraw happy path
    #[test]
    fn test_deposit_withdraw_happy() {
        let mut pool = create_pool(1_000_000_000, 1).unwrap();
        assert!(!pool.mainnet_ready);
        let note = deposit(&mut pool, &secret_a());
        assert!(!note.mainnet_ready);
        let nullifier = withdraw(&pool, &note).unwrap();
        assert_eq!(nullifier, note.nullifier_hash);
    }

    // Test 2: invalid denomination rejected
    #[test]
    fn test_invalid_denomination_rejected() {
        let err = create_pool(999_999, 1).unwrap_err();
        assert_eq!(err, ShieldError::InvalidDenomination);
    }

    // Test 3: nullifier unique per pool root (depositing changes pool root,
    //         so a second deposit produces a different nullifier even with same secret)
    #[test]
    fn test_nullifier_unique_per_pool_root() {
        let mut pool = create_pool(10_000_000_000, 1).unwrap();
        let note1 = deposit(&mut pool, &secret_a());
        // Capture root after first deposit
        let root_after_1 = pool.pool_root;
        let note2 = deposit(&mut pool, &secret_a()); // same secret, different root
        assert_ne!(pool.pool_root, root_after_1);
        assert_ne!(note1.nullifier_hash, note2.nullifier_hash);
    }

    // Test 4: pool root changes on deposit
    #[test]
    fn test_pool_root_changes_on_deposit() {
        let mut pool = create_pool(100_000_000_000, 1).unwrap();
        let root_before = pool.pool_root;
        deposit(&mut pool, &secret_a());
        assert_ne!(pool.pool_root, root_before);
    }

    // Test 5: two notes from different secrets → different commitments
    #[test]
    fn test_different_secrets_different_commitments() {
        let mut pool = create_pool(1_000_000_000_000, 1).unwrap();
        let note_a = deposit(&mut pool, &secret_a());
        // Reset pool to compare on same root
        let mut pool2 = create_pool(1_000_000_000_000, 1).unwrap();
        let note_b = deposit(&mut pool2, &secret_b());
        assert_ne!(note_a.commitment, note_b.commitment);
    }

    // Test 6: public record has correct fields and mainnet_ready=false
    #[test]
    fn test_pool_public_record_fields() {
        let pool = create_pool(10_000_000_000_000, 2).unwrap();
        let record = pool_public_record(&pool);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["pool_id"].is_string());
        assert_eq!(v["denomination"], 10_000_000_000_000u64);
        assert_eq!(v["version"], 2u32);
        assert_eq!(v["mainnet_ready"], false);
    }
}
