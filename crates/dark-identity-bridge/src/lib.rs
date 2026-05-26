use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdentityAnchor {
    pub anchor_id: [u8; 32],
    pub chain_a_hash: [u8; 32],
    pub chain_b_hash: [u8; 32],
    pub bridge_commitment: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeProof {
    pub anchor_id: [u8; 32],
    pub proof_hash: [u8; 32],
    pub verified: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum BridgeError {
    ZeroIdentitySecret,
    SameChain,
    EmptyChainId,
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

fn compute_proof_hash(anchor: &IdentityAnchor) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"bridge-proof-v1");
    d.extend_from_slice(&anchor.anchor_id);
    d.extend_from_slice(&anchor.bridge_commitment);
    sha256(&d)
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn create_anchor(
    identity_secret: &[u8; 32],
    chain_a_id: &[u8],
    chain_b_id: &[u8],
    nonce: &[u8; 32],
) -> Result<IdentityAnchor, BridgeError> {
    if identity_secret == &[0u8; 32] {
        return Err(BridgeError::ZeroIdentitySecret);
    }
    if chain_a_id.is_empty() {
        return Err(BridgeError::EmptyChainId);
    }
    if chain_a_id == chain_b_id {
        return Err(BridgeError::SameChain);
    }

    // identity_hash = SHA256("bridge-identity-v1" || identity_secret)
    let identity_hash = {
        let mut d = Vec::new();
        d.extend_from_slice(b"bridge-identity-v1");
        d.extend_from_slice(identity_secret);
        sha256(&d)
    };

    // chain_a_hash = SHA256("bridge-chain-v1" || chain_a_id_bytes || identity_hash)
    let chain_a_hash = {
        let mut d = Vec::new();
        d.extend_from_slice(b"bridge-chain-v1");
        d.extend_from_slice(chain_a_id);
        d.extend_from_slice(&identity_hash);
        sha256(&d)
    };

    // chain_b_hash = SHA256("bridge-chain-v1" || chain_b_id_bytes || identity_hash)
    let chain_b_hash = {
        let mut d = Vec::new();
        d.extend_from_slice(b"bridge-chain-v1");
        d.extend_from_slice(chain_b_id);
        d.extend_from_slice(&identity_hash);
        sha256(&d)
    };

    // bridge_commitment = SHA256("bridge-commit-v1" || chain_a_hash || chain_b_hash)
    let bridge_commitment = {
        let mut d = Vec::new();
        d.extend_from_slice(b"bridge-commit-v1");
        d.extend_from_slice(&chain_a_hash);
        d.extend_from_slice(&chain_b_hash);
        sha256(&d)
    };

    // anchor_id = SHA256("bridge-anchor-v1" || bridge_commitment || nonce)
    let anchor_id = {
        let mut d = Vec::new();
        d.extend_from_slice(b"bridge-anchor-v1");
        d.extend_from_slice(&bridge_commitment);
        d.extend_from_slice(nonce);
        sha256(&d)
    };

    Ok(IdentityAnchor {
        anchor_id,
        chain_a_hash,
        chain_b_hash,
        bridge_commitment,
        mainnet_ready: false,
    })
}

pub fn prove_bridge(anchor: &IdentityAnchor) -> BridgeProof {
    let proof_hash = compute_proof_hash(anchor);
    BridgeProof {
        anchor_id: anchor.anchor_id,
        proof_hash,
        verified: true,
        mainnet_ready: false,
    }
}

pub fn verify_bridge(anchor: &IdentityAnchor, proof: &BridgeProof) -> bool {
    let expected = compute_proof_hash(anchor);
    expected == proof.proof_hash && anchor.anchor_id == proof.anchor_id
}

pub fn anchor_public_record(anchor: &IdentityAnchor) -> String {
    serde_json::json!({
        "anchor_id": hex(&anchor.anchor_id),
        "bridge_commitment": hex(&anchor.bridge_commitment),
        "mainnet_ready": anchor.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn secret() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 1;
        s
    }
    fn nonce() -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = 99;
        n
    }

    // Test 1: create + prove + verify happy path
    #[test]
    fn test_happy_path() {
        let anchor = create_anchor(&secret(), b"solana", b"ethereum", &nonce()).unwrap();
        assert!(!anchor.mainnet_ready);
        let proof = prove_bridge(&anchor);
        assert!(proof.verified);
        assert!(!proof.mainnet_ready);
        assert!(verify_bridge(&anchor, &proof));
    }

    // Test 2: same chain rejected
    #[test]
    fn test_same_chain_rejected() {
        let err = create_anchor(&secret(), b"solana", b"solana", &nonce()).unwrap_err();
        assert_eq!(err, BridgeError::SameChain);
    }

    // Test 3: zero secret rejected
    #[test]
    fn test_zero_secret_rejected() {
        let err = create_anchor(&[0u8; 32], b"solana", b"eth", &nonce()).unwrap_err();
        assert_eq!(err, BridgeError::ZeroIdentitySecret);
    }

    // Test 4: empty chain id rejected
    #[test]
    fn test_empty_chain_id_rejected() {
        let err = create_anchor(&secret(), b"", b"ethereum", &nonce()).unwrap_err();
        assert_eq!(err, BridgeError::EmptyChainId);
    }

    // Test 5: bridge_commitment is sensitive to chain ids
    #[test]
    fn test_commitment_sensitive_to_chain_ids() {
        let a1 = create_anchor(&secret(), b"chainA", b"chainB", &nonce()).unwrap();
        let a2 = create_anchor(&secret(), b"chainA", b"chainC", &nonce()).unwrap();
        assert_ne!(a1.bridge_commitment, a2.bridge_commitment);
    }

    // Test 6: public record hides identity (no chain_a_hash, chain_b_hash, identity)
    #[test]
    fn test_public_record_hides_identity() {
        let anchor = create_anchor(&secret(), b"solana", b"ethereum", &nonce()).unwrap();
        let record = anchor_public_record(&anchor);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["anchor_id"].is_string());
        assert!(v["bridge_commitment"].is_string());
        assert_eq!(v["mainnet_ready"], false);
        // must NOT contain chain hashes or identity hash
        assert!(v.get("chain_a_hash").is_none());
        assert!(v.get("chain_b_hash").is_none());
        assert!(v.get("identity_hash").is_none());
    }
}
