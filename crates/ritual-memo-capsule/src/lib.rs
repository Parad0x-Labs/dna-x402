//! Ritual Memo Capsule — hash-only memo payloads for Token-2022 MemoTransfer.
//! No raw URLs. No raw buyer identity. Hash-only.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoCapsule {
    pub ritual_hash: [u8; 32],
    pub permission_hash: [u8; 32],
    pub receipt_hash: [u8; 32],
    pub service_scope_hash: [u8; 32],
    pub expires_at_slot: u64,
    pub redaction_policy_hash: [u8; 32],
}

#[derive(Debug, PartialEq)]
pub enum MemoCapsuleError {
    RawUrlDetected,
    RawBuyerIdentity,
    TooLong,
    InvalidHex,
    Empty,
}

// ── Core functions ────────────────────────────────────────────────────────────

/// Deterministic byte serialization: all fields concatenated in declaration order.
pub fn canonical_bytes(capsule: &MemoCapsule) -> Vec<u8> {
    let mut out = Vec::with_capacity(32 * 5 + 8);
    out.extend_from_slice(&capsule.ritual_hash);
    out.extend_from_slice(&capsule.permission_hash);
    out.extend_from_slice(&capsule.receipt_hash);
    out.extend_from_slice(&capsule.service_scope_hash);
    out.extend_from_slice(&capsule.expires_at_slot.to_le_bytes());
    out.extend_from_slice(&capsule.redaction_policy_hash);
    out
}

/// SHA256 of canonical_bytes.
pub fn capsule_hash(capsule: &MemoCapsule) -> [u8; 32] {
    let bytes = canonical_bytes(capsule);
    let mut h = Sha256::new();
    h.update(&bytes);
    h.finalize().into()
}

