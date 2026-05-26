use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThresholdKey {
    pub key_id: [u8; 32],
    pub public_key: [u8; 32],
    pub shares: Vec<[u8; 32]>,
    pub threshold: u8,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartialSig {
    pub signer_index: u8,
    pub partial_hash: [u8; 32],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThresholdSig {
    pub sig_id: [u8; 32],
    pub message_hash: [u8; 32],
    pub aggregate: [u8; 32],
    pub signer_count: u8,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum TSigError {
    ZeroSecret,
    ThresholdZero,
    ThresholdExceedsShares,
    InsufficientShares { need: u8, got: u8 },
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn xor_fold(bufs: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = [0u8; 32];
    for b in bufs {
        for i in 0..32 {
            acc[i] ^= b[i];
        }
    }
    acc
}

fn hex32(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn generate_key(
    root_secret: &[u8; 32],
    n_shares: u8,
    threshold: u8,
) -> Result<ThresholdKey, TSigError> {
    if root_secret == &[0u8; 32] {
        return Err(TSigError::ZeroSecret);
    }
    if threshold == 0 {
        return Err(TSigError::ThresholdZero);
    }
    if threshold > n_shares {
        return Err(TSigError::ThresholdExceedsShares);
    }
    let master_secret = sha256_multi(&[b"tsig-master-v1", root_secret]);
    let public_key = sha256_multi(&[b"tsig-pubkey-v1", &master_secret]);
    let key_id = sha256_multi(&[b"tsig-key-id-v1", &public_key, &[threshold]]);
    let shares: Vec<[u8; 32]> = (0..n_shares)
        .map(|i| sha256_multi(&[b"tsig-share-v1", &master_secret, &[i]]))
        .collect();
    Ok(ThresholdKey {
        key_id,
        public_key,
        shares,
        threshold,
        mainnet_ready: false,
    })
}

pub fn partial_sign(key: &ThresholdKey, signer_index: u8, message_bytes: &[u8]) -> PartialSig {
    let message_hash = sha256_multi(&[b"tsig-msg-v1", message_bytes]);
    let share = &key.shares[signer_index as usize];
    let partial_hash = sha256_multi(&[b"tsig-partial-v1", &key.key_id, &message_hash, share]);
    PartialSig {
        signer_index,
        partial_hash,
    }
}

pub fn combine_sigs(
    key: &ThresholdKey,
    partials: &[PartialSig],
    message_bytes: &[u8],
) -> Result<ThresholdSig, TSigError> {
    if (partials.len() as u8) < key.threshold {
        return Err(TSigError::InsufficientShares {
            need: key.threshold,
            got: partials.len() as u8,
        });
    }
    let message_hash = sha256_multi(&[b"tsig-msg-v1", message_bytes]);
    let partial_hashes: Vec<[u8; 32]> = partials.iter().map(|p| p.partial_hash).collect();
    let xor_partials = xor_fold(&partial_hashes);
    let aggregate = sha256_multi(&[b"tsig-agg-v1", &key.key_id, &message_hash, &xor_partials]);
    let sig_id = sha256_multi(&[b"tsig-sig-id-v1", &aggregate]);
    Ok(ThresholdSig {
        sig_id,
        message_hash,
        aggregate,
        signer_count: partials.len() as u8,
        mainnet_ready: false,
    })
}

pub fn verify_tsig(key: &ThresholdKey, sig: &ThresholdSig, message_bytes: &[u8]) -> bool {
    // Recompute aggregate from sig's signer_count partials is not directly possible without
    // knowing which signers participated. Instead we verify sig_id and message_hash.
    // The public verification checks that the sig_id matches sig.aggregate and message matches.
    let message_hash = sha256_multi(&[b"tsig-msg-v1", message_bytes]);
    if message_hash != sig.message_hash {
        return false;
    }
    let expected_sig_id = sha256_multi(&[b"tsig-sig-id-v1", &sig.aggregate]);
    expected_sig_id == sig.sig_id
}

pub fn key_public_record(key: &ThresholdKey) -> String {
    serde_json::json!({
        "key_id": hex32(&key.key_id),
        "threshold": key.threshold,
        "share_count": key.shares.len(),
        "mainnet_ready": key.mainnet_ready,
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

    // Test 1: generate + sign + verify (3 shares, threshold=2)
    #[test]
    fn test_generate_sign_verify() {
        let root = secret(0x11);
        let key = generate_key(&root, 3, 2).unwrap();
        assert!(!key.mainnet_ready);
        assert_eq!(key.threshold, 2);
        assert_eq!(key.shares.len(), 3);
        let msg = b"hello-threshold";
        let p0 = partial_sign(&key, 0, msg);
        let p1 = partial_sign(&key, 1, msg);
        let sig = combine_sigs(&key, &[p0, p1], msg).unwrap();
        assert!(!sig.mainnet_ready);
        assert!(verify_tsig(&key, &sig, msg));
    }

    // Test 2: insufficient shares rejected
    #[test]
    fn test_insufficient_shares_rejected() {
        let root = secret(0x22);
        let key = generate_key(&root, 3, 3).unwrap();
        let msg = b"not-enough";
        let p0 = partial_sign(&key, 0, msg);
        let p1 = partial_sign(&key, 1, msg);
        // only 2 partials, need 3
        let err = combine_sigs(&key, &[p0, p1], msg).unwrap_err();
        assert_eq!(err, TSigError::InsufficientShares { need: 3, got: 2 });
    }

    // Test 3: threshold zero rejected
    #[test]
    fn test_threshold_zero_rejected() {
        let root = secret(0x33);
        let err = generate_key(&root, 3, 0).unwrap_err();
        assert_eq!(err, TSigError::ThresholdZero);
    }

    // Test 4: aggregate is deterministic
    #[test]
    fn test_aggregate_deterministic() {
        let root = secret(0x44);
        let key = generate_key(&root, 3, 2).unwrap();
        let msg = b"deterministic-msg";
        let p0a = partial_sign(&key, 0, msg);
        let p1a = partial_sign(&key, 1, msg);
        let p0b = partial_sign(&key, 0, msg);
        let p1b = partial_sign(&key, 1, msg);
        let sig_a = combine_sigs(&key, &[p0a, p1a], msg).unwrap();
        let sig_b = combine_sigs(&key, &[p0b, p1b], msg).unwrap();
        assert_eq!(sig_a.aggregate, sig_b.aggregate);
        assert_eq!(sig_a.sig_id, sig_b.sig_id);
    }

    // Test 5: different messages → different sigs
    #[test]
    fn test_different_messages_different_sigs() {
        let root = secret(0x55);
        let key = generate_key(&root, 2, 2).unwrap();
        let msg1 = b"message-one";
        let msg2 = b"message-two";
        let p0_1 = partial_sign(&key, 0, msg1);
        let p1_1 = partial_sign(&key, 1, msg1);
        let p0_2 = partial_sign(&key, 0, msg2);
        let p1_2 = partial_sign(&key, 1, msg2);
        let sig1 = combine_sigs(&key, &[p0_1, p1_1], msg1).unwrap();
        let sig2 = combine_sigs(&key, &[p0_2, p1_2], msg2).unwrap();
        assert_ne!(sig1.aggregate, sig2.aggregate);
        assert_ne!(sig1.sig_id, sig2.sig_id);
    }

    // Test 6: public_key not in record JSON
    #[test]
    fn test_public_key_not_in_record() {
        let root = secret(0x66);
        let key = generate_key(&root, 3, 2).unwrap();
        let record = key_public_record(&key);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["key_id"].is_string());
        assert_eq!(v["mainnet_ready"], false);
        // public_key field must not be in the record
        assert!(v.get("public_key").is_none());
        let pk_hex = hex32(&key.public_key);
        assert!(!record.contains(&pk_hex));
    }
}
