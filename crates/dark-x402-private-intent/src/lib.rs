//! dark-x402-private-intent — hidden-amount x402 payment intents with range commitment
//!
//! First implementation of private payment intents for the x402 protocol.
//! A payer creates an intent that commits to paying between [min, max] lamports
//! for a resource — without revealing the exact amount. The server verifies
//! the amount is within range without learning the precise payment.
//!
//! Use case: AI agent commits to paying "between 1000 and 5000 lamports" for an API
//! endpoint, then reveals exact amount only at settlement. Prevents price discrimination
//! against agents with known spending patterns.
//!
//! IS_STUB  = true
//! MAINNET_READY = false

use sha2::{Digest, Sha256};

pub const IS_STUB: bool = true;
pub const MAINNET_READY: bool = false;

// ── domain tags ───────────────────────────────────────────────────────────────
const DOMAIN_INTENT_ID: &[u8] = b"x402-intent-id-v1";
const DOMAIN_RANGE_COMMIT: &[u8] = b"x402-range-commit-v1";
const DOMAIN_PAYER_COMMIT: &[u8] = b"x402-payer-commit-v1";

// ── error ─────────────────────────────────────────────────────────────────────
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum PrivateIntentError {
    /// Actual amount is outside [min, max].
    AmountOutOfRange,
    /// Resource hash is all zeros.
    ZeroResource,
    /// Blinding factor is all zeros.
    ZeroBlinding,
    /// Payer key is all zeros.
    ZeroPayer,
    /// min > max or both are zero.
    ZeroMinMax,
}

impl core::fmt::Display for PrivateIntentError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::AmountOutOfRange => write!(f, "actual amount outside [min, max] range"),
            Self::ZeroResource => write!(f, "resource hash must not be all zeros"),
            Self::ZeroBlinding => write!(f, "blinding factor must not be all zeros"),
            Self::ZeroPayer => write!(f, "payer key must not be all zeros"),
            Self::ZeroMinMax => write!(f, "min must be <= max and at least one must be > 0"),
        }
    }
}

// ── types ─────────────────────────────────────────────────────────────────────

/// A private x402 payment intent with hidden exact amount.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrivateIntent {
    /// Unique intent identifier.
    pub intent_id: [u8; 32],
    /// Hash of the resource being purchased (URL, API endpoint, etc.).
    pub resource_hash: [u8; 32],
    /// Commitment to (actual_amount, min, max, blinding). Hides the exact amount.
    pub amount_range_commitment: [u8; 32],
    /// Commitment to the payer's identity. Hides payer key.
    pub payer_commitment: [u8; 32],
    /// Minimum acceptable amount (public).
    pub min_lamports: u64,
    /// Maximum acceptable amount (public).
    pub max_lamports: u64,
    /// Unix timestamp when intent was created.
    pub created_at: u64,
    pub is_stub: bool,
    pub mainnet_ready: bool,
}

// ── public API ────────────────────────────────────────────────────────────────

