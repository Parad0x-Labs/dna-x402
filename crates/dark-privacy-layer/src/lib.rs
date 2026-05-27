use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrivacyLayer {
    pub layer_id: [u8; 32],
    pub commitment: [u8; 32],
    pub nullifier_root: [u8; 32],
    pub payload_count: u32,
    pub mainnet_ready: bool,
    // Internal: store all nullifiers for XOR-fold updates
    #[serde(skip)]
    nullifiers: Vec<[u8; 32]>,
    #[serde(skip)]
    layer_secret_hash: [u8; 32],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtectedPayload {
    pub payload_id: [u8; 32],
    pub commitment: [u8; 32],
    pub nullifier: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum PrivacyError {
    ZeroLayerSecret,
    EmptyPayload,
    NullifierAlreadyUsed,
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

fn xor_fold(hashes: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = [0u8; 32];
    for h in hashes {
        for i in 0..32 {
            acc[i] ^= h[i];
        }
    }
    acc
}

fn compute_layer_secret_hash(layer_secret: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"privacy-layer-v1", layer_secret])
}

fn compute_layer_id(lsh: &[u8; 32], nonce: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"privacy-layer-id-v1", lsh, nonce])
}

fn compute_commitment(payload_bytes: &[u8], lsh: &[u8; 32]) -> [u8; 32] {
    let ph = sha256_multi(&[payload_bytes]);
    sha256_multi(&[b"privacy-payload-commit-v1", &ph, lsh])
}

fn compute_nullifier(commitment: &[u8; 32], lsh: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"privacy-null-v1", commitment, lsh])
}

fn compute_nullifier_root(nullifiers: &[[u8; 32]]) -> [u8; 32] {
    let folded = xor_fold(nullifiers);
    sha256_multi(&[b"privacy-null-root-v1", &folded])
}

fn compute_payload_id(commitment: &[u8; 32], nullifier: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"privacy-payload-id-v1", commitment, nullifier])
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn new_layer(layer_secret: &[u8; 32], nonce: &[u8; 32]) -> Result<PrivacyLayer, PrivacyError> {
    if layer_secret == &[0u8; 32] {
        return Err(PrivacyError::ZeroLayerSecret);
    }
    let lsh = compute_layer_secret_hash(layer_secret);
    let layer_id = compute_layer_id(&lsh, nonce);
    let empty_root = compute_nullifier_root(&[]);
    Ok(PrivacyLayer {
        layer_id,
        commitment: [0u8; 32],
        nullifier_root: empty_root,
        payload_count: 0,
        mainnet_ready: false,
        nullifiers: Vec::new(),
        layer_secret_hash: lsh,
    })
}

pub fn protect_payload(
    layer: &mut PrivacyLayer,
    payload_bytes: &[u8],
) -> Result<ProtectedPayload, PrivacyError> {
    if payload_bytes.is_empty() {
        return Err(PrivacyError::EmptyPayload);
    }
    let commitment = compute_commitment(payload_bytes, &layer.layer_secret_hash);
    let nullifier = compute_nullifier(&commitment, &layer.layer_secret_hash);
    // Check for duplicate
    if layer.nullifiers.contains(&nullifier) {
        return Err(PrivacyError::NullifierAlreadyUsed);
    }
    let payload_id = compute_payload_id(&commitment, &nullifier);
    layer.nullifiers.push(nullifier);
    layer.nullifier_root = compute_nullifier_root(&layer.nullifiers);
    layer.commitment = commitment;
    layer.payload_count += 1;
    Ok(ProtectedPayload {
        payload_id,
        commitment,
        nullifier,
        mainnet_ready: false,
    })
}

