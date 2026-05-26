use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrossChainLock {
    pub lock_id: [u8; 32],
    pub locker_hash: [u8; 32],
    pub target_chain_hash: [u8; 32],
    pub asset_hash: [u8; 32],
    pub amount: u64,
    pub unlock_secret_hash: [u8; 32],
    pub released: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnlockProof {
    pub lock_id: [u8; 32],
    pub unlock_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum LockError {
    ZeroLockerSecret,
    ZeroAmount,
    EmptyTargetChain,
    EmptyAsset,
    AlreadyReleased,
    WrongUnlockSecret,
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

fn compute_locker_hash(secret: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"ccl-locker-v1");
    d.extend_from_slice(secret);
    sha256(&d)
}

fn compute_target_chain_hash(chain_bytes: &[u8]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"ccl-chain-v1");
    d.extend_from_slice(chain_bytes);
    sha256(&d)
}

fn compute_asset_hash(asset_bytes: &[u8]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"ccl-asset-v1");
    d.extend_from_slice(asset_bytes);
    sha256(&d)
}

fn compute_unlock_secret_hash(unlock_secret: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"ccl-unlock-v1");
    d.extend_from_slice(unlock_secret);
    sha256(&d)
}

fn compute_lock_id(
    locker_hash: &[u8; 32],
    target_chain_hash: &[u8; 32],
    asset_hash: &[u8; 32],
    amount: u64,
    unlock_secret_hash: &[u8; 32],
    nonce: &[u8; 32],
) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"ccl-lock-v1");
    d.extend_from_slice(locker_hash);
    d.extend_from_slice(target_chain_hash);
    d.extend_from_slice(asset_hash);
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(unlock_secret_hash);
    d.extend_from_slice(nonce);
    sha256(&d)
}

fn compute_unlock_hash(lock_id: &[u8; 32], unlock_secret_hash: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"ccl-proof-v1");
    d.extend_from_slice(lock_id);
    d.extend_from_slice(unlock_secret_hash);
    sha256(&d)
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn create_lock(
    locker_secret: &[u8; 32],
    target_chain: &[u8],
    asset_bytes: &[u8],
    amount: u64,
    unlock_secret: &[u8; 32],
    nonce: &[u8; 32],
) -> Result<CrossChainLock, LockError> {
    if locker_secret == &[0u8; 32] {
        return Err(LockError::ZeroLockerSecret);
    }
    if amount == 0 {
        return Err(LockError::ZeroAmount);
    }
    if target_chain.is_empty() {
        return Err(LockError::EmptyTargetChain);
    }
    if asset_bytes.is_empty() {
        return Err(LockError::EmptyAsset);
    }
    let locker_hash = compute_locker_hash(locker_secret);
    let target_chain_hash = compute_target_chain_hash(target_chain);
    let asset_hash = compute_asset_hash(asset_bytes);
    let unlock_secret_hash = compute_unlock_secret_hash(unlock_secret);
    let lock_id = compute_lock_id(
        &locker_hash,
        &target_chain_hash,
        &asset_hash,
        amount,
        &unlock_secret_hash,
        nonce,
    );
    Ok(CrossChainLock {
        lock_id,
        locker_hash,
        target_chain_hash,
        asset_hash,
        amount,
        unlock_secret_hash,
        released: false,
        mainnet_ready: false,
    })
}

pub fn unlock(
    lock: &mut CrossChainLock,
    unlock_secret: &[u8; 32],
) -> Result<UnlockProof, LockError> {
    if lock.released {
        return Err(LockError::AlreadyReleased);
    }
    let ush = compute_unlock_secret_hash(unlock_secret);
    if ush != lock.unlock_secret_hash {
        return Err(LockError::WrongUnlockSecret);
    }
    lock.released = true;
    let unlock_hash = compute_unlock_hash(&lock.lock_id, &lock.unlock_secret_hash);
    Ok(UnlockProof {
        lock_id: lock.lock_id,
        unlock_hash,
        mainnet_ready: false,
    })
}

pub fn lock_public_record(lock: &CrossChainLock) -> String {
    serde_json::json!({
        "lock_id": hex(&lock.lock_id),
        "target_chain_hash": hex(&lock.target_chain_hash),
        "asset_hash": hex(&lock.asset_hash),
        "amount": lock.amount,
        "released": lock.released,
        "mainnet_ready": lock.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn locker() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xab;
        s
    }
    fn unlock_secret() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xcd;
        s
    }
    fn nonce() -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = 0x01;
        n
    }

    // Test 1: create + unlock happy path
    #[test]
    fn test_create_and_unlock() {
        let mut lock = create_lock(
            &locker(),
            b"ethereum",
            b"USDC",
            1000,
            &unlock_secret(),
            &nonce(),
        )
        .unwrap();
        assert!(!lock.released);
        assert!(!lock.mainnet_ready);
        let proof = unlock(&mut lock, &unlock_secret()).unwrap();
        assert_eq!(proof.lock_id, lock.lock_id);
        assert!(lock.released);
        assert!(!proof.mainnet_ready);
    }

    // Test 2: wrong secret rejected
    #[test]
    fn test_wrong_secret_rejected() {
        let mut lock = create_lock(
            &locker(),
            b"ethereum",
            b"USDC",
            1000,
            &unlock_secret(),
            &nonce(),
        )
        .unwrap();
        let mut wrong = [0u8; 32];
        wrong[0] = 0xff;
        let err = unlock(&mut lock, &wrong).unwrap_err();
        assert_eq!(err, LockError::WrongUnlockSecret);
    }

    // Test 3: already released rejected
    #[test]
    fn test_already_released_rejected() {
        let mut lock = create_lock(
            &locker(),
            b"solana",
            b"SOL",
            500,
            &unlock_secret(),
            &nonce(),
        )
        .unwrap();
        unlock(&mut lock, &unlock_secret()).unwrap();
        let err = unlock(&mut lock, &unlock_secret()).unwrap_err();
        assert_eq!(err, LockError::AlreadyReleased);
    }

    // Test 4: zero locker secret rejected
    #[test]
    fn test_zero_locker_rejected() {
        let err = create_lock(
            &[0u8; 32],
            b"ethereum",
            b"ETH",
            100,
            &unlock_secret(),
            &nonce(),
        )
        .unwrap_err();
        assert_eq!(err, LockError::ZeroLockerSecret);
    }

    // Test 5: zero amount rejected
    #[test]
    fn test_zero_amount_rejected() {
        let err = create_lock(
            &locker(),
            b"ethereum",
            b"ETH",
            0,
            &unlock_secret(),
            &nonce(),
        )
        .unwrap_err();
        assert_eq!(err, LockError::ZeroAmount);
    }

    // Test 6: public record hides locker_hash and unlock_secret_hash
    #[test]
    fn test_public_record_hides_secrets() {
        let lock = create_lock(
            &locker(),
            b"ethereum",
            b"USDC",
            1000,
            &unlock_secret(),
            &nonce(),
        )
        .unwrap();
        let record = lock_public_record(&lock);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["lock_id"].is_string());
        assert_eq!(v["amount"], 1000u64);
        assert_eq!(v["mainnet_ready"], false);
        assert!(v.get("locker_hash").is_none());
        assert!(v.get("unlock_secret_hash").is_none());
    }
}