/// The memo string we put on-chain: hex(capsule_hash) — 64 chars, nothing else.
pub fn capsule_to_memo_string(capsule: &MemoCapsule) -> String {
    let hash = capsule_hash(capsule);
    hash.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Validate a memo string:
/// - must be exactly 64 chars
/// - must be valid lowercase hex
/// - must NOT contain "http", "//", "@", space, or "buyer"
/// Returns Ok if valid.
pub fn validate_memo_string(s: &str) -> Result<(), MemoCapsuleError> {
    if s.is_empty() {
        return Err(MemoCapsuleError::Empty);
    }
    if s.len() > 64 {
        return Err(MemoCapsuleError::TooLong);
    }
    if s.len() != 64 {
        return Err(MemoCapsuleError::InvalidHex);
    }
    // Forbidden patterns — check before hex validation so pattern errors take precedence
    let lower = s.to_lowercase();
    if lower.contains("http") {
        return Err(MemoCapsuleError::RawUrlDetected);
    }
    if lower.contains("//") {
        return Err(MemoCapsuleError::RawUrlDetected);
    }
    if lower.contains('@') {
        return Err(MemoCapsuleError::RawBuyerIdentity);
    }
    if lower.contains(' ') {
        return Err(MemoCapsuleError::RawBuyerIdentity);
    }
    if lower.contains("buyer") {
        return Err(MemoCapsuleError::RawBuyerIdentity);
    }
    // Must be valid lowercase hex (all digits or a-f only)
    if !s.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
        return Err(MemoCapsuleError::InvalidHex);
    }
    Ok(())
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn test_capsule() -> MemoCapsule {
        MemoCapsule {
            ritual_hash: [1u8; 32],
            permission_hash: [2u8; 32],
            receipt_hash: [3u8; 32],
            service_scope_hash: [4u8; 32],
            expires_at_slot: 9_999_999,
            redaction_policy_hash: [5u8; 32],
        }
    }

    #[test]
    fn test_capsule_hash_deterministic() {
        let c1 = test_capsule();
        let c2 = test_capsule();
        assert_eq!(capsule_hash(&c1), capsule_hash(&c2));
    }

    #[test]
    fn test_capsule_hash_changes_with_ritual_hash() {
        let c1 = test_capsule();
        let mut c2 = test_capsule();
        c2.ritual_hash = [0xab; 32];
        assert_ne!(capsule_hash(&c1), capsule_hash(&c2));
    }

    #[test]
    fn test_capsule_hash_changes_with_scope() {
        let c1 = test_capsule();
        let mut c2 = test_capsule();
        c2.service_scope_hash = [0xcd; 32];
        assert_ne!(capsule_hash(&c1), capsule_hash(&c2));
    }

    #[test]
    fn test_memo_string_is_64_char_hex() {
        let c = test_capsule();
        let memo = capsule_to_memo_string(&c);
        assert_eq!(memo.len(), 64);
        assert!(memo.chars().all(|ch| ch.is_ascii_hexdigit()));
        // must be lowercase
        assert_eq!(memo, memo.to_lowercase());
    }

    #[test]
    fn test_raw_url_rejected() {
        // 64-char string that contains "http" — triggers RawUrlDetected before hex check
        // "http" = 4 chars, padded to 64 with '0'
        let bad = "http000000000000000000000000000000000000000000000000000000000000";
        assert_eq!(bad.len(), 64, "test string must be exactly 64 chars");
        assert_eq!(
            validate_memo_string(bad),
            Err(MemoCapsuleError::RawUrlDetected)
        );
    }

    #[test]
    fn test_https_rejected() {
        // Build a 64-char string that contains "http"
        let s = "httpAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        assert_eq!(s.len(), 64);
        assert_eq!(
            validate_memo_string(s),
            Err(MemoCapsuleError::RawUrlDetected)
        );
    }

    #[test]
    fn test_raw_buyer_identity_rejected() {
        // A 64-char string where the last char is '@' — length is ok but @ is forbidden
        let mut s = "a".repeat(63);
        s.push('@');
        assert_eq!(s.len(), 64);
        assert_eq!(
            validate_memo_string(&s),
            Err(MemoCapsuleError::RawBuyerIdentity)
        );
    }

    #[test]
    fn test_too_long_rejected() {
        let s = "a".repeat(65);
        assert_eq!(validate_memo_string(&s), Err(MemoCapsuleError::TooLong));
    }

    #[test]
    fn test_valid_64_char_hex_accepted() {
        let c = test_capsule();
        let memo = capsule_to_memo_string(&c);
        assert_eq!(validate_memo_string(&memo), Ok(()));
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_capsule_hash_nonzero() {
        let c = test_capsule();
        assert_ne!(capsule_hash(&c), [0u8; 32]);
    }

    #[test]
    fn test_capsule_hash_receipt_sensitive() {
        let c1 = test_capsule();
        let mut c2 = test_capsule();
        c2.receipt_hash = [0xFEu8; 32];
        assert_ne!(capsule_hash(&c1), capsule_hash(&c2));
    }

    #[test]
    fn test_canonical_bytes_length() {
        let c = test_capsule();
        // 5 × 32-byte fields + 8-byte u64 = 168 bytes
        assert_eq!(canonical_bytes(&c).len(), 168);
    }

    #[test]
    fn test_empty_memo_rejected() {
        assert_eq!(validate_memo_string(""), Err(MemoCapsuleError::Empty));
    }

    #[test]
    fn test_memo_with_space_rejected() {
        // 63 lowercase hex chars + space = 64 chars total → RawBuyerIdentity
        let mut s = "a".repeat(63);
        s.push(' ');
        assert_eq!(s.len(), 64);
        assert_eq!(
            validate_memo_string(&s),
            Err(MemoCapsuleError::RawBuyerIdentity)
        );
    }

    #[test]
    fn test_memo_with_double_slash_rejected() {
        // "//" embedded in a 64-char string → RawUrlDetected
        let s = format!("//{}", "0".repeat(62));
        assert_eq!(s.len(), 64);
        assert_eq!(
            validate_memo_string(&s),
            Err(MemoCapsuleError::RawUrlDetected)
        );
    }

    #[test]
    fn test_capsule_hash_expires_sensitive() {
        let c1 = test_capsule();
        let mut c2 = test_capsule();
        c2.expires_at_slot = c1.expires_at_slot + 1;
        assert_ne!(capsule_hash(&c1), capsule_hash(&c2));
    }
}
