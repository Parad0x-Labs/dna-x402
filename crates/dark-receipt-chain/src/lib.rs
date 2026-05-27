use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceiptChain {
    pub chain_id: [u8; 32],
    pub head: [u8; 32],
    pub receipt_count: u32,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainedReceipt {
    pub receipt_hash: [u8; 32],
    pub prev_hash: [u8; 32],
    pub chain_id: [u8; 32],
    pub seq: u32,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum ChainError {
    ZeroIssuerSecret,
    EmptyPayload,
    ChainBroken { expected: [u8; 32], got: [u8; 32] },
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

fn compute_issuer_hash(issuer_secret: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"rchain-issuer-v1");
    d.extend_from_slice(issuer_secret);
    sha256(&d)
}

fn compute_chain_id(issuer_hash: &[u8; 32], nonce: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"rchain-id-v1");
    d.extend_from_slice(issuer_hash);
    d.extend_from_slice(nonce);
    sha256(&d)
}

fn compute_payload_hash(payload_bytes: &[u8]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"rchain-payload-v1");
    d.extend_from_slice(payload_bytes);
    sha256(&d)
}

fn compute_receipt_hash(prev_hash: &[u8; 32], payload_hash: &[u8; 32], seq: u32) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"rchain-receipt-v1");
    d.extend_from_slice(prev_hash);
    d.extend_from_slice(payload_hash);
    d.extend_from_slice(&seq.to_le_bytes());
    sha256(&d)
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn new_chain(issuer_secret: &[u8; 32], nonce: &[u8; 32]) -> Result<ReceiptChain, ChainError> {
    if issuer_secret == &[0u8; 32] {
        return Err(ChainError::ZeroIssuerSecret);
    }
    let issuer_hash = compute_issuer_hash(issuer_secret);
    let chain_id = compute_chain_id(&issuer_hash, nonce);
    // Initial head = chain_id
    Ok(ReceiptChain {
        chain_id,
        head: chain_id,
        receipt_count: 0,
        mainnet_ready: false,
    })
}

pub fn append_receipt(
    chain: &mut ReceiptChain,
    payload_bytes: &[u8],
) -> Result<ChainedReceipt, ChainError> {
    if payload_bytes.is_empty() {
        return Err(ChainError::EmptyPayload);
    }
    let seq = chain.receipt_count;
    let prev_hash = chain.head;
    let payload_hash = compute_payload_hash(payload_bytes);
    let receipt_hash = compute_receipt_hash(&prev_hash, &payload_hash, seq);

    chain.head = receipt_hash;
    chain.receipt_count += 1;

    Ok(ChainedReceipt {
        receipt_hash,
        prev_hash,
        chain_id: chain.chain_id,
        seq,
        mainnet_ready: false,
    })
}

pub fn verify_receipt(
    chain: &ReceiptChain,
    receipt: &ChainedReceipt,
    payload_bytes: &[u8],
) -> bool {
    if receipt.chain_id != chain.chain_id {
        return false;
    }
    let payload_hash = compute_payload_hash(payload_bytes);
    let expected_hash = compute_receipt_hash(&receipt.prev_hash, &payload_hash, receipt.seq);
    expected_hash == receipt.receipt_hash
}

