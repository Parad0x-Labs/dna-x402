use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedPayload {
    pub ciphertext: Vec<u8>,
    pub key_commitment: [u8; 32],
    pub n: u8,
    pub k: u8,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyShare {
    pub share_index: u8,
    pub share_hash: [u8; 32],
    pub partial_key: [u8; 32],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecryptResult {
    pub plaintext: Vec<u8>,
    pub verified: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ThresholdError {
    KGreaterThanN,
    NZero,
    KZero,
    InsufficientShares { need: u8, got: u8 },
    KeyCommitmentMismatch,
}

// ── Internal helpers ───────────────────────────────────────────────────────

fn sha256(data: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for chunk in data {
        h.update(chunk);
    }
    h.finalize().into()
}

fn xor32(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = a[i] ^ b[i];
    }
    out
}

fn derive_master_key(secret: &[u8; 32], nonce: &[u8; 32]) -> [u8; 32] {
    sha256(&[b"thresh-key-v1", secret, nonce])
}

fn derive_keystream(master_key: &[u8; 32]) -> [u8; 32] {
    sha256(&[b"thresh-cipher-v1", master_key])
}

fn derive_commitment(master_key: &[u8; 32]) -> [u8; 32] {
    sha256(&[b"thresh-commit-v1", master_key])
}

fn derive_partial_key(master_key: &[u8; 32], index: u8) -> [u8; 32] {
    sha256(&[b"thresh-share-v1", master_key, &[index]])
}

fn derive_share_hash(partial_key: &[u8; 32], index: u8) -> [u8; 32] {
    sha256(&[b"thresh-share-hash-v1", partial_key, &[index]])
}

fn xor_encrypt(keystream: &[u8; 32], plaintext: &[u8]) -> Vec<u8> {
    // XOR each byte of plaintext with the keystream, cycling keystream for
    // messages longer than 32 bytes (or truncating for shorter).
    let len = plaintext.len();
    let mut ct = vec![0u8; len];
    for (i, &b) in plaintext.iter().enumerate() {
        ct[i] = b ^ keystream[i % 32];
    }
    ct
}

// ── Public API ─────────────────────────────────────────────────────────────

/// Encrypt `plaintext` and split the master key into `n` shares.
/// Currently implements a k=n (all-shares-required) scheme.
/// `mainnet_ready` is always `false`.
pub fn encrypt(
    plaintext: &[u8],
    secret: &[u8; 32],
    nonce: &[u8; 32],
    n: u8,
    k: u8,
) -> Result<(EncryptedPayload, Vec<KeyShare>), ThresholdError> {
    if n == 0 {
        return Err(ThresholdError::NZero);
    }
    if k == 0 {
        return Err(ThresholdError::KZero);
    }
    if k > n {
        return Err(ThresholdError::KGreaterThanN);
    }

    let master_key = derive_master_key(secret, nonce);
    let keystream = derive_keystream(&master_key);
    let ciphertext = xor_encrypt(&keystream, plaintext);
    let key_commitment = derive_commitment(&master_key);

    // Build n shares:
    //   shares 0..n-2 are hash-derived from master_key
    //   share n-1 is chosen so that XOR of all partial_keys == master_key
    let n_usize = n as usize;
    let mut partial_keys: Vec<[u8; 32]> = Vec::with_capacity(n_usize);

    for i in 0..(n_usize - 1) {
        partial_keys.push(derive_partial_key(&master_key, i as u8));
    }

    // XOR-fold the first n-1 keys
    let mut xor_others = [0u8; 32];
    for pk in &partial_keys {
        xor_others = xor32(&xor_others, pk);
    }
    // last share = master_key XOR XOR_fold(all others)
    let last_partial = xor32(&master_key, &xor_others);
    partial_keys.push(last_partial);

    // Build KeyShare structs
    let shares: Vec<KeyShare> = partial_keys
        .iter()
        .enumerate()
        .map(|(i, pk)| {
            let idx = i as u8;
            KeyShare {
                share_index: idx,
                share_hash: derive_share_hash(pk, idx),
                partial_key: *pk,
            }
        })
        .collect();

    let payload = EncryptedPayload {
        ciphertext,
        key_commitment,
        n,
        k,
        mainnet_ready: false,
    };

    Ok((payload, shares))
}

/// Reconstruct the master key from shares. Requires exactly `n` shares
/// (all-shares XOR scheme). Returns `InsufficientShares` if fewer supplied.
pub fn reconstruct_key(shares: &[KeyShare], n: u8) -> Result<[u8; 32], ThresholdError> {
    if shares.len() < n as usize {
        return Err(ThresholdError::InsufficientShares {
            need: n,
            got: shares.len() as u8,
        });
    }

    // XOR all partial_keys to recover master_key
    let mut master_key = [0u8; 32];
    for share in shares.iter().take(n as usize) {
        master_key = xor32(&master_key, &share.partial_key);
    }
    Ok(master_key)
}

/// Decrypt `payload` using the provided shares.
/// Verifies key commitment before returning plaintext.
/// `mainnet_ready` is always `false`.
pub fn decrypt(
    payload: &EncryptedPayload,
    shares: &[KeyShare],
) -> Result<DecryptResult, ThresholdError> {
    let master_key = reconstruct_key(shares, payload.n)?;

    let computed_commitment = derive_commitment(&master_key);
    if computed_commitment != payload.key_commitment {
        return Err(ThresholdError::KeyCommitmentMismatch);
    }

    let keystream = derive_keystream(&master_key);
    // XOR decryption is its own inverse
    let plaintext = xor_encrypt(&keystream, &payload.ciphertext);

    Ok(DecryptResult {
        plaintext,
        verified: true,
        mainnet_ready: false,
    })
}

/// Returns a JSON string containing `share_index` and `share_hash` (hex).
/// Does NOT include `partial_key`.
pub fn share_public_record(share: &KeyShare) -> String {
    let hash_hex = hex_encode(&share.share_hash);
    serde_json::json!({
        "share_index": share.share_index,
        "share_hash": hash_hex,
    })
    .to_string()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: [u8; 32] = [0xAB; 32];
    const NONCE: [u8; 32] = [0xCD; 32];

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let plaintext = b"hello dark threshold world!";
        let (payload, shares) = encrypt(plaintext, &SECRET, &NONCE, 3, 3).unwrap();
        assert_eq!(payload.n, 3);
        assert_eq!(payload.k, 3);
        assert!(!payload.mainnet_ready);

        let result = decrypt(&payload, &shares).unwrap();
        assert_eq!(result.plaintext, plaintext);
        assert!(result.verified);
        assert!(!result.mainnet_ready);
    }

    #[test]
    fn test_insufficient_shares_rejected() {
        let plaintext = b"test message";
        let (payload, shares) = encrypt(plaintext, &SECRET, &NONCE, 3, 3).unwrap();

        // Provide only 2 of 3 shares
        let partial_shares = &shares[..2];
        let err = decrypt(&payload, partial_shares).unwrap_err();
        assert_eq!(
            err,
            ThresholdError::InsufficientShares { need: 3, got: 2 }
        );
    }

    #[test]
    fn test_k_greater_than_n_rejected() {
        let err = encrypt(b"data", &SECRET, &NONCE, 3, 4).unwrap_err();
        assert_eq!(err, ThresholdError::KGreaterThanN);
    }

    #[test]
    fn test_n_zero_rejected() {
        let err = encrypt(b"data", &SECRET, &NONCE, 0, 0).unwrap_err();
        assert_eq!(err, ThresholdError::NZero);
    }

    #[test]
    fn test_share_hashes_unique() {
        let (_payload, shares) = encrypt(b"uniqueness test", &SECRET, &NONCE, 5, 5).unwrap();
        let hashes: Vec<[u8; 32]> = shares.iter().map(|s| s.share_hash).collect();
        for i in 0..hashes.len() {
            for j in (i + 1)..hashes.len() {
                assert_ne!(
                    hashes[i], hashes[j],
                    "Share hashes at index {} and {} collide",
                    i, j
                );
            }
        }
    }

    #[test]
    fn test_public_record_hides_partial_key() {
        let (_payload, shares) = encrypt(b"secret data", &SECRET, &NONCE, 2, 2).unwrap();
        for share in &shares {
            let record = share_public_record(share);
            let partial_key_hex = hex_encode(&share.partial_key);
            assert!(
                !record.contains(&partial_key_hex),
                "public record unexpectedly contains partial_key hex for share {}",
                share.share_index
            );
        }
    }
}
