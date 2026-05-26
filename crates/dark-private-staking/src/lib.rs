use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StakePosition {
    pub position_id: [u8; 32],
    pub staker_hash: [u8; 32],
    pub amount: u64,
    pub locked_until_unix: i64,
    pub rewards_hash: [u8; 32],
    pub unstaked: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum StakeError {
    ZeroStakerSecret,
    ZeroAmount,
    NotUnlocked { unlock_at: i64, current: i64 },
    AlreadyUnstaked,
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

fn compute_staker_hash(staker_secret: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"stake-staker-v1");
    d.extend_from_slice(staker_secret);
    sha256(&d)
}

fn compute_rewards_hash(staker_hash: &[u8; 32], amount: u64, locked_until_unix: i64) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"stake-rewards-v1");
    d.extend_from_slice(staker_hash);
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(&locked_until_unix.to_le_bytes());
    sha256(&d)
}

fn compute_position_id(
    staker_hash: &[u8; 32],
    amount: u64,
    locked_until_unix: i64,
    nonce: &[u8; 32],
) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"stake-pos-v1");
    d.extend_from_slice(staker_hash);
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(&locked_until_unix.to_le_bytes());
    d.extend_from_slice(nonce);
    sha256(&d)
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn create_position(
    staker_secret: &[u8; 32],
    amount: u64,
    locked_until_unix: i64,
    nonce: &[u8; 32],
) -> Result<StakePosition, StakeError> {
    if staker_secret == &[0u8; 32] {
        return Err(StakeError::ZeroStakerSecret);
    }
    if amount == 0 {
        return Err(StakeError::ZeroAmount);
    }
    let staker_hash = compute_staker_hash(staker_secret);
    let rewards_hash = compute_rewards_hash(&staker_hash, amount, locked_until_unix);
    let position_id = compute_position_id(&staker_hash, amount, locked_until_unix, nonce);
    Ok(StakePosition {
        position_id,
        staker_hash,
        amount,
        locked_until_unix,
        rewards_hash,
        unstaked: false,
        mainnet_ready: false,
    })
}

pub fn unstake(
    position: &mut StakePosition,
    staker_secret: &[u8; 32],
    current_unix: i64,
) -> Result<[u8; 32], StakeError> {
    if position.unstaked {
        return Err(StakeError::AlreadyUnstaked);
    }
    if current_unix < position.locked_until_unix {
        return Err(StakeError::NotUnlocked {
            unlock_at: position.locked_until_unix,
            current: current_unix,
        });
    }
    let staker_hash = compute_staker_hash(staker_secret);
    if staker_hash != position.staker_hash {
        return Err(StakeError::ZeroStakerSecret); // wrong secret
    }
    position.unstaked = true;
    Ok(position.position_id)
}

pub fn position_public_record(position: &StakePosition) -> String {
    serde_json::json!({
        "position_id": hex(&position.position_id),
        "amount": position.amount,
        "locked_until_unix": position.locked_until_unix,
        "unstaked": position.unstaked,
        "mainnet_ready": position.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn secret() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xab;
        s
    }

    fn nonce() -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = 0x01;
        n
    }

    // Test 1: create + unstake happy path
    #[test]
    fn test_create_and_unstake() {
        let mut pos = create_position(&secret(), 1000, 100, &nonce()).unwrap();
        assert!(!pos.unstaked);
        assert!(!pos.mainnet_ready);
        let id = unstake(&mut pos, &secret(), 200).unwrap();
        assert_eq!(id, pos.position_id);
        assert!(pos.unstaked);
    }

    // Test 2: not unlocked rejected
    #[test]
    fn test_not_unlocked_rejected() {
        let mut pos = create_position(&secret(), 500, 1000, &nonce()).unwrap();
        let err = unstake(&mut pos, &secret(), 500).unwrap_err();
        assert_eq!(
            err,
            StakeError::NotUnlocked {
                unlock_at: 1000,
                current: 500
            }
        );
    }

    // Test 3: already unstaked rejected
    #[test]
    fn test_already_unstaked_rejected() {
        let mut pos = create_position(&secret(), 100, 0, &nonce()).unwrap();
        unstake(&mut pos, &secret(), 1).unwrap();
        let err = unstake(&mut pos, &secret(), 2).unwrap_err();
        assert_eq!(err, StakeError::AlreadyUnstaked);
    }

    // Test 4: zero staker secret rejected
    #[test]
    fn test_zero_staker_rejected() {
        let err = create_position(&[0u8; 32], 100, 0, &nonce()).unwrap_err();
        assert_eq!(err, StakeError::ZeroStakerSecret);
    }

    // Test 5: zero amount rejected
    #[test]
    fn test_zero_amount_rejected() {
        let err = create_position(&secret(), 0, 0, &nonce()).unwrap_err();
        assert_eq!(err, StakeError::ZeroAmount);
    }

    // Test 6: public record hides staker_hash
    #[test]
    fn test_public_record_hides_staker() {
        let pos = create_position(&secret(), 100, 0, &nonce()).unwrap();
        let record = position_public_record(&pos);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["position_id"].is_string());
        assert_eq!(v["amount"], 100u64);
        assert_eq!(v["mainnet_ready"], false);
        assert!(v.get("staker_hash").is_none());
    }
}