pub fn chain_public_record(chain: &ReceiptChain) -> String {
    serde_json::json!({
        "chain_id":      hex(&chain.chain_id),
        "head":          hex(&chain.head),
        "receipt_count": chain.receipt_count,
        "mainnet_ready": chain.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn issuer() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xee;
        s
    }
    fn nonce() -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = 0x01;
        n
    }

    // Test 1: new chain + append + verify
    #[test]
    fn test_new_append_verify() {
        let mut chain = new_chain(&issuer(), &nonce()).unwrap();
        assert!(!chain.mainnet_ready);
        let receipt = append_receipt(&mut chain, b"tx-payload").unwrap();
        assert!(!receipt.mainnet_ready);
        assert!(verify_receipt(&chain, &receipt, b"tx-payload"));
        // Wrong payload → verify fails
        assert!(!verify_receipt(&chain, &receipt, b"wrong-payload"));
    }

    // Test 2: chain advances head after each receipt
    #[test]
    fn test_chain_advances_head() {
        let mut chain = new_chain(&issuer(), &nonce()).unwrap();
        let initial_head = chain.head;
        append_receipt(&mut chain, b"first").unwrap();
        assert_ne!(chain.head, initial_head);
        let head_after_first = chain.head;
        append_receipt(&mut chain, b"second").unwrap();
        assert_ne!(chain.head, head_after_first);
    }

    // Test 3: seq increments
    #[test]
    fn test_seq_increments() {
        let mut chain = new_chain(&issuer(), &nonce()).unwrap();
        let r0 = append_receipt(&mut chain, b"p0").unwrap();
        let r1 = append_receipt(&mut chain, b"p1").unwrap();
        let r2 = append_receipt(&mut chain, b"p2").unwrap();
        assert_eq!(r0.seq, 0);
        assert_eq!(r1.seq, 1);
        assert_eq!(r2.seq, 2);
        assert_eq!(chain.receipt_count, 3);
    }

    // Test 4: empty payload rejected
    #[test]
    fn test_empty_payload_rejected() {
        let mut chain = new_chain(&issuer(), &nonce()).unwrap();
        let err = append_receipt(&mut chain, b"").unwrap_err();
        assert_eq!(err, ChainError::EmptyPayload);
    }

    // Test 5: receipt_hash sensitive to payload
    #[test]
    fn test_receipt_hash_sensitive_to_payload() {
        let mut chain1 = new_chain(&issuer(), &nonce()).unwrap();
        let mut chain2 = new_chain(&issuer(), &nonce()).unwrap();
        let r1 = append_receipt(&mut chain1, b"payload-A").unwrap();
        let r2 = append_receipt(&mut chain2, b"payload-B").unwrap();
        assert_ne!(r1.receipt_hash, r2.receipt_hash);
    }

    // Test 6: public record correct
    #[test]
    fn test_public_record_correct() {
        let mut chain = new_chain(&issuer(), &nonce()).unwrap();
        append_receipt(&mut chain, b"data").unwrap();
        let record = chain_public_record(&chain);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["chain_id"].is_string());
        assert!(v["head"].is_string());
        assert_eq!(v["receipt_count"], 1);
        assert_eq!(v["mainnet_ready"], false);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_chain_id_nonzero() {
        let chain = new_chain(&issuer(), &nonce()).unwrap();
        assert_ne!(chain.chain_id, [0u8; 32]);
    }

    #[test]
    fn test_head_equals_chain_id_initially() {
        let chain = new_chain(&issuer(), &nonce()).unwrap();
        assert_eq!(chain.head, chain.chain_id);
    }

    #[test]
    fn test_mainnet_ready_false() {
        let chain = new_chain(&issuer(), &nonce()).unwrap();
        assert!(!chain.mainnet_ready);
    }

    #[test]
    fn test_receipt_mainnet_ready_false() {
        let mut chain = new_chain(&issuer(), &nonce()).unwrap();
        let receipt = append_receipt(&mut chain, b"payload").unwrap();
        assert!(!receipt.mainnet_ready);
    }

    #[test]
    fn test_zero_issuer_secret_rejected() {
        let zero = [0u8; 32];
        let err = new_chain(&zero, &nonce()).unwrap_err();
        assert_eq!(err, ChainError::ZeroIssuerSecret);
    }

    #[test]
    fn test_receipt_chain_id_matches() {
        let mut chain = new_chain(&issuer(), &nonce()).unwrap();
        let receipt = append_receipt(&mut chain, b"payload").unwrap();
        assert_eq!(receipt.chain_id, chain.chain_id);
    }

    #[test]
    fn test_receipt_prev_hash_is_initial_head() {
        let mut chain = new_chain(&issuer(), &nonce()).unwrap();
        let initial_head = chain.head;
        let r0 = append_receipt(&mut chain, b"first").unwrap();
        assert_eq!(r0.prev_hash, initial_head);
    }

    #[test]
    fn test_verify_fails_wrong_chain() {
        let mut chain1 = new_chain(&issuer(), &nonce()).unwrap();
        let mut n2 = nonce();
        n2[0] = 0x99;
        let chain2 = new_chain(&issuer(), &n2).unwrap();
        let receipt = append_receipt(&mut chain1, b"payload").unwrap();
        // Receipt chain_id != chain2.chain_id → verify returns false
        assert!(!verify_receipt(&chain2, &receipt, b"payload"));
    }

    #[test]
    fn test_different_nonce_different_chain_id() {
        let chain1 = new_chain(&issuer(), &nonce()).unwrap();
        let mut n2 = nonce();
        n2[1] = 0xFF;
        let chain2 = new_chain(&issuer(), &n2).unwrap();
        assert_ne!(chain1.chain_id, chain2.chain_id);
    }

    #[test]
    fn test_different_issuer_different_chain_id() {
        let chain1 = new_chain(&issuer(), &nonce()).unwrap();
        let mut iss2 = issuer();
        iss2[1] = 0xFF;
        let chain2 = new_chain(&iss2, &nonce()).unwrap();
        assert_ne!(chain1.chain_id, chain2.chain_id);
    }
}
