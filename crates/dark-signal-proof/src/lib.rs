use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalCommitment {
    pub signal_id: [u8; 32],
    pub commitment: [u8; 32],
    pub sender_hash: [u8; 32],
    pub channel_hash: [u8; 32],
    pub epoch: u64,
    pub reveal_after_epoch: u64,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalReveal {
    pub signal_id: [u8; 32],
    pub message_hash: [u8; 32],
    pub revealed_at_epoch: u64,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum SignalError {
    ZeroSenderSecret,
    EmptyChannel,
    EmptyMessage,
    TooEarlyToReveal { reveal_epoch: u64, current: u64 },
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

fn compute_commitment(
    sender_hash: &[u8; 32],
    channel_hash: &[u8; 32],
    message_hash: &[u8; 32],
    epoch: u64,
    nonce: &[u8; 32],
) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"signal-commit-v1");
    d.extend_from_slice(sender_hash);
    d.extend_from_slice(channel_hash);
    d.extend_from_slice(message_hash);
    d.extend_from_slice(&epoch.to_le_bytes());
    d.extend_from_slice(nonce);
    sha256(&d)
}

fn compute_signal_id(commitment: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"signal-id-v1");
    d.extend_from_slice(commitment);
    sha256(&d)
}

fn compute_message_hash(message_bytes: &[u8]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"signal-msg-v1");
    d.extend_from_slice(message_bytes);
    sha256(&d)
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn commit_signal(
    sender_secret: &[u8; 32],
    channel_bytes: &[u8],
    message_bytes: &[u8],
    epoch: u64,
    reveal_after_epoch: u64,
    nonce: &[u8; 32],
) -> Result<SignalCommitment, SignalError> {
    if sender_secret == &[0u8; 32] {
        return Err(SignalError::ZeroSenderSecret);
    }
    if channel_bytes.is_empty() {
        return Err(SignalError::EmptyChannel);
    }
    if message_bytes.is_empty() {
        return Err(SignalError::EmptyMessage);
    }

    // sender_hash = SHA256("signal-sender-v1" || sender_secret)
    let sender_hash = {
        let mut d = Vec::new();
        d.extend_from_slice(b"signal-sender-v1");
        d.extend_from_slice(sender_secret);
        sha256(&d)
    };

    // channel_hash = SHA256("signal-channel-v1" || channel_bytes)
    let channel_hash = {
        let mut d = Vec::new();
        d.extend_from_slice(b"signal-channel-v1");
        d.extend_from_slice(channel_bytes);
        sha256(&d)
    };

    // message_hash = SHA256("signal-msg-v1" || message_bytes)
    let message_hash = compute_message_hash(message_bytes);

    // commitment = SHA256("signal-commit-v1" || sender_hash || channel_hash || message_hash || epoch_le || nonce)
    let commitment = compute_commitment(&sender_hash, &channel_hash, &message_hash, epoch, nonce);

    // signal_id = SHA256("signal-id-v1" || commitment)
    let signal_id = compute_signal_id(&commitment);

    Ok(SignalCommitment {
        signal_id,
        commitment,
        sender_hash,
        channel_hash,
        epoch,
        reveal_after_epoch,
        mainnet_ready: false,
    })
}

pub fn reveal_signal(
    commitment: &SignalCommitment,
    message_bytes: &[u8],
    _nonce: &[u8; 32],
    current_epoch: u64,
) -> Result<SignalReveal, SignalError> {
    if current_epoch < commitment.reveal_after_epoch {
        return Err(SignalError::TooEarlyToReveal {
            reveal_epoch: commitment.reveal_after_epoch,
            current: current_epoch,
        });
    }
    let message_hash = compute_message_hash(message_bytes);
    Ok(SignalReveal {
        signal_id: commitment.signal_id,
        message_hash,
        revealed_at_epoch: current_epoch,
        mainnet_ready: false,
    })
}