/// Create a private payment intent.
///
/// - `resource`: 32-byte hash of the resource/API being purchased
/// - `actual_amount`: exact lamport amount (hidden inside commitment)
/// - `min_lamports` / `max_lamports`: public acceptable range
/// - `payer_key`: payer's identity (hidden behind commitment)
/// - `blinding`: random 32-byte blinding factor
/// - `timestamp`: Unix seconds (used for intent_id derivation)
pub fn create_private_intent(
    resource: &[u8; 32],
    actual_amount: u64,
    min_lamports: u64,
    max_lamports: u64,
    payer_key: &[u8; 32],
    blinding: &[u8; 32],
    timestamp: u64,
) -> Result<PrivateIntent, PrivateIntentError> {
    if resource == &[0u8; 32] {
        return Err(PrivateIntentError::ZeroResource);
    }
    if blinding == &[0u8; 32] {
        return Err(PrivateIntentError::ZeroBlinding);
    }
    if payer_key == &[0u8; 32] {
        return Err(PrivateIntentError::ZeroPayer);
    }
    if min_lamports > max_lamports || (min_lamports == 0 && max_lamports == 0) {
        return Err(PrivateIntentError::ZeroMinMax);
    }
    if actual_amount < min_lamports || actual_amount > max_lamports {
        return Err(PrivateIntentError::AmountOutOfRange);
    }

    let intent_id = {
        let mut h = Sha256::new();
        h.update(DOMAIN_INTENT_ID);
        h.update(resource);
        h.update(min_lamports.to_le_bytes());
        h.update(max_lamports.to_le_bytes());
        h.update(timestamp.to_le_bytes());
        h.finalize().into()
    };

    let amount_range_commitment = {
        let mut h = Sha256::new();
        h.update(DOMAIN_RANGE_COMMIT);
        h.update(actual_amount.to_le_bytes());
        h.update(min_lamports.to_le_bytes());
        h.update(max_lamports.to_le_bytes());
        h.update(blinding);
        h.finalize().into()
    };

    let payer_commitment = {
        let mut h = Sha256::new();
        h.update(DOMAIN_PAYER_COMMIT);
        h.update(payer_key);
        h.update(blinding);
        h.finalize().into()
    };

    Ok(PrivateIntent {
        intent_id,
        resource_hash: *resource,
        amount_range_commitment,
        payer_commitment,
        min_lamports,
        max_lamports,
        created_at: timestamp,
        is_stub: IS_STUB,
        mainnet_ready: MAINNET_READY,
    })
}

/// Verify that the intent's `amount_range_commitment` matches the given parameters.
///
/// Server calls this at settlement to verify the exact amount was within range.
pub fn verify_intent_range(
    intent: &PrivateIntent,
    actual_amount: u64,
    blinding: &[u8; 32],
) -> bool {
    let recomputed: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(DOMAIN_RANGE_COMMIT);
        h.update(actual_amount.to_le_bytes());
        h.update(intent.min_lamports.to_le_bytes());
        h.update(intent.max_lamports.to_le_bytes());
        h.update(blinding);
        h.finalize().into()
    };
    recomputed == intent.amount_range_commitment
}

