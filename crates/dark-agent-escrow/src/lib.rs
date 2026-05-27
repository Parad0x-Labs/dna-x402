//! dark-agent-escrow: Agent-managed conditional escrow with commitment verification.
//!
//! A payer locks funds into escrow with a condition commitment (SHA-256 hash of
//! condition bytes). An agent verifies the condition is met and releases funds
//! to a beneficiary. All hashes are domain-separated SHA-256.
//!
//! mainnet_ready: false — devnet/testnet only.

use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A locked escrow deposit.
#[derive(Debug, Clone)]
pub struct EscrowDeposit {
    /// SHA256("escrow-id-v1" || payer_hash || amount_le || condition_hash || created_at_le)
    pub escrow_id: [u8; 32],
    /// SHA256("escrow-payer-v1" || payer_secret)
    pub payer_hash: [u8; 32],
    /// SHA256("escrow-condition-v1" || condition_bytes)
    pub condition_hash: [u8; 32],
    pub amount: u64,
    pub created_at_unix: i64,
    pub expires_at_unix: i64,
    pub resolved: bool,
    pub mainnet_ready: bool,
}

/// The result of a successful escrow release.
#[derive(Debug, Clone)]
pub struct EscrowRelease {
    pub escrow_id: [u8; 32],
    /// SHA256("beneficiary-hash-v1" || beneficiary_secret)
    pub beneficiary_hash: [u8; 32],
    /// SHA256("escrow-release-v1" || escrow_id || beneficiary_hash || condition_bytes)
    pub release_proof: [u8; 32],
    pub amount: u64,
    pub released_at_unix: i64,
    pub mainnet_ready: bool,
}

/// Errors returned by escrow operations.
#[derive(Debug, PartialEq)]
pub enum EscrowError {
    ZeroAmount,
    AlreadyResolved,
    Expired { expired_at: i64, current: i64 },
    ConditionMismatch,
    PayerSecretZero,
}

// ---------------------------------------------------------------------------
// Internal hashing helpers
// ---------------------------------------------------------------------------

fn sha256_domain(domain: &[u8], data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(domain);
    h.update(data);
    h.finalize().into()
}

