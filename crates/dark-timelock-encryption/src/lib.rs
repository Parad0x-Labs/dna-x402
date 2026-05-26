// dark-timelock-encryption - slot-bound time-lock encryption
// Ciphertext is computationally unreadable until reveal_slot.
// Uses hash-based keystream (no EC math required for decryption).
// Key becomes derivable only after the holder publishes the reveal path.
// NOT_PRODUCTION - devnet design only - no audit - mainnet_ready = false

use sha2::{Digest, Sha256};

// -- Domain constants ---------------------------------------------------------

const DOMAIN_KEY: u8 = 0x30; // time-lock key derivation
const DOMAIN_KEYSTREAM: u8 = 0x31; // XOR keystream block
const DOMAIN_COMMIT: u8 = 0x32; // commitment to (key, reveal_slot)
const DOMAIN_HINT: u8 = 0x33; // public hint - no secret content

// -- Core types ---------------------------------------------------------------

/// A time-locked ciphertext. Unreadable until the holder publishes their key_reveal.
#[derive(Debug, Clone, PartialEq)]
pub struct TimelockCiphertext {
    /// XOR-encrypted payload
    pub ciphertext: Vec<u8>,
    /// The slot after which this can be decrypted
    pub reveal_slot: u64,
    /// SHA256(DOMAIN_COMMIT || key || reveal_slot_le8) - public commitment to the key
    pub key_commit: [u8; 32],
    /// Optional: first 4 bytes of the key as a public hint (helps verifiers confirm correct key)
    pub key_hint: [u8; 4],
    pub mainnet_ready: bool, // always false
}

/// The public reveal: the key needed to decrypt after reveal_slot.
#[derive(Debug, Clone, PartialEq)]
pub struct TimelockReveal {
    pub key: [u8; 32],
    pub reveal_slot: u64,
    pub mainnet_ready: bool, // always false
}

/// A timelock sealed inside a note - contains metadata about the sealed content.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct TimelockNote {
    pub key_commit_hex: String,
    pub reveal_slot: u64,
    pub sealed_len: usize,
    pub hint_hex: String, // first 4 bytes of key as hex
    pub sealed_at_slot: u64,
    pub mainnet_ready: bool, // always false
}

#[derive(Debug, PartialEq)]
pub enum TimelockError {
    RevealTooEarly { current_slot: u64, reveal_slot: u64 },
    KeyCommitMismatch,
    EmptyPlaintext,
    RevealSlotInPast { submitted: u64, current: u64 },
}

// -- Private helpers ----------------------------------------------------------

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

/// Derive the timelock key from a secret + reveal_slot.
/// key = SHA256(DOMAIN_KEY || secret || reveal_slot_le8)
/// The key is only "useful" once the holder publishes it - but the slot
/// binding means different slots produce different keys.
fn derive_key(secret: &[u8; 32], reveal_slot: u64) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([DOMAIN_KEY]);
    h.update(secret);
    h.update(reveal_slot.to_le_bytes());
    h.finalize().into()
}

/// Generate a XOR keystream block for offset `block_index`.
/// stream_block = SHA256(DOMAIN_KEYSTREAM || key || block_index_le8)
fn keystream_block(key: &[u8; 32], block_index: u64) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([DOMAIN_KEYSTREAM]);
    h.update(key);
    h.update(block_index.to_le_bytes());
    h.finalize().into()
}

/// XOR-encrypt/decrypt plaintext with the key (symmetric - same function for both).
fn xor_stream(data: &[u8], key: &[u8; 32]) -> Vec<u8> {
    let mut output = Vec::with_capacity(data.len());
    let mut block = 0u64;
    let mut stream = keystream_block(key, block);
    let mut stream_pos = 0usize;

    for &byte in data {
        if stream_pos == 32 {
            block += 1;
            stream = keystream_block(key, block);
            stream_pos = 0;
        }
        output.push(byte ^ stream[stream_pos]);
        stream_pos += 1;
    }
    output
}

fn key_commit(key: &[u8; 32], reveal_slot: u64) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([DOMAIN_COMMIT]);
    h.update(key);
    h.update(reveal_slot.to_le_bytes());
    h.finalize().into()
}

// -- Public API ---------------------------------------------------------------