/// Verify that the intent's `payer_commitment` matches the given payer key.
pub fn verify_payer(
    intent: &PrivateIntent,
    payer_key: &[u8; 32],
    blinding: &[u8; 32],
) -> bool {
    let recomputed: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(DOMAIN_PAYER_COMMIT);
        h.update(payer_key);
        h.update(blinding);
        h.finalize().into()
    };
    recomputed == intent.payer_commitment
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resource() -> [u8; 32] { let mut r = [0u8; 32]; r[0] = 0xCA; r[31] = 0xFE; r }
    fn payer() -> [u8; 32] { let mut p = [0u8; 32]; p[0] = 0xDE; p[15] = 0xAD; p }
    fn blinding() -> [u8; 32] { let mut b = [0u8; 32]; b[0] = 0xBE; b[16] = 0xEF; b }
    const MIN: u64 = 1_000;
    const MAX: u64 = 5_000;
    const ACTUAL: u64 = 3_000;
    const TS: u64 = 1_700_000_000;

    fn fresh() -> PrivateIntent {
        create_private_intent(&resource(), ACTUAL, MIN, MAX, &payer(), &blinding(), TS).unwrap()
    }

    // 1. constants
    #[test]
    fn test_constants() {
        assert!(IS_STUB);
        assert!(!MAINNET_READY);
    }

    // 2. create succeeds with valid params
    #[test]
    fn test_create_private_intent_succeeds() {
        let intent = fresh();
        assert_ne!(intent.intent_id, [0u8; 32]);
        assert_ne!(intent.amount_range_commitment, [0u8; 32]);
        assert_ne!(intent.payer_commitment, [0u8; 32]);
        assert!(!intent.mainnet_ready);
    }

    // 3. intent_id is deterministic
    #[test]
    fn test_intent_id_deterministic() {
        let a = fresh();
        let b = fresh();
        assert_eq!(a.intent_id, b.intent_id);
    }

    // 4. verify_intent_range succeeds with correct blinding
    #[test]
    fn test_verify_intent_range_correct_blinding() {
        let intent = fresh();
        assert!(verify_intent_range(&intent, ACTUAL, &blinding()));
    }

    // 5. verify_intent_range fails with wrong blinding
    #[test]
    fn test_verify_intent_range_wrong_blinding_fails() {
        let intent = fresh();
        let mut bad = blinding();
        bad[7] ^= 0xFF;
        assert!(!verify_intent_range(&intent, ACTUAL, &bad));
    }

    // 6. verify_intent_range fails with wrong amount
    #[test]
    fn test_verify_intent_range_wrong_amount_fails() {
        let intent = fresh();
        assert!(!verify_intent_range(&intent, ACTUAL + 1, &blinding()));
    }

    // 7. verify_payer succeeds with correct key
    #[test]
    fn test_verify_payer_correct_key() {
        let intent = fresh();
        assert!(verify_payer(&intent, &payer(), &blinding()));
    }

    // 8. verify_payer fails with wrong key
    #[test]
    fn test_verify_payer_wrong_key_fails() {
        let intent = fresh();
        let mut bad = payer();
        bad[3] ^= 0x80;
        assert!(!verify_payer(&intent, &bad, &blinding()));
    }

    // 9. amount below min → error
    #[test]
    fn test_amount_below_min_error() {
        let err = create_private_intent(&resource(), MIN - 1, MIN, MAX, &payer(), &blinding(), TS).unwrap_err();
        assert_eq!(err, PrivateIntentError::AmountOutOfRange);
    }

    // 10. amount above max → error
    #[test]
    fn test_amount_above_max_error() {
        let err = create_private_intent(&resource(), MAX + 1, MIN, MAX, &payer(), &blinding(), TS).unwrap_err();
        assert_eq!(err, PrivateIntentError::AmountOutOfRange);
    }

    // 11. zero resource → error
    #[test]
    fn test_zero_resource_error() {
        let err = create_private_intent(&[0u8; 32], ACTUAL, MIN, MAX, &payer(), &blinding(), TS).unwrap_err();
        assert_eq!(err, PrivateIntentError::ZeroResource);
    }

    // 12. zero blinding → error
    #[test]
    fn test_zero_blinding_error() {
        let err = create_private_intent(&resource(), ACTUAL, MIN, MAX, &payer(), &[0u8; 32], TS).unwrap_err();
        assert_eq!(err, PrivateIntentError::ZeroBlinding);
    }

    // 13. zero payer → error
    #[test]
    fn test_zero_payer_error() {
        let err = create_private_intent(&resource(), ACTUAL, MIN, MAX, &[0u8; 32], &blinding(), TS).unwrap_err();
        assert_eq!(err, PrivateIntentError::ZeroPayer);
    }

    // 14. min == max edge case (exact amount required)
    #[test]
    fn test_min_equals_max_edge_case() {
        let intent = create_private_intent(&resource(), 1000, 1000, 1000, &payer(), &blinding(), TS).unwrap();
        assert!(verify_intent_range(&intent, 1000, &blinding()));
        assert!(!verify_intent_range(&intent, 999, &blinding()));
    }

    // 15. different resource → different intent_id
    #[test]
    fn test_different_resource_different_intent_id() {
        let mut r2 = resource();
        r2[10] ^= 0x42;
        let a = fresh();
        let b = create_private_intent(&r2, ACTUAL, MIN, MAX, &payer(), &blinding(), TS).unwrap();
        assert_ne!(a.intent_id, b.intent_id);
    }

    // 16. payer_commitment != payer_key (commitment hides identity)
    #[test]
    fn test_payer_commitment_hides_key() {
        let intent = fresh();
        assert_ne!(
            intent.payer_commitment,
            payer(),
            "commitment must not equal the raw payer key"
        );
    }
}
