use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageCapsule {
    pub capsule_id: [u8; 32],
    pub recipient_key_hash: [u8; 32],
    pub message_commitment: [u8; 32],
    pub ciphertext_hash: [u8; 32],
    pub sender_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecryptedMessage {
    pub capsule_id: [u8; 32],
    pub plaintext_hash: [u8; 32],
    pub verified: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum CapsuleError {
    ZeroSenderSecret,
    ZeroRecipientSecret,
    EmptyMessage,
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

// ── API ────────────────────────────────────────────────────────────────────

pub fn seal_message(
    sender_secret: &[u8; 32],
    recipient_secret: &[u8; 32],
    message_bytes: &[u8],
    nonce: &[u8; 32],
) -> Result<MessageCapsule, CapsuleError> {
    if sender_secret == &[0u8; 32] {
        return Err(CapsuleError::ZeroSenderSecret);
    }
    if recipient_secret == &[0u8; 32] {
        return Err(CapsuleError::ZeroRecipientSecret);
    }
    if message_bytes.is_empty() {
        return Err(CapsuleError::EmptyMessage);
    }

    let sender_hash = sha256_multi(&[b"mcapsule-sender-v1", sender_secret]);
    let recipient_key_hash = sha256_multi(&[b"mcapsule-recipient-v1", recipient_secret]);
    let shared_key = sha256_multi(&[b"mcapsule-shared-v1", &sender_hash, &recipient_key_hash]);
    let plaintext_hash = sha256_multi(&[b"mcapsule-plain-v1", message_bytes]);
    let message_commitment = sha256_multi(&[b"mcapsule-commit-v1", &plaintext_hash, nonce]);
    let ciphertext_hash = sha256_multi(&[b"mcapsule-cipher-v1", &shared_key, &message_commitment]);
    let capsule_id = sha256_multi(&[b"mcapsule-id-v1", &ciphertext_hash, &sender_hash]);

    Ok(MessageCapsule {
        capsule_id,
        recipient_key_hash,
        message_commitment,
        ciphertext_hash,
        sender_hash,
        mainnet_ready: false,
    })
}

pub fn unseal_message(
    capsule: &MessageCapsule,
    sender_secret: &[u8; 32],
    recipient_secret: &[u8; 32],
    message_bytes: &[u8],
    nonce: &[u8; 32],
) -> Result<DecryptedMessage, CapsuleError> {
    if sender_secret == &[0u8; 32] {
        return Err(CapsuleError::ZeroSenderSecret);
    }
    if recipient_secret == &[0u8; 32] {
        return Err(CapsuleError::ZeroRecipientSecret);
    }
    if message_bytes.is_empty() {
        return Err(CapsuleError::EmptyMessage);
    }

    let sender_hash = sha256_multi(&[b"mcapsule-sender-v1", sender_secret]);
    let recipient_key_hash = sha256_multi(&[b"mcapsule-recipient-v1", recipient_secret]);
    let shared_key = sha256_multi(&[b"mcapsule-shared-v1", &sender_hash, &recipient_key_hash]);
    let plaintext_hash = sha256_multi(&[b"mcapsule-plain-v1", message_bytes]);
    let message_commitment = sha256_multi(&[b"mcapsule-commit-v1", &plaintext_hash, nonce]);
    let recomputed_ciphertext_hash = sha256_multi(&[b"mcapsule-cipher-v1", &shared_key, &message_commitment]);

    let verified = recomputed_ciphertext_hash == capsule.ciphertext_hash;

    Ok(DecryptedMessage {
        capsule_id: capsule.capsule_id,
        plaintext_hash,
        verified,
        mainnet_ready: false,
    })
}

pub fn capsule_public_record(capsule: &MessageCapsule) -> String {
    serde_json::json!({
        "capsule_id": hex32(&capsule.capsule_id),
        "ciphertext_hash": hex32(&capsule.ciphertext_hash),
        "mainnet_ready": capsule.mainnet_ready,
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
        let mut n = [0u8; 32];
        n[0] = b;
        n
    }

    #[test]
    fn test_seal_unseal_verify() {
        let sender = secret(0x11);
        let recipient = secret(0x22);
        let msg = b"hello-capsule-world";
        let n = nonce(0xab);

        let capsule = seal_message(&sender, &recipient, msg, &n).unwrap();
        assert!(!capsule.mainnet_ready);

        let dm = unseal_message(&capsule, &sender, &recipient, msg, &n).unwrap();
        assert!(dm.verified);
        assert!(!dm.mainnet_ready);
    }

    #[test]
    fn test_wrong_message_fails_verify() {
        let sender = secret(0x33);
        let recipient = secret(0x44);
        let msg = b"correct-message";
        let wrong_msg = b"wrong-message";
        let n = nonce(0xcd);

        let capsule = seal_message(&sender, &recipient, msg, &n).unwrap();
        let dm = unseal_message(&capsule, &sender, &recipient, wrong_msg, &n).unwrap();
        assert!(!dm.verified);
    }

    #[test]
    fn test_zero_sender_rejected() {
        let sender = [0u8; 32];
        let recipient = secret(0x55);
        let n = nonce(0x01);
        let err = seal_message(&sender, &recipient, b"msg", &n).unwrap_err();
        assert_eq!(err, CapsuleError::ZeroSenderSecret);
    }

    #[test]
    fn test_empty_message_rejected() {
        let sender = secret(0x66);
        let recipient = secret(0x77);
        let n = nonce(0x02);
        let err = seal_message(&sender, &recipient, b"", &n).unwrap_err();
        assert_eq!(err, CapsuleError::EmptyMessage);
    }

    #[test]
    fn test_same_message_different_nonces_different_capsule_ids() {
        let sender = secret(0x88);
        let recipient = secret(0x99);
        let msg = b"same-message";
        let n1 = nonce(0x10);
        let n2 = nonce(0x20);

        let cap1 = seal_message(&sender, &recipient, msg, &n1).unwrap();
        let cap2 = seal_message(&sender, &recipient, msg, &n2).unwrap();
        assert_ne!(cap1.capsule_id, cap2.capsule_id);
        assert_ne!(cap1.message_commitment, cap2.message_commitment);
    }

    #[test]
    fn test_public_record_hides_sender_and_recipient() {
        let sender = secret(0xaa);
        let recipient = secret(0xbb);
        let n = nonce(0x03);
        let capsule = seal_message(&sender, &recipient, b"secret-msg", &n).unwrap();
        let record = capsule_public_record(&capsule);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["capsule_id"].is_string());
        assert!(v["ciphertext_hash"].is_string());
        assert_eq!(v["mainnet_ready"], false);
        assert!(v.get("sender_hash").is_none());
        assert!(v.get("recipient_key_hash").is_none());
        assert!(!record.contains(&hex32(&capsule.sender_hash)));
        assert!(!record.contains(&hex32(&capsule.recipient_key_hash)));
    }
}