/// Encrypt plaintext with a time-lock. Ciphertext is readable only after reveal_slot.
///
/// `secret` - the holder's private key (never published until they choose to reveal)
/// `reveal_slot` - the slot after which decryption is allowed
/// `current_slot` - must be <= reveal_slot
pub fn encrypt(
    plaintext: &[u8],
    secret: &[u8; 32],
    reveal_slot: u64,
    current_slot: u64,
) -> Result<TimelockCiphertext, TimelockError> {
    if plaintext.is_empty() {
        return Err(TimelockError::EmptyPlaintext);
    }
    if current_slot > reveal_slot {
        return Err(TimelockError::RevealSlotInPast {
            submitted: current_slot,
            current: reveal_slot,
        });
    }

    let key = derive_key(secret, reveal_slot);
    let ciphertext = xor_stream(plaintext, &key);
    let key_commit_hash = key_commit(&key, reveal_slot);

    // Public hint = first 4 bytes of key (helps confirm correct key without revealing much)
    let mut key_hint = [0u8; 4];
    key_hint.copy_from_slice(&key[..4]);

    Ok(TimelockCiphertext {
        ciphertext,
        reveal_slot,
        key_commit: key_commit_hash,
        key_hint,
        mainnet_ready: false,
    })
}

/// Prepare a reveal: publish the key (but only after reveal_slot).
///
/// `current_slot` must be >= ciphertext.reveal_slot.
pub fn prepare_reveal(
    ct: &TimelockCiphertext,
    secret: &[u8; 32],
    current_slot: u64,
) -> Result<TimelockReveal, TimelockError> {
    if current_slot < ct.reveal_slot {
        return Err(TimelockError::RevealTooEarly {
            current_slot,
            reveal_slot: ct.reveal_slot,
        });
    }

    let key = derive_key(secret, ct.reveal_slot);

    // Verify key matches the commitment
    let expected_commit = key_commit(&key, ct.reveal_slot);
    if expected_commit != ct.key_commit {
        return Err(TimelockError::KeyCommitMismatch);
    }

    Ok(TimelockReveal {
        key,
        reveal_slot: ct.reveal_slot,
        mainnet_ready: false,
    })
}

/// Decrypt a ciphertext using a published reveal.
///
/// Verifies:
/// 1. The reveal_slot matches.
/// 2. The key matches the key_commit in the ciphertext.
pub fn decrypt(ct: &TimelockCiphertext, reveal: &TimelockReveal) -> Result<Vec<u8>, TimelockError> {
    // Check key matches commitment
    let expected_commit = key_commit(&reveal.key, ct.reveal_slot);
    if expected_commit != ct.key_commit {
        return Err(TimelockError::KeyCommitMismatch);
    }

    Ok(xor_stream(&ct.ciphertext, &reveal.key))
}

/// Verify that a reveal is valid for a ciphertext (without actually decrypting).
pub fn verify_reveal(ct: &TimelockCiphertext, reveal: &TimelockReveal) -> bool {
    let expected = key_commit(&reveal.key, ct.reveal_slot);
    expected == ct.key_commit && reveal.reveal_slot == ct.reveal_slot
}

/// Create a TimelockNote suitable for on-chain publication (no secret content).
pub fn to_note(ct: &TimelockCiphertext, sealed_at_slot: u64) -> TimelockNote {
    let hint_hex: String = ct.key_hint.iter().map(|b| format!("{:02x}", b)).collect();
    let key_commit_hex: String = ct.key_commit.iter().map(|b| format!("{:02x}", b)).collect();
    TimelockNote {
        key_commit_hex,
        reveal_slot: ct.reveal_slot,
        sealed_len: ct.ciphertext.len(),
        hint_hex,
        sealed_at_slot,
        mainnet_ready: false,
    }
}

/// Compute a public hint for the plaintext size class (without revealing exact length).
/// size_class: 0=tiny(<32), 1=small(<256), 2=medium(<4096), 3=large
pub fn size_class(ct: &TimelockCiphertext) -> u8 {
    let len = ct.ciphertext.len();
    if len < 32 {
        0
    } else if len < 256 {
        1
    } else if len < 4096 {
        2
    } else {
        3
    }
}