pub fn layer_public_record(layer: &PrivacyLayer) -> String {
    serde_json::json!({
        "layer_id":       hex32(&layer.layer_id),
        "nullifier_root": hex32(&layer.nullifier_root),
        "payload_count":  layer.payload_count,
        "mainnet_ready":  layer.mainnet_ready,
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
        let mut s = [0u8; 32];
        s[0] = b;
        s
    }

    // Test 1: new layer + protect
    #[test]
    fn test_new_layer_and_protect() {
        let mut layer = new_layer(&secret(0x11), &nonce(0x01)).unwrap();
        assert!(!layer.mainnet_ready);
        let pp = protect_payload(&mut layer, b"hello world").unwrap();
        assert_eq!(layer.payload_count, 1);
        assert!(!pp.mainnet_ready);
        assert_eq!(pp.payload_id.len(), 32);
    }

    // Test 2: duplicate payload rejected
    #[test]
    fn test_duplicate_payload_rejected() {
        let mut layer = new_layer(&secret(0x22), &nonce(0x01)).unwrap();
        protect_payload(&mut layer, b"same-payload").unwrap();
        let err = protect_payload(&mut layer, b"same-payload").unwrap_err();
        assert_eq!(err, PrivacyError::NullifierAlreadyUsed);
    }

    // Test 3: zero secret rejected
    #[test]
    fn test_zero_secret_rejected() {
        let err = new_layer(&[0u8; 32], &nonce(0x01)).unwrap_err();
        assert_eq!(err, PrivacyError::ZeroLayerSecret);
    }

    // Test 4: nullifier_root changes on protect
    #[test]
    fn test_nullifier_root_changes_on_protect() {
        let mut layer = new_layer(&secret(0x33), &nonce(0x01)).unwrap();
        let root_before = layer.nullifier_root;
        protect_payload(&mut layer, b"payload-a").unwrap();
        let root_after = layer.nullifier_root;
        assert_ne!(root_before, root_after);
        let root_mid = root_after;
        protect_payload(&mut layer, b"payload-b").unwrap();
        assert_ne!(root_mid, layer.nullifier_root);
    }

    // Test 5: layer_id deterministic
    #[test]
    fn test_layer_id_deterministic() {
        let layer1 = new_layer(&secret(0x44), &nonce(0x05)).unwrap();
        let layer2 = new_layer(&secret(0x44), &nonce(0x05)).unwrap();
        assert_eq!(layer1.layer_id, layer2.layer_id);
        // Different nonce → different layer_id
        let layer3 = new_layer(&secret(0x44), &nonce(0x06)).unwrap();
        assert_ne!(layer1.layer_id, layer3.layer_id);
    }

    // Test 6: public record hides secret
    #[test]
    fn test_public_record_hides_secret() {
        let layer = new_layer(&secret(0x55), &nonce(0x01)).unwrap();
        let record = layer_public_record(&layer);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["layer_id"].is_string());
        assert!(v["nullifier_root"].is_string());
        assert_eq!(v["payload_count"], 0);
        assert_eq!(v["mainnet_ready"], false);
        // layer_secret_hash must not appear
        assert!(v.get("layer_secret_hash").is_none());
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_layer_id_nonzero() {
        let layer = new_layer(&secret(0x01), &nonce(0x01)).unwrap();
        assert_ne!(layer.layer_id, [0u8; 32]);
    }

    #[test]
    fn test_mainnet_ready_false() {
        let layer = new_layer(&secret(0x02), &nonce(0x01)).unwrap();
        assert!(!layer.mainnet_ready);
    }

    #[test]
    fn test_protected_payload_mainnet_ready_false() {
        let mut layer = new_layer(&secret(0x03), &nonce(0x01)).unwrap();
        let pp = protect_payload(&mut layer, b"test").unwrap();
        assert!(!pp.mainnet_ready);
    }

    #[test]
    fn test_empty_payload_rejected() {
        let mut layer = new_layer(&secret(0x04), &nonce(0x01)).unwrap();
        let err = protect_payload(&mut layer, b"").unwrap_err();
        assert_eq!(err, PrivacyError::EmptyPayload);
    }

    #[test]
    fn test_commitment_nonzero_after_protect() {
        let mut layer = new_layer(&secret(0x05), &nonce(0x01)).unwrap();
        protect_payload(&mut layer, b"data").unwrap();
        assert_ne!(layer.commitment, [0u8; 32]);
    }

    #[test]
    fn test_nullifier_nonzero() {
        let mut layer = new_layer(&secret(0x06), &nonce(0x01)).unwrap();
        let pp = protect_payload(&mut layer, b"data").unwrap();
        assert_ne!(pp.nullifier, [0u8; 32]);
    }

    #[test]
    fn test_payload_id_nonzero() {
        let mut layer = new_layer(&secret(0x07), &nonce(0x01)).unwrap();
        let pp = protect_payload(&mut layer, b"data").unwrap();
        assert_ne!(pp.payload_id, [0u8; 32]);
    }

    #[test]
    fn test_different_secret_different_layer_id() {
        let l1 = new_layer(&secret(0x08), &nonce(0x01)).unwrap();
        let l2 = new_layer(&secret(0x09), &nonce(0x01)).unwrap();
        assert_ne!(l1.layer_id, l2.layer_id);
    }

    #[test]
    fn test_public_record_payload_count_increments() {
        let mut layer = new_layer(&secret(0x0A), &nonce(0x01)).unwrap();
        protect_payload(&mut layer, b"first").unwrap();
        protect_payload(&mut layer, b"second").unwrap();
        let v: serde_json::Value = serde_json::from_str(&layer_public_record(&layer)).unwrap();
        assert_eq!(v["payload_count"], 2u32);
    }

    #[test]
    fn test_payload_commitment_nonzero() {
        let mut layer = new_layer(&secret(0x0B), &nonce(0x01)).unwrap();
        let pp = protect_payload(&mut layer, b"content").unwrap();
        assert_ne!(pp.commitment, [0u8; 32]);
    }
}
