use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateCommitment {
    pub state_id: [u8; 32],
    pub state_hash: [u8; 32],
    pub version: u32,
    pub owner_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateTransition {
    pub from_hash: [u8; 32],
    pub to_hash: [u8; 32],
    pub transition_hash: [u8; 32],
    pub version: u32,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum StateError {
    ZeroOwnerSecret,
    EmptyState,
    VersionMismatch { expected: u32, got: u32 },
}

fn sha256(data: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for d in data {
        h.update(d);
    }
    h.finalize().into()
}

pub fn new_state(
    owner_secret: &[u8; 32],
    state_bytes: &[u8],
    nonce: &[u8; 32],
) -> Result<StateCommitment, StateError> {
    if owner_secret == &[0u8; 32] {
        return Err(StateError::ZeroOwnerSecret);
    }
    if state_bytes.is_empty() {
        return Err(StateError::EmptyState);
    }
    let owner_hash = sha256(&[b"state-owner-v1", owner_secret]);
    let version: u32 = 0;
    let version_le = version.to_le_bytes();
    let state_hash = sha256(&[b"state-hash-v1", &owner_hash, state_bytes, &version_le]);
    let state_id = sha256(&[b"state-id-v1", &owner_hash, nonce]);
    Ok(StateCommitment {
        state_id,
        state_hash,
        version,
        owner_hash,
        mainnet_ready: false,
    })
}

pub fn transition_state(
    commitment: &mut StateCommitment,
    new_state_bytes: &[u8],
    owner_secret: &[u8; 32],
    expected_version: u32,
) -> Result<StateTransition, StateError> {
    if commitment.version != expected_version {
        return Err(StateError::VersionMismatch {
            expected: expected_version,
            got: commitment.version,
        });
    }
    let owner_hash = sha256(&[b"state-owner-v1", owner_secret]);
    let from_hash = commitment.state_hash;
    let new_version = commitment.version + 1;
    let new_version_le = new_version.to_le_bytes();
    let to_hash = sha256(&[
        b"state-hash-v1",
        &owner_hash,
        new_state_bytes,
        &new_version_le,
    ]);
    let transition_hash = sha256(&[b"state-trans-v1", &from_hash, &to_hash, &new_version_le]);

    commitment.state_hash = to_hash;
    commitment.version = new_version;
    commitment.mainnet_ready = false;

    Ok(StateTransition {
        from_hash,
        to_hash,
        transition_hash,
        version: new_version,
        mainnet_ready: false,
    })
}

pub fn state_public_record(commitment: &StateCommitment) -> String {
    let obj = serde_json::json!({
        "state_id": hex_encode(commitment.state_id),
        "state_hash": hex_encode(commitment.state_hash),
        "version": commitment.version,
        "mainnet_ready": commitment.mainnet_ready,
    });
    serde_json::to_string(&obj).unwrap()
}

fn hex_encode(b: [u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner() -> [u8; 32] {
        [5u8; 32]
    }
    fn nonce() -> [u8; 32] {
        [7u8; 32]
    }

    #[test]
    fn test_create_transition_happy_path() {
        let mut c = new_state(&owner(), b"initial state", &nonce()).unwrap();
        assert_eq!(c.version, 0);
        assert!(!c.mainnet_ready);
        let t = transition_state(&mut c, b"new state", &owner(), 0).unwrap();
        assert_eq!(c.version, 1);
        assert_eq!(t.version, 1);
        assert_eq!(t.to_hash, c.state_hash);
        assert!(!t.mainnet_ready);
    }

    #[test]
    fn test_version_mismatch_rejected() {
        let mut c = new_state(&owner(), b"initial state", &nonce()).unwrap();
        let err = transition_state(&mut c, b"new state", &owner(), 99).unwrap_err();
        assert_eq!(
            err,
            StateError::VersionMismatch {
                expected: 99,
                got: 0
            }
        );
    }

    #[test]
    fn test_zero_owner_rejected() {
        let err = new_state(&[0u8; 32], b"data", &nonce()).unwrap_err();
        assert_eq!(err, StateError::ZeroOwnerSecret);
    }

    #[test]
    fn test_empty_state_rejected() {
        let err = new_state(&owner(), b"", &nonce()).unwrap_err();
        assert_eq!(err, StateError::EmptyState);
    }

    #[test]
    fn test_state_hash_changes_with_content() {
        let c1 = new_state(&owner(), b"content-a", &nonce()).unwrap();
        let c2 = new_state(&owner(), b"content-b", &nonce()).unwrap();
        assert_ne!(c1.state_hash, c2.state_hash);
        // state_id same (same owner + nonce)
        assert_eq!(c1.state_id, c2.state_id);
    }

    #[test]
    fn test_public_record_hides_owner_hash() {
        let c = new_state(&owner(), b"some state", &nonce()).unwrap();
        let record = state_public_record(&c);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v.get("owner_hash").is_none());
        assert!(v.get("state_id").is_some());
        assert_eq!(v["mainnet_ready"], false);
    }
}
