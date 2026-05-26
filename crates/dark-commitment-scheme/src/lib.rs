use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Commitment {
    pub value_hash: [u8; 32],
    pub blinding_hash: [u8; 32],
    pub commitment: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Opening {
    pub value: Vec<u8>,
    pub blinding: [u8; 32],
    pub verified: bool,
}

#[derive(Debug, PartialEq)]
pub enum SchemeError {
    EmptyValue,
    ZeroBlinding,
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

fn compute_value_hash(value: &[u8]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"cs-value-v1");
    d.extend_from_slice(value);
    sha256(&d)
}

fn compute_blinding_hash(blinding: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"cs-blind-v1");
    d.extend_from_slice(blinding);
    sha256(&d)
}

fn compute_commitment(value_hash: &[u8; 32], blinding_hash: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"cs-commit-v1");
    d.extend_from_slice(value_hash);
    d.extend_from_slice(blinding_hash);
    sha256(&d)
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn commit(value: &[u8], blinding: &[u8; 32]) -> Result<Commitment, SchemeError> {
    if value.is_empty() {
        return Err(SchemeError::EmptyValue);
    }
    if blinding == &[0u8; 32] {
        return Err(SchemeError::ZeroBlinding);
    }

    let value_hash = compute_value_hash(value);
    let blinding_hash = compute_blinding_hash(blinding);
    let commitment = compute_commitment(&value_hash, &blinding_hash);

    Ok(Commitment {
        value_hash,
        blinding_hash,
        commitment,
        mainnet_ready: false,
    })
}

pub fn open(commitment: &Commitment, value: &[u8], blinding: &[u8; 32]) -> Opening {
    let value_hash = compute_value_hash(value);
    let blinding_hash = compute_blinding_hash(blinding);
    let recomputed = compute_commitment(&value_hash, &blinding_hash);
    let verified = recomputed == commitment.commitment;
    Opening {
        value: value.to_vec(),
        blinding: *blinding,
        verified,
    }
}

pub fn batch_commit(values: &[(&[u8], [u8; 32])]) -> Vec<Result<Commitment, SchemeError>> {
    values.iter().map(|(v, b)| commit(v, b)).collect()
}

pub fn commitment_public_record(c: &Commitment) -> String {
    serde_json::json!({
        "commitment": hex(&c.commitment),
        "mainnet_ready": c.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn blinding() -> [u8; 32] {
        let mut b = [0u8; 32];
        b[0] = 0xca;
        b[1] = 0xfe;
        b
    }

    // Test 1: commit + open → verified=true
    #[test]
    fn test_commit_open_verified() {
        let value = b"secret-value-42";
        let c = commit(value, &blinding()).unwrap();
        assert!(!c.mainnet_ready);
        let opening = open(&c, value, &blinding());
        assert!(opening.verified);
    }

    // Test 2: tampered value → verified=false
    #[test]
    fn test_tampered_value_fails() {
        let c = commit(b"original", &blinding()).unwrap();
        let opening = open(&c, b"tampered", &blinding());
        assert!(!opening.verified);
    }

    // Test 3: zero blinding → rejected
    #[test]
    fn test_zero_blinding_rejected() {
        let err = commit(b"value", &[0u8; 32]).unwrap_err();
        assert_eq!(err, SchemeError::ZeroBlinding);
    }

    // Test 4: empty value → rejected
    #[test]
    fn test_empty_value_rejected() {
        let err = commit(b"", &blinding()).unwrap_err();
        assert_eq!(err, SchemeError::EmptyValue);
    }

    // Test 5: batch_commit returns correct count
    #[test]
    fn test_batch_commit_count() {
        let b1 = blinding();
        let mut b2 = [0u8; 32];
        b2[0] = 0xbb;
        let mut b3 = [0u8; 32];
        b3[0] = 0xcc;
        let pairs: Vec<(&[u8], [u8; 32])> = vec![(b"val1", b1), (b"val2", b2), (b"val3", b3)];
        let results = batch_commit(&pairs);
        assert_eq!(results.len(), 3);
        for r in &results {
            assert!(r.is_ok());
        }
    }

    // Test 6: public record hides value_hash and blinding_hash
    #[test]
    fn test_public_record_hides_internals() {
        let c = commit(b"secret", &blinding()).unwrap();
        let record = commitment_public_record(&c);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["commitment"].is_string());
        assert_eq!(v["mainnet_ready"], false);
        assert!(v.get("value_hash").is_none());
        assert!(v.get("blinding_hash").is_none());
    }
}
