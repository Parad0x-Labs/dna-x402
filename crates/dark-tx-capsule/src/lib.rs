use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TxCapsule {
    pub capsule_id: [u8; 32],
    pub payload_commitment: [u8; 32],
    pub sender_hash: [u8; 32],
    pub unlock_at_unix: i64,
    pub revealed: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RevealedCapsule {
    pub capsule_id: [u8; 32],
    pub payload: Vec<u8>,
    pub revealed_at_unix: i64,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum CapsuleError {
    EmptyPayload,
    SenderSecretZero,
    TooEarlyToReveal,
    PayloadMismatch,
    AlreadyRevealed,
}

fn sha256_hash(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

pub fn seal_capsule(
    sender_secret: &[u8; 32],
    payload: &[u8],
    unlock_at_unix: i64,
) -> Result<TxCapsule, CapsuleError> {
    if payload.is_empty() {
        return Err(CapsuleError::EmptyPayload);
    }
    if *sender_secret == [0u8; 32] {
        return Err(CapsuleError::SenderSecretZero);
    }

    // sender_hash = SHA256("tx-sender-v1" || sender_secret)
    let mut sh_input = b"tx-sender-v1".to_vec();
    sh_input.extend_from_slice(sender_secret);
    let sender_hash = sha256_hash(&sh_input);

    // payload_commitment = SHA256("tx-payload-v1" || payload)
    let mut pc_input = b"tx-payload-v1".to_vec();
    pc_input.extend_from_slice(payload);
    let payload_commitment = sha256_hash(&pc_input);

    // capsule_id = SHA256("tx-capsule-v1" || payload_commitment || sender_hash || unlock_at_le)
    let mut cid_input = b"tx-capsule-v1".to_vec();
    cid_input.extend_from_slice(&payload_commitment);
    cid_input.extend_from_slice(&sender_hash);
    cid_input.extend_from_slice(&unlock_at_unix.to_le_bytes());
    let capsule_id = sha256_hash(&cid_input);

    Ok(TxCapsule {
        capsule_id,
        payload_commitment,
        sender_hash,
        unlock_at_unix,
        revealed: false,
        mainnet_ready: false,
    })
}

pub fn reveal_capsule(
    capsule: &mut TxCapsule,
    payload: &[u8],
    current_unix: i64,
) -> Result<RevealedCapsule, CapsuleError> {
    if capsule.revealed {
        return Err(CapsuleError::AlreadyRevealed);
    }
    if current_unix < capsule.unlock_at_unix {
        return Err(CapsuleError::TooEarlyToReveal);
    }

    // Verify payload commitment
    let mut pc_input = b"tx-payload-v1".to_vec();
    pc_input.extend_from_slice(payload);
    let computed = sha256_hash(&pc_input);
    if computed != capsule.payload_commitment {
        return Err(CapsuleError::PayloadMismatch);
    }

    capsule.revealed = true;
    Ok(RevealedCapsule {
        capsule_id: capsule.capsule_id,
        payload: payload.to_vec(),
        revealed_at_unix: current_unix,
        mainnet_ready: false,
    })
}

pub fn capsule_public_record(capsule: &TxCapsule) -> String {
    let capsule_id_hex: String = capsule
        .capsule_id
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    let pc_hex: String = capsule
        .payload_commitment
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    serde_json::json!({
        "capsule_id": capsule_id_hex,
        "payload_commitment": pc_hex,
        "unlock_at_unix": capsule.unlock_at_unix,
        "revealed": capsule.revealed,
        "mainnet_ready": capsule.mainnet_ready,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sender_secret(seed: u8) -> [u8; 32] {
        let mut s = [0xbb_u8; 32];
        s[0] = seed;
        s
    }

    #[test]
    fn test_seal_and_reveal() {
        let payload = b"transfer 100 SOL";
        let mut capsule = seal_capsule(&sender_secret(1), payload, 1_000_000).unwrap();
        assert!(!capsule.mainnet_ready);
        assert!(!capsule.revealed);
        let revealed = reveal_capsule(&mut capsule, payload, 1_000_000).unwrap();
        assert_eq!(revealed.payload, payload);
        assert!(!revealed.mainnet_ready);
        assert!(capsule.revealed);
    }

    #[test]
    fn test_too_early_rejected() {
        let payload = b"early reveal test";
        let mut capsule = seal_capsule(&sender_secret(2), payload, 9_999_999).unwrap();
        let err = reveal_capsule(&mut capsule, payload, 5_000_000).unwrap_err();
        assert_eq!(err, CapsuleError::TooEarlyToReveal);
    }

    #[test]
    fn test_wrong_payload_rejected() {
        let payload = b"correct payload";
        let mut capsule = seal_capsule(&sender_secret(3), payload, 1_000).unwrap();
        let err = reveal_capsule(&mut capsule, b"wrong payload", 2_000).unwrap_err();
        assert_eq!(err, CapsuleError::PayloadMismatch);
    }

    #[test]
    fn test_double_reveal_rejected() {
        let payload = b"double reveal test";
        let mut capsule = seal_capsule(&sender_secret(4), payload, 500).unwrap();
        reveal_capsule(&mut capsule, payload, 1_000).unwrap();
        let err = reveal_capsule(&mut capsule, payload, 1_001).unwrap_err();
        assert_eq!(err, CapsuleError::AlreadyRevealed);
    }

    #[test]
    fn test_capsule_id_deterministic() {
        let payload = b"deterministic payload";
        let c1 = seal_capsule(&sender_secret(5), payload, 2_000).unwrap();
        let c2 = seal_capsule(&sender_secret(5), payload, 2_000).unwrap();
        assert_eq!(c1.capsule_id, c2.capsule_id);
    }

    #[test]
    fn test_public_record_hides_sender_and_payload() {
        let payload = b"secret transaction data";
        let capsule = seal_capsule(&sender_secret(6), payload, 3_000).unwrap();
        let record: serde_json::Value =
            serde_json::from_str(&capsule_public_record(&capsule)).unwrap();
        // sender_hash and raw payload must NOT appear
        assert!(record.get("sender_hash").is_none());
        assert!(record.get("payload").is_none());
        // these fields must be present
        assert!(record.get("capsule_id").is_some());
        assert!(record.get("payload_commitment").is_some());
        assert!(!record["mainnet_ready"].as_bool().unwrap());
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_mainnet_ready_always_false() {
        let cap = seal_capsule(&sender_secret(10), b"payload", 0).unwrap();
        assert!(!cap.mainnet_ready);
        let mut c2 = seal_capsule(&sender_secret(10), b"payload", 0).unwrap();
        let rev = reveal_capsule(&mut c2, b"payload", 0).unwrap();
        assert!(!rev.mainnet_ready);
    }

    #[test]
    fn test_empty_payload_rejected() {
        let err = seal_capsule(&sender_secret(11), b"", 0).unwrap_err();
        assert_eq!(err, CapsuleError::EmptyPayload);
    }

    #[test]
    fn test_sender_secret_zero_rejected() {
        let err = seal_capsule(&[0u8; 32], b"payload", 0).unwrap_err();
        assert_eq!(err, CapsuleError::SenderSecretZero);
    }

    #[test]
    fn test_capsule_id_sensitive_to_payload() {
        let c1 = seal_capsule(&sender_secret(12), b"payload-a", 0).unwrap();
        let c2 = seal_capsule(&sender_secret(12), b"payload-b", 0).unwrap();
        assert_ne!(c1.capsule_id, c2.capsule_id);
    }

    #[test]
    fn test_capsule_id_sensitive_to_unlock_time() {
        let c1 = seal_capsule(&sender_secret(13), b"payload", 1000).unwrap();
        let c2 = seal_capsule(&sender_secret(13), b"payload", 2000).unwrap();
        assert_ne!(c1.capsule_id, c2.capsule_id);
    }

    #[test]
    fn test_revealed_starts_false() {
        let cap = seal_capsule(&sender_secret(14), b"test", 100).unwrap();
        assert!(!cap.revealed);
    }

    #[test]
    fn test_reveal_at_exact_time_succeeds() {
        let payload = b"exact time test";
        let mut cap = seal_capsule(&sender_secret(15), payload, 5000).unwrap();
        let rev = reveal_capsule(&mut cap, payload, 5000).unwrap();
        assert_eq!(rev.revealed_at_unix, 5000);
    }

    #[test]
    fn test_payload_stored_in_reveal() {
        let payload = b"important data";
        let mut cap = seal_capsule(&sender_secret(16), payload, 0).unwrap();
        let rev = reveal_capsule(&mut cap, payload, 0).unwrap();
        assert_eq!(rev.payload, payload);
    }

    #[test]
    fn test_public_record_has_expected_fields() {
        let cap = seal_capsule(&sender_secret(17), b"data", 9999).unwrap();
        let v: serde_json::Value = serde_json::from_str(&capsule_public_record(&cap)).unwrap();
        assert!(v["capsule_id"].is_string());
        assert!(v["payload_commitment"].is_string());
        assert_eq!(v["unlock_at_unix"], 9999i64);
        assert_eq!(v["revealed"], false);
        assert_eq!(v["mainnet_ready"], false);
    }

    #[test]
    fn test_different_senders_different_capsule_ids() {
        let c1 = seal_capsule(&sender_secret(18), b"payload", 0).unwrap();
        let c2 = seal_capsule(&sender_secret(19), b"payload", 0).unwrap();
        assert_ne!(c1.capsule_id, c2.capsule_id);
    }
}