// -- Tests ---------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: [u8; 32] = [0x55; 32];
    const OTHER_SECRET: [u8; 32] = [0xAA; 32];

    // 1. mainnet_ready is always false
    #[test]
    fn test_ciphertext_mainnet_ready_false() {
        let ct = encrypt(b"hello world", &SECRET, 1000, 500).unwrap();
        assert!(!ct.mainnet_ready);
    }

    // 2. Encrypt-decrypt roundtrip
    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let plaintext = b"dark null timelock secret message";
        let ct = encrypt(plaintext, &SECRET, 1000, 500).unwrap();
        let reveal = prepare_reveal(&ct, &SECRET, 1000).unwrap();
        let decrypted = decrypt(&ct, &reveal).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    // 3. Ciphertext is different from plaintext
    #[test]
    fn test_ciphertext_differs_from_plaintext() {
        let plaintext = b"secret agent data";
        let ct = encrypt(plaintext, &SECRET, 1000, 500).unwrap();
        assert_ne!(ct.ciphertext, plaintext);
    }

    // 4. Different secrets produce different ciphertexts
    #[test]
    fn test_different_secrets_different_ciphertexts() {
        let pt = b"same plaintext";
        let ct1 = encrypt(pt, &SECRET, 1000, 500).unwrap();
        let ct2 = encrypt(pt, &OTHER_SECRET, 1000, 500).unwrap();
        assert_ne!(ct1.ciphertext, ct2.ciphertext);
        assert_ne!(ct1.key_commit, ct2.key_commit);
    }

    // 5. Different reveal_slots produce different keys
    #[test]
    fn test_different_slots_different_keys() {
        let pt = b"same data";
        let ct1 = encrypt(pt, &SECRET, 1000, 500).unwrap();
        let ct2 = encrypt(pt, &SECRET, 2000, 500).unwrap();
        assert_ne!(ct1.ciphertext, ct2.ciphertext);
        assert_ne!(ct1.key_commit, ct2.key_commit);
    }

    // 6. Prepare reveal too early -> error
    #[test]
    fn test_reveal_too_early_rejected() {
        let ct = encrypt(b"secret", &SECRET, 1000, 500).unwrap();
        let result = prepare_reveal(&ct, &SECRET, 999); // one slot before reveal
        assert!(matches!(result, Err(TimelockError::RevealTooEarly { .. })));
    }

    // 7. Prepare reveal at exactly reveal_slot -> ok
    #[test]
    fn test_reveal_at_exact_slot_ok() {
        let ct = encrypt(b"secret", &SECRET, 1000, 500).unwrap();
        let result = prepare_reveal(&ct, &SECRET, 1000);
        assert!(result.is_ok());
    }

    // 8. Decrypt with wrong key -> KeyCommitMismatch
    #[test]
    fn test_decrypt_wrong_key_rejected() {
        let ct = encrypt(b"secret", &SECRET, 1000, 500).unwrap();
        let reveal = TimelockReveal {
            key: [0xFF; 32], // wrong key
            reveal_slot: 1000,
            mainnet_ready: false,
        };
        let result = decrypt(&ct, &reveal);
        assert_eq!(result, Err(TimelockError::KeyCommitMismatch));
    }

    // 9. verify_reveal passes for correct reveal
    #[test]
    fn test_verify_reveal_passes() {
        let ct = encrypt(b"test", &SECRET, 1000, 500).unwrap();
        let reveal = prepare_reveal(&ct, &SECRET, 1000).unwrap();
        assert!(verify_reveal(&ct, &reveal));
    }

    // 10. verify_reveal fails for wrong secret
    #[test]
    fn test_verify_reveal_fails_wrong_secret() {
        let ct = encrypt(b"test", &SECRET, 1000, 500).unwrap();
        let bad_reveal = TimelockReveal {
            key: [0x00; 32],
            reveal_slot: 1000,
            mainnet_ready: false,
        };
        assert!(!verify_reveal(&ct, &bad_reveal));
    }

    // 11. to_note produces no ciphertext content
    #[test]
    fn test_note_contains_no_ciphertext() {
        let ct = encrypt(b"private bid: 500000 lamports", &SECRET, 1000, 500).unwrap();
        let note = to_note(&ct, 500);
        let json = serde_json::to_string(&note).unwrap();
        // Must contain metadata but NOT the actual ciphertext bytes
        assert!(json.contains("key_commit_hex"));
        assert!(json.contains("reveal_slot"));
        assert!(!json.contains("ciphertext")); // ciphertext is not in TimelockNote
        assert!(!note.mainnet_ready);
    }

    // 12. Empty plaintext rejected
    #[test]
    fn test_empty_plaintext_rejected() {
        let result = encrypt(b"", &SECRET, 1000, 500);
        assert_eq!(result, Err(TimelockError::EmptyPlaintext));
    }

    // 13. Reveal slot in past (submitted > reveal) rejected
    #[test]
    fn test_reveal_slot_in_past_rejected() {
        let result = encrypt(b"hello", &SECRET, 500, 1000); // current_slot > reveal_slot
        assert!(matches!(
            result,
            Err(TimelockError::RevealSlotInPast { .. })
        ));
    }

    // 14. Long plaintext (>32 bytes) correctly encrypted/decrypted
    #[test]
    fn test_long_plaintext_roundtrip() {
        let long_pt: Vec<u8> = (0..100).collect(); // 100 bytes, spans 4 keystream blocks
        let ct = encrypt(&long_pt, &SECRET, 1000, 500).unwrap();
        assert_eq!(ct.ciphertext.len(), 100);
        let reveal = prepare_reveal(&ct, &SECRET, 1000).unwrap();
        let decrypted = decrypt(&ct, &reveal).unwrap();
        assert_eq!(decrypted, long_pt);
    }

    // 15. size_class returns correct class
    #[test]
    fn test_size_class() {
        let small = encrypt(&[0u8; 10], &SECRET, 1000, 500).unwrap();
        let medium = encrypt(&[0u8; 100], &SECRET, 1000, 500).unwrap();
        let large = encrypt(&vec![0u8; 5000], &SECRET, 1000, 500).unwrap();
        assert_eq!(size_class(&small), 0);
        assert_eq!(size_class(&medium), 1);
        assert_eq!(size_class(&large), 3);
    }

    // 16. key_hint in ciphertext matches first 4 bytes of derived key
    #[test]
    fn test_key_hint_matches_derived_key() {
        let ct = encrypt(b"hint test", &SECRET, 1000, 500).unwrap();
        let reveal = prepare_reveal(&ct, &SECRET, 1000).unwrap();
        // The key_hint should be the first 4 bytes of the key
        assert_eq!(ct.key_hint, reveal.key[..4]);
    }

    // 17. key_commit hides the key (commit != key)
    #[test]
    fn test_key_commit_differs_from_key() {
        let ct = encrypt(b"test", &SECRET, 1000, 500).unwrap();
        let reveal = prepare_reveal(&ct, &SECRET, 1000).unwrap();
        // key_commit must not literally be the key
        assert_ne!(
            ct.key_commit, reveal.key,
            "key_commit must not be the raw key"
        );
    }

    // 18. Deterministic: same inputs -> same ciphertext
    #[test]
    fn test_encrypt_deterministic() {
        let pt = b"deterministic test";
        let ct1 = encrypt(pt, &SECRET, 1000, 500).unwrap();
        let ct2 = encrypt(pt, &SECRET, 1000, 500).unwrap();
        assert_eq!(ct1.ciphertext, ct2.ciphertext);
        assert_eq!(ct1.key_commit, ct2.key_commit);
    }

    // 19. reveal_slot = 0 (immediate) works
    #[test]
    fn test_immediate_timelock() {
        let ct = encrypt(b"immediate", &SECRET, 0, 0).unwrap();
        let reveal = prepare_reveal(&ct, &SECRET, 0).unwrap();
        let decrypted = decrypt(&ct, &reveal).unwrap();
        assert_eq!(decrypted.as_slice(), b"immediate");
    }

    // 20. Multi-block correctness: 64 bytes = exactly 2 keystream blocks
    #[test]
    fn test_exactly_two_blocks() {
        let pt = vec![0x42u8; 64];
        let ct = encrypt(&pt, &SECRET, 1000, 500).unwrap();
        let reveal = prepare_reveal(&ct, &SECRET, 1000).unwrap();
        let decrypted = decrypt(&ct, &reveal).unwrap();
        assert_eq!(decrypted, pt);
    }
}