pub fn verify_signal(
    commitment: &SignalCommitment,
    reveal: &SignalReveal,
    message_bytes: &[u8],
    nonce: &[u8; 32],
) -> bool {
    let message_hash = compute_message_hash(message_bytes);
    if message_hash != reveal.message_hash {
        return false;
    }
    // recompute commitment from stored fields + message + nonce
    let recomputed_commitment = compute_commitment(
        &commitment.sender_hash,
        &commitment.channel_hash,
        &message_hash,
        commitment.epoch,
        nonce,
    );
    let recomputed_signal_id = compute_signal_id(&recomputed_commitment);
    recomputed_signal_id == commitment.signal_id && commitment.signal_id == reveal.signal_id
}

pub fn signal_public_record(commitment: &SignalCommitment) -> String {
    serde_json::json!({
        "signal_id": hex(&commitment.signal_id),
        "channel_hash": hex(&commitment.channel_hash),
        "epoch": commitment.epoch,
        "mainnet_ready": commitment.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sender() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 1;
        s
    }
    fn nonce() -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = 77;
        n
    }

    // Test 1: commit + reveal + verify happy path
    #[test]
    fn test_happy_path() {
        let sc = commit_signal(&sender(), b"#general", b"hello world", 10, 10, &nonce()).unwrap();
        assert!(!sc.mainnet_ready);
        let reveal = reveal_signal(&sc, b"hello world", &nonce(), 10).unwrap();
        assert!(!reveal.mainnet_ready);
        assert!(verify_signal(&sc, &reveal, b"hello world", &nonce()));
    }

    // Test 2: too early to reveal rejected
    #[test]
    fn test_too_early_to_reveal() {
        let sc = commit_signal(&sender(), b"#news", b"big news", 5, 100, &nonce()).unwrap();
        let err = reveal_signal(&sc, b"big news", &nonce(), 50).unwrap_err();
        assert_eq!(
            err,
            SignalError::TooEarlyToReveal {
                reveal_epoch: 100,
                current: 50
            }
        );
    }

    // Test 3: different channels → different signal_ids
    #[test]
    fn test_different_channels_different_signal_ids() {
        let sc1 = commit_signal(&sender(), b"#chan1", b"msg", 1, 1, &nonce()).unwrap();
        let sc2 = commit_signal(&sender(), b"#chan2", b"msg", 1, 1, &nonce()).unwrap();
        assert_ne!(sc1.signal_id, sc2.signal_id);
    }

    // Test 4: different senders → different commitments
    #[test]
    fn test_different_senders_different_commitments() {
        let mut s2 = [0u8; 32];
        s2[0] = 2;
        let sc1 = commit_signal(&sender(), b"#chan", b"msg", 1, 1, &nonce()).unwrap();
        let sc2 = commit_signal(&s2, b"#chan", b"msg", 1, 1, &nonce()).unwrap();
        assert_ne!(sc1.commitment, sc2.commitment);
    }

    // Test 5: verify with wrong message returns false
    #[test]
    fn test_verify_wrong_message_false() {
        let sc = commit_signal(&sender(), b"#private", b"real msg", 3, 3, &nonce()).unwrap();
        let reveal = reveal_signal(&sc, b"real msg", &nonce(), 3).unwrap();
        assert!(!verify_signal(&sc, &reveal, b"wrong msg", &nonce()));
    }

    // Test 6: public record hides sender and message
    #[test]
    fn test_public_record_hides_sender_and_message() {
        let sc = commit_signal(&sender(), b"#open", b"secret msg", 7, 7, &nonce()).unwrap();
        let record = signal_public_record(&sc);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["signal_id"].is_string());
        assert!(v["channel_hash"].is_string());
        assert_eq!(v["epoch"], 7u64);
        assert_eq!(v["mainnet_ready"], false);
        assert!(v.get("sender_hash").is_none());
        assert!(v.get("message_hash").is_none());
    }
}
