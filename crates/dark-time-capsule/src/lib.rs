use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeCapsule {
    pub capsule_id: [u8; 32],
    pub content_commitment: [u8; 32],
    pub seal_hash: [u8; 32],
    pub owner_hash: [u8; 32],
    pub reveal_at_unix: i64,
    pub opened: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapsuleContents {
    pub capsule_id: [u8; 32],
    pub content_hash: [u8; 32],
    pub revealed_at_unix: i64,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum CapsuleError {
    ZeroOwnerSecret,
    EmptyContent,
    TooEarlyToOpen { opens_at: i64, current: i64 },
    AlreadyOpened,
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

fn compute_owner_hash(owner_secret: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"capsule-owner-v1");
    d.extend_from_slice(owner_secret);
    sha256(&d)
}

fn compute_content_hash(content_bytes: &[u8]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"capsule-content-v1");
    d.extend_from_slice(content_bytes);
    sha256(&d)
}

fn compute_content_commitment(content_hash: &[u8; 32], nonce: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"capsule-commit-v1");
    d.extend_from_slice(content_hash);
    d.extend_from_slice(nonce);
    sha256(&d)
}

fn compute_seal_hash(
    owner_hash: &[u8; 32],
    content_commitment: &[u8; 32],
    reveal_at: i64,
) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"capsule-seal-v1");
    d.extend_from_slice(owner_hash);
    d.extend_from_slice(content_commitment);
    d.extend_from_slice(&reveal_at.to_le_bytes());
    sha256(&d)
}

fn compute_capsule_id(seal_hash: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"capsule-id-v1");
    d.extend_from_slice(seal_hash);
    sha256(&d)
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn seal_capsule(
    owner_secret: &[u8; 32],
    content_bytes: &[u8],
    reveal_at_unix: i64,
    nonce: &[u8; 32],
) -> Result<TimeCapsule, CapsuleError> {
    if owner_secret == &[0u8; 32] {
        return Err(CapsuleError::ZeroOwnerSecret);
    }
    if content_bytes.is_empty() {
        return Err(CapsuleError::EmptyContent);
    }
    let owner_hash = compute_owner_hash(owner_secret);
    let content_hash = compute_content_hash(content_bytes);
    let content_commitment = compute_content_commitment(&content_hash, nonce);
    let seal_hash = compute_seal_hash(&owner_hash, &content_commitment, reveal_at_unix);
    let capsule_id = compute_capsule_id(&seal_hash);
    Ok(TimeCapsule {
        capsule_id,
        content_commitment,
        seal_hash,
        owner_hash,
        reveal_at_unix,
        opened: false,
        mainnet_ready: false,
    })
}

pub fn open_capsule(
    capsule: &mut TimeCapsule,
    content_bytes: &[u8],
    nonce: &[u8; 32],
    current_unix: i64,
) -> Result<CapsuleContents, CapsuleError> {
    if capsule.opened {
        return Err(CapsuleError::AlreadyOpened);
    }
    if current_unix < capsule.reveal_at_unix {
        return Err(CapsuleError::TooEarlyToOpen {
            opens_at: capsule.reveal_at_unix,
            current: current_unix,
        });
    }
    // Verify content commitment
    let content_hash = compute_content_hash(content_bytes);
    let expected_commit = compute_content_commitment(&content_hash, nonce);
    if expected_commit != capsule.content_commitment {
        return Err(CapsuleError::EmptyContent); // commitment mismatch treated as bad content
    }
    capsule.opened = true;
    Ok(CapsuleContents {
        capsule_id: capsule.capsule_id,
        content_hash,
        revealed_at_unix: current_unix,
        mainnet_ready: false,
    })
}

pub fn capsule_public_record(capsule: &TimeCapsule) -> String {
    serde_json::json!({
        "capsule_id":     hex(&capsule.capsule_id),
        "seal_hash":      hex(&capsule.seal_hash),
        "reveal_at_unix": capsule.reveal_at_unix,
        "opened":         capsule.opened,
        "mainnet_ready":  capsule.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn owner() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xaa;
        s
    }
    fn nonce() -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = 0x01;
        n
    }
    fn content() -> &'static [u8] {
        b"secret message"
    }

    // Test 1: seal + open happy path
    #[test]
    fn test_seal_and_open() {
        let mut cap = seal_capsule(&owner(), content(), 100, &nonce()).unwrap();
        assert!(!cap.opened);
        assert!(!cap.mainnet_ready);
        let contents = open_capsule(&mut cap, content(), &nonce(), 200).unwrap();
        assert_eq!(contents.capsule_id, cap.capsule_id);
        assert!(cap.opened);
        assert!(!contents.mainnet_ready);
    }

    // Test 2: too early rejected
    #[test]
    fn test_too_early_rejected() {
        let mut cap = seal_capsule(&owner(), content(), 1_000, &nonce()).unwrap();
        let err = open_capsule(&mut cap, content(), &nonce(), 500).unwrap_err();
        assert_eq!(
            err,
            CapsuleError::TooEarlyToOpen {
                opens_at: 1_000,
                current: 500
            }
        );
    }

    // Test 3: already opened rejected
    #[test]
    fn test_already_opened_rejected() {
        let mut cap = seal_capsule(&owner(), content(), 0, &nonce()).unwrap();
        open_capsule(&mut cap, content(), &nonce(), 1).unwrap();
        let err = open_capsule(&mut cap, content(), &nonce(), 2).unwrap_err();
        assert_eq!(err, CapsuleError::AlreadyOpened);
    }

    // Test 4: zero owner rejected
    #[test]
    fn test_zero_owner_rejected() {
        let err = seal_capsule(&[0u8; 32], content(), 100, &nonce()).unwrap_err();
        assert_eq!(err, CapsuleError::ZeroOwnerSecret);
    }

    // Test 5: empty content rejected
    #[test]
    fn test_empty_content_rejected() {
        let err = seal_capsule(&owner(), b"", 100, &nonce()).unwrap_err();
        assert_eq!(err, CapsuleError::EmptyContent);
    }

    // Test 6: public record hides owner_hash and content
    #[test]
    fn test_public_record_hides_owner_and_content() {
        let cap = seal_capsule(&owner(), content(), 100, &nonce()).unwrap();
        let record = capsule_public_record(&cap);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["capsule_id"].is_string());
        assert_eq!(v["reveal_at_unix"], 100);
        assert_eq!(v["mainnet_ready"], false);
        assert!(v.get("owner_hash").is_none());
        assert!(v.get("content_commitment").is_none());
    }
}
