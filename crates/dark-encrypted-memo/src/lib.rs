use sha2::{Digest, Sha256};

/// Encrypted on-chain memo. Only the ciphertext commitment and metadata are
/// safe to publish; the ciphertext itself should be treated as sensitive until
/// the sender chooses to share it.
#[derive(Debug, Clone, PartialEq)]
pub struct EncryptedMemo {
    /// SHA256("memo-commit-v1" || ciphertext)
    pub ciphertext_commitment: [u8; 32],
    /// XOR of plaintext with keystream derived from shared_secret + sender_pubkey
    pub ciphertext: Vec<u8>,
    /// SHA256("memo-nonce-v1" || shared_secret) — used for key derivation
    pub nonce_commitment: [u8; 32],
    pub sender_pubkey: [u8; 32],
    pub sent_at_unix: i64,
    pub mainnet_ready: bool,
}

/// Plaintext memo recovered after successful decryption.
#[derive(Debug, Clone, PartialEq)]
pub struct DecryptedMemo {
    pub plaintext: Vec<u8>,
    pub sender_pubkey: [u8; 32],
    pub sent_at_unix: i64,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum MemoError {
    EmptyMemo,
    DecryptionFailed,
    WrongSharedSecret,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

fn derive_sender_pubkey(sender_secret: &[u8; 32]) -> [u8; 32] {
    let mut input = b"memo-sender-v1".to_vec();
    input.extend_from_slice(sender_secret);
    sha256(&input)
}

fn derive_keystream(shared_secret: &[u8; 32], sender_pubkey: &[u8; 32]) -> [u8; 32] {
    let mut input = b"memo-key-v1".to_vec();
    input.extend_from_slice(shared_secret);
    input.extend_from_slice(sender_pubkey);
    sha256(&input)
}

fn derive_nonce_commitment(shared_secret: &[u8; 32]) -> [u8; 32] {
    let mut input = b"memo-nonce-v1".to_vec();
    input.extend_from_slice(shared_secret);
    sha256(&input)
}

fn commit_ciphertext(ciphertext: &[u8]) -> [u8; 32] {
    let mut input = b"memo-commit-v1".to_vec();
    input.extend_from_slice(ciphertext);
    sha256(&input)
}

fn xor_with_keystream(data: &[u8], keystream: &[u8; 32]) -> Vec<u8> {
    data.iter()
        .enumerate()
        .map(|(i, &b)| b ^ keystream[i % 32])
        .collect()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Encrypt a plaintext memo for a recipient who shares `shared_secret` with
/// the sender.
///
/// Returns `Err(MemoError::EmptyMemo)` if `plaintext` is empty.
pub fn encrypt_memo(
    plaintext: &[u8],
    shared_secret: &[u8; 32],
    sender_secret: &[u8; 32],
    sent_at_unix: i64,
) -> Result<EncryptedMemo, MemoError> {
    if plaintext.is_empty() {
        return Err(MemoError::EmptyMemo);
    }

    let sender_pubkey = derive_sender_pubkey(sender_secret);
    let keystream = derive_keystream(shared_secret, &sender_pubkey);
    let ciphertext = xor_with_keystream(plaintext, &keystream);
    let nonce_commitment = derive_nonce_commitment(shared_secret);
    let ciphertext_commitment = commit_ciphertext(&ciphertext);

    Ok(EncryptedMemo {
        ciphertext_commitment,
        ciphertext,
        nonce_commitment,
        sender_pubkey,
        sent_at_unix,
        mainnet_ready: false,
    })
}

/// Decrypt a memo using the shared secret.
///
/// Returns `Err(MemoError::WrongSharedSecret)` if the nonce commitment derived
/// from the provided `shared_secret` does not match the stored one, indicating
/// the wrong secret was supplied.
pub fn decrypt_memo(
    memo: &EncryptedMemo,
    shared_secret: &[u8; 32],
) -> Result<DecryptedMemo, MemoError> {
    // Verify the caller knows the correct shared secret by checking the nonce
    // commitment: SHA256("memo-nonce-v1" || shared_secret) must match the
    // value stored at encryption time.
    let expected_nonce_commitment = derive_nonce_commitment(shared_secret);
    if expected_nonce_commitment != memo.nonce_commitment {
        return Err(MemoError::WrongSharedSecret);
    }

    let keystream = derive_keystream(shared_secret, &memo.sender_pubkey);
    let plaintext = xor_with_keystream(&memo.ciphertext, &keystream);

    Ok(DecryptedMemo {
        plaintext,
        sender_pubkey: memo.sender_pubkey,
        sent_at_unix: memo.sent_at_unix,
        mainnet_ready: false,
    })
}

/// Return `true` iff the ciphertext commitment in the memo is consistent with
/// the stored ciphertext bytes.
pub fn verify_memo_integrity(memo: &EncryptedMemo) -> bool {
    let expected = commit_ciphertext(&memo.ciphertext);
    expected == memo.ciphertext_commitment
}

/// Return a JSON string containing only the fields safe to publish on-chain.
/// Does NOT include the raw ciphertext bytes or the shared secret.
pub fn memo_public_record(memo: &EncryptedMemo) -> String {
    serde_json::json!({
        "ciphertext_commitment": hex_encode(&memo.ciphertext_commitment),
        "sender_pubkey": hex_encode(&memo.sender_pubkey),
        "sent_at_unix": memo.sent_at_unix,
        "mainnet_ready": memo.mainnet_ready,
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const SHARED_SECRET: [u8; 32] = [0xAB; 32];
    const SENDER_SECRET: [u8; 32] = [0x01; 32];
    const PLAINTEXT: &[u8] = b"hello dark memo";

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let memo = encrypt_memo(PLAINTEXT, &SHARED_SECRET, &SENDER_SECRET, 1_700_000_000)
            .expect("encryption should succeed");

        assert_eq!(memo.mainnet_ready, false);

        let decrypted = decrypt_memo(&memo, &SHARED_SECRET)
            .expect("decryption should succeed");

        assert_eq!(decrypted.plaintext, PLAINTEXT);
        assert_eq!(decrypted.sender_pubkey, memo.sender_pubkey);
        assert_eq!(decrypted.sent_at_unix, 1_700_000_000);
        assert_eq!(decrypted.mainnet_ready, false);
    }

    #[test]
    fn test_empty_memo_rejected() {
        let result = encrypt_memo(b"", &SHARED_SECRET, &SENDER_SECRET, 0);
        assert_eq!(result, Err(MemoError::EmptyMemo));
    }

    #[test]
    fn test_wrong_shared_secret_fails() {
        let memo = encrypt_memo(PLAINTEXT, &SHARED_SECRET, &SENDER_SECRET, 0)
            .expect("encryption should succeed");

        let wrong_secret = [0xFF; 32];
        let result = decrypt_memo(&memo, &wrong_secret);
        assert_eq!(result, Err(MemoError::WrongSharedSecret));
    }

    #[test]
    fn test_verify_integrity_passes() {
        let memo = encrypt_memo(PLAINTEXT, &SHARED_SECRET, &SENDER_SECRET, 0)
            .expect("encryption should succeed");

        assert!(verify_memo_integrity(&memo));
    }

    #[test]
    fn test_different_senders_different_ciphertext() {
        let sender_secret_b: [u8; 32] = [0x02; 32];

        let memo_a = encrypt_memo(PLAINTEXT, &SHARED_SECRET, &SENDER_SECRET, 0)
            .expect("encryption A should succeed");
        let memo_b = encrypt_memo(PLAINTEXT, &SHARED_SECRET, &sender_secret_b, 0)
            .expect("encryption B should succeed");

        assert_ne!(
            memo_a.ciphertext, memo_b.ciphertext,
            "different sender secrets must produce different ciphertexts"
        );
        assert_ne!(
            memo_a.sender_pubkey, memo_b.sender_pubkey,
            "different sender secrets must produce different sender pubkeys"
        );
    }

    #[test]
    fn test_public_record_hides_plaintext() {
        let memo = encrypt_memo(PLAINTEXT, &SHARED_SECRET, &SENDER_SECRET, 0)
            .expect("encryption should succeed");

        let record = memo_public_record(&memo);

        // The raw plaintext must not appear in the public record.
        let plaintext_str = std::str::from_utf8(PLAINTEXT).unwrap();
        assert!(
            !record.contains(plaintext_str),
            "public record must not contain raw plaintext"
        );

        // The shared secret must not appear either.
        let secret_hex = hex_encode(&SHARED_SECRET);
        assert!(
            !record.contains(&secret_hex),
            "public record must not contain shared secret"
        );

        // Sanity: the record is valid JSON containing the expected keys.
        let parsed: serde_json::Value =
            serde_json::from_str(&record).expect("public record must be valid JSON");
        assert!(parsed["ciphertext_commitment"].is_string());
        assert!(parsed["sender_pubkey"].is_string());
        assert!(parsed["sent_at_unix"].is_number());
        assert_eq!(parsed["mainnet_ready"], false);
    }
}