fn sha256_chain(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for part in parts {
        h.update(part);
    }
    h.finalize().into()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Create a new escrow deposit.
///
/// - Returns `EscrowError::ZeroAmount` if `amount == 0`.
/// - Returns `EscrowError::PayerSecretZero` if `payer_secret == [0u8; 32]`.
///
/// Hash construction (all domain-separated SHA-256):
/// - `payer_hash      = SHA256("escrow-payer-v1"      || payer_secret)`
/// - `condition_hash  = SHA256("escrow-condition-v1"  || condition_bytes)`
/// - `escrow_id       = SHA256("escrow-id-v1"         || payer_hash || amount.to_le_bytes() || condition_hash || created_at_unix.to_le_bytes())`
pub fn create_escrow(
    payer_secret: &[u8; 32],
    amount: u64,
    condition_bytes: &[u8],
    created_at_unix: i64,
    expires_at_unix: i64,
) -> Result<EscrowDeposit, EscrowError> {
    if amount == 0 {
        return Err(EscrowError::ZeroAmount);
    }
    if payer_secret == &[0u8; 32] {
        return Err(EscrowError::PayerSecretZero);
    }

    let payer_hash = sha256_domain(b"escrow-payer-v1", payer_secret);
    let condition_hash = sha256_domain(b"escrow-condition-v1", condition_bytes);
    let escrow_id = sha256_chain(&[
        b"escrow-id-v1",
        &payer_hash,
        &amount.to_le_bytes(),
        &condition_hash,
        &created_at_unix.to_le_bytes(),
    ]);

    Ok(EscrowDeposit {
        escrow_id,
        payer_hash,
        condition_hash,
        amount,
        created_at_unix,
        expires_at_unix,
        resolved: false,
        mainnet_ready: false,
    })
}

/// Release an escrow deposit to a beneficiary after verifying the condition.
///
/// - Returns `EscrowError::AlreadyResolved` if `escrow.resolved` is already `true`.
/// - Returns `EscrowError::Expired` if `current_unix > escrow.expires_at_unix`.
/// - Recomputes `condition_hash` from `condition_bytes` and returns
///   `EscrowError::ConditionMismatch` if it does not match the stored hash.
/// - On success, sets `escrow.resolved = true` and returns an `EscrowRelease`.
///
/// Hash construction:
/// - `beneficiary_hash = SHA256("beneficiary-hash-v1" || beneficiary_secret)`
/// - `release_proof    = SHA256("escrow-release-v1"   || escrow_id || beneficiary_hash || condition_bytes)`
pub fn release_escrow(
    escrow: &mut EscrowDeposit,
    beneficiary_secret: &[u8; 32],
    condition_bytes: &[u8],
    current_unix: i64,
) -> Result<EscrowRelease, EscrowError> {
    if escrow.resolved {
        return Err(EscrowError::AlreadyResolved);
    }
    if current_unix > escrow.expires_at_unix {
        return Err(EscrowError::Expired {
            expired_at: escrow.expires_at_unix,
            current: current_unix,
        });
    }

    let recomputed_condition = sha256_domain(b"escrow-condition-v1", condition_bytes);
    if recomputed_condition != escrow.condition_hash {
        return Err(EscrowError::ConditionMismatch);
    }

    let beneficiary_hash = sha256_domain(b"beneficiary-hash-v1", beneficiary_secret);
    let release_proof = sha256_chain(&[
        b"escrow-release-v1",
        &escrow.escrow_id,
        &beneficiary_hash,
        condition_bytes,
    ]);

    let amount = escrow.amount;
    let escrow_id = escrow.escrow_id;
    escrow.resolved = true;

    Ok(EscrowRelease {
        escrow_id,
        beneficiary_hash,
        release_proof,
        amount,
        released_at_unix: current_unix,
        mainnet_ready: false,
    })
}

/// Return a JSON public record for an escrow deposit.
///
/// Includes: `escrow_id` (hex), `condition_hash` (hex), `created_at_unix`,
/// `expires_at_unix`, `resolved`, `mainnet_ready`.
///
/// Does NOT include `payer_hash`, `amount`, or raw condition bytes.
pub fn escrow_public_record(escrow: &EscrowDeposit) -> String {
    serde_json::json!({
        "escrow_id": hex_encode(&escrow.escrow_id),
        "condition_hash": hex_encode(&escrow.condition_hash),
        "created_at_unix": escrow.created_at_unix,
        "expires_at_unix": escrow.expires_at_unix,
        "resolved": escrow.resolved,
        "mainnet_ready": escrow.mainnet_ready,
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn payer_secret() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xDE;
        s[1] = 0xAD;
        s
    }

    fn beneficiary_secret() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xBE;
        s[1] = 0xEF;
        s
    }

    fn condition() -> &'static [u8] {
        b"deliver-service-xyz"
    }

    // Test 1: full roundtrip — create then release succeeds
    #[test]
    fn test_create_and_release_happy_path() {
        let created_at: i64 = 1_700_000_000;
        let expires_at: i64 = 1_700_086_400; // +1 day
        let current: i64 = 1_700_043_200; // mid-window

        let mut escrow = create_escrow(
            &payer_secret(),
            1_000_000,
            condition(),
            created_at,
            expires_at,
        )
        .expect("create_escrow should succeed");

        assert!(!escrow.resolved);
        assert!(!escrow.mainnet_ready);
        assert_eq!(escrow.amount, 1_000_000);

        let release = release_escrow(&mut escrow, &beneficiary_secret(), condition(), current)
            .expect("release_escrow should succeed");

        assert!(escrow.resolved);
        assert_eq!(release.amount, 1_000_000);
        assert_eq!(release.escrow_id, escrow.escrow_id);
        assert!(!release.mainnet_ready);
        assert_eq!(release.released_at_unix, current);

        // release_proof must be non-zero
        assert_ne!(release.release_proof, [0u8; 32]);
        // beneficiary_hash must be non-zero
        assert_ne!(release.beneficiary_hash, [0u8; 32]);
    }

    // Test 2: releasing an already-resolved escrow returns AlreadyResolved
    #[test]
    fn test_double_release_rejected() {
        let mut escrow = create_escrow(
            &payer_secret(),
            500,
            condition(),
            1_000_000_000,
            2_000_000_000,
        )
        .unwrap();

        release_escrow(
            &mut escrow,
            &beneficiary_secret(),
            condition(),
            1_500_000_000,
        )
        .expect("first release should succeed");

        let err = release_escrow(
            &mut escrow,
            &beneficiary_secret(),
            condition(),
            1_500_000_001,
        )
        .expect_err("second release should fail");

        assert_eq!(err, EscrowError::AlreadyResolved);
    }

    // Test 3: releasing after expiry returns Expired
    #[test]
    fn test_expired_escrow_rejected() {
        let expires_at: i64 = 1_700_000_000;
        let current: i64 = 1_700_000_001; // one second past expiry

        let mut escrow =
            create_escrow(&payer_secret(), 999, condition(), 1_699_000_000, expires_at).unwrap();

        let err = release_escrow(&mut escrow, &beneficiary_secret(), condition(), current)
            .expect_err("expired escrow should fail");

        assert_eq!(
            err,
            EscrowError::Expired {
                expired_at: expires_at,
                current,
            }
        );
    }

    // Test 4: mismatched condition bytes returns ConditionMismatch
    #[test]
    fn test_wrong_condition_rejected() {
        let mut escrow = create_escrow(
            &payer_secret(),
            100,
            condition(),
            1_000_000_000,
            9_999_999_999,
        )
        .unwrap();

        let wrong_condition = b"wrong-condition";
        let err = release_escrow(
            &mut escrow,
            &beneficiary_secret(),
            wrong_condition,
            1_000_000_001,
        )
        .expect_err("wrong condition should fail");

        assert_eq!(err, EscrowError::ConditionMismatch);
    }

    // Test 5: zero amount returns ZeroAmount
    #[test]
    fn test_zero_amount_rejected() {
        let err = create_escrow(
            &payer_secret(),
            0,
            condition(),
            1_000_000_000,
            2_000_000_000,
        )
        .expect_err("zero amount should fail");

        assert_eq!(err, EscrowError::ZeroAmount);
    }

    // Test 6: public record does not expose payer_hash or amount
    #[test]
    fn test_public_record_hides_payer_and_amount() {
        let escrow = create_escrow(
            &payer_secret(),
            42_000_000,
            condition(),
            1_000_000_000,
            2_000_000_000,
        )
        .unwrap();

        let record = escrow_public_record(&escrow);

        // Must contain the public fields
        assert!(record.contains("escrow_id"));
        assert!(record.contains("condition_hash"));
        assert!(record.contains("created_at_unix"));
        assert!(record.contains("expires_at_unix"));
        assert!(record.contains("mainnet_ready"));

        // Must NOT expose payer_hash as a hex string
        let payer_hash_hex = hex_encode(&escrow.payer_hash);
        assert!(
            !record.contains(&payer_hash_hex),
            "public record must not contain payer_hash hex"
        );

        // Must NOT expose the raw amount
        assert!(
            !record.contains("42000000"),
            "public record must not contain raw amount"
        );
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_mainnet_ready_always_false() {
        let mut escrow = create_escrow(&payer_secret(), 1, condition(), 0, 9_999_999_999).unwrap();
        assert!(!escrow.mainnet_ready);
        let release = release_escrow(&mut escrow, &beneficiary_secret(), condition(), 1).unwrap();
        assert!(!release.mainnet_ready);
    }

    #[test]
    fn test_escrow_id_deterministic() {
        let e1 = create_escrow(&payer_secret(), 1_000, condition(), 100, 200).unwrap();
        let e2 = create_escrow(&payer_secret(), 1_000, condition(), 100, 200).unwrap();
        assert_eq!(e1.escrow_id, e2.escrow_id);
    }

    #[test]
    fn test_escrow_id_amount_sensitive() {
        let e1 = create_escrow(&payer_secret(), 1_000, condition(), 100, 200).unwrap();
        let e2 = create_escrow(&payer_secret(), 2_000, condition(), 100, 200).unwrap();
        assert_ne!(e1.escrow_id, e2.escrow_id);
    }

    #[test]
    fn test_escrow_id_condition_sensitive() {
        let e1 = create_escrow(&payer_secret(), 500, b"cond-a", 100, 200).unwrap();
        let e2 = create_escrow(&payer_secret(), 500, b"cond-b", 100, 200).unwrap();
        assert_ne!(e1.escrow_id, e2.escrow_id);
    }

    #[test]
    fn test_payer_secret_zero_rejected() {
        let err = create_escrow(&[0u8; 32], 100, condition(), 0, 9_999).unwrap_err();
        assert_eq!(err, EscrowError::PayerSecretZero);
    }

    #[test]
    fn test_release_at_exact_expiry_ok() {
        let expires_at: i64 = 1_700_000_000;
        let mut escrow = create_escrow(&payer_secret(), 100, condition(), 0, expires_at).unwrap();
        // current == expires_at → NOT expired (strict > check)
        assert!(
            release_escrow(&mut escrow, &beneficiary_secret(), condition(), expires_at).is_ok()
        );
    }

    #[test]
    fn test_release_proof_is_nonzero() {
        let mut escrow = create_escrow(&payer_secret(), 777, condition(), 0, 9_999_999).unwrap();
        let release = release_escrow(&mut escrow, &beneficiary_secret(), condition(), 1).unwrap();
        assert_ne!(release.release_proof, [0u8; 32]);
    }

    #[test]
    fn test_public_record_contains_condition_hash() {
        let escrow = create_escrow(&payer_secret(), 50, condition(), 0, 9_999_999).unwrap();
        let record = escrow_public_record(&escrow);
        let cond_hex = hex_encode(&escrow.condition_hash);
        assert!(
            record.contains(&cond_hex),
            "public record must include condition_hash hex"
        );
    }

    #[test]
    fn test_escrow_id_payer_sensitive() {
        let mut other_payer = payer_secret();
        other_payer[0] ^= 0xFF;
        let e1 = create_escrow(&payer_secret(), 500, condition(), 100, 200).unwrap();
        let e2 = create_escrow(&other_payer, 500, condition(), 100, 200).unwrap();
        assert_ne!(e1.escrow_id, e2.escrow_id);
    }

    #[test]
    fn test_release_proof_beneficiary_sensitive() {
        let mut other_bene = beneficiary_secret();
        other_bene[0] ^= 0xFF;
        let mut e1 = create_escrow(&payer_secret(), 300, condition(), 0, 9_999_999).unwrap();
        let mut e2 = create_escrow(&payer_secret(), 300, condition(), 0, 9_999_999).unwrap();
        let r1 = release_escrow(&mut e1, &beneficiary_secret(), condition(), 1).unwrap();
        let r2 = release_escrow(&mut e2, &other_bene, condition(), 1).unwrap();
        assert_ne!(r1.release_proof, r2.release_proof);
    }
}
