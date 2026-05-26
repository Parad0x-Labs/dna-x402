// NOT_PRODUCTION — devnet design only
use sha2::{Digest, Sha256};
use serde::{Serialize, Deserialize};

fn hex_encode(b: &[u8]) -> String { b.iter().map(|x| format!("{:02x}", x)).collect() }
fn sha256_chain(prefix: &str, inputs: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(prefix.as_bytes());
    for i in inputs { h.update(i); }
    h.finalize().into()
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GossipReceipt {
    pub message_commitment: [u8; 32],
    pub receiver_commitment: [u8; 32],
    pub received_at_unix: i64,
    pub hop_count: u8,
    pub mainnet_ready: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GossipProof {
    pub proof_hash: [u8; 32],
    pub message_commitment: [u8; 32],
    pub received_at_unix: i64,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum GossipError { EmptyMessage, TooManyHops { max: u8, got: u8 }, ReceiverMismatch }

pub const MAX_HOPS: u8 = 7;

pub fn create_gossip_receipt(message_bytes: &[u8], sender_nonce: &[u8; 32], receiver_secret: &[u8; 32], received_at_unix: i64, hop_count: u8) -> Result<GossipReceipt, GossipError> {
    if message_bytes.is_empty() { return Err(GossipError::EmptyMessage); }
    if hop_count > MAX_HOPS { return Err(GossipError::TooManyHops { max: MAX_HOPS, got: hop_count }); }
    let message_commitment = sha256_chain("gossip-msg-v1", &[message_bytes, sender_nonce]);
    let receiver_commitment = sha256_chain("gossip-recv-v1", &[receiver_secret, &message_commitment]);
    Ok(GossipReceipt { message_commitment, receiver_commitment, received_at_unix, hop_count, mainnet_ready: false })
}

pub fn prove_receipt(receipt: &GossipReceipt, receiver_secret: &[u8; 32]) -> Result<GossipProof, GossipError> {
    let recomputed = sha256_chain("gossip-recv-v1", &[receiver_secret, &receipt.message_commitment]);
    if recomputed != receipt.receiver_commitment { return Err(GossipError::ReceiverMismatch); }
    let ts = receipt.received_at_unix.to_le_bytes();
    let proof_hash = sha256_chain("gossip-proof-v1", &[&receipt.message_commitment, &receipt.receiver_commitment, &ts]);
    Ok(GossipProof { proof_hash, message_commitment: receipt.message_commitment, received_at_unix: receipt.received_at_unix, mainnet_ready: false })
}

pub fn verify_gossip_proof(proof: &GossipProof, expected_message_commitment: &[u8; 32]) -> bool {
    proof.message_commitment == *expected_message_commitment && proof.proof_hash != [0u8; 32]
}

pub fn receipt_public_record(receipt: &GossipReceipt) -> String {
    serde_json::json!({
        "message_commitment": hex_encode(&receipt.message_commitment),
        "received_at_unix": receipt.received_at_unix,
        "hop_count": receipt.hop_count,
        "mainnet_ready": receipt.mainnet_ready
    }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_nonce(b: u8) -> [u8; 32] { [b; 32] }

    #[test]
    fn test_gossip_receipt_happy_path() {
        let r = create_gossip_receipt(b"alpha signal", &make_nonce(1), &make_nonce(2), 1700000000, 3).unwrap();
        assert_ne!(r.message_commitment, [0u8; 32]);
        assert!(!r.mainnet_ready);
    }

    #[test]
    fn test_empty_message_rejected() {
        assert_eq!(create_gossip_receipt(b"", &make_nonce(1), &make_nonce(2), 1700000000, 3).unwrap_err(), GossipError::EmptyMessage);
    }

    #[test]
    fn test_too_many_hops_rejected() {
        assert_eq!(create_gossip_receipt(b"msg", &make_nonce(1), &make_nonce(2), 1700000000, 8).unwrap_err(), GossipError::TooManyHops { max: 7, got: 8 });
    }

    #[test]
    fn test_prove_receipt_passes() {
        let secret = make_nonce(42);
        let r = create_gossip_receipt(b"signal", &make_nonce(1), &secret, 1700000000, 2).unwrap();
        let proof = prove_receipt(&r, &secret).unwrap();
        assert!(verify_gossip_proof(&proof, &r.message_commitment));
    }

    #[test]
    fn test_wrong_receiver_rejected() {
        let r = create_gossip_receipt(b"signal", &make_nonce(1), &make_nonce(42), 1700000000, 2).unwrap();
        assert_eq!(prove_receipt(&r, &make_nonce(99)).unwrap_err(), GossipError::ReceiverMismatch);
    }
}
