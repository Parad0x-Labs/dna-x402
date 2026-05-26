use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ComplianceType {
    KycBasic = 1,
    KycEnhanced = 2,
    AmlScreening = 3,
    SanctionsCheck = 4,
}

impl ComplianceType {
    fn as_u8(self) -> u8 {
        self as u8
    }

    fn name(self) -> &'static str {
        match self {
            ComplianceType::KycBasic => "kyc_basic",
            ComplianceType::KycEnhanced => "kyc_enhanced",
            ComplianceType::AmlScreening => "aml_screening",
            ComplianceType::SanctionsCheck => "sanctions_check",
        }
    }
}

pub struct ComplianceCheck {
    pub check_type: ComplianceType,
    /// SHA256("compliance-subject-v1" || raw_subject_data)
    pub subject_hash: [u8; 32],
    /// SHA256("compliance-result-v1" || pass_byte || check_type_byte || timestamp_le)
    pub result_hash: [u8; 32],
    pub checked_at_unix: i64,
    pub expires_at_unix: i64,
    /// Always false — not yet mainnet-ready.
    pub mainnet_ready: bool,
}

pub struct ComplianceAttestation {
    /// SHA256("compliance-receipt-v1" || subject_hash || result_hash || timestamp_le)
    pub receipt_hash: [u8; 32],
    pub compliance_check: ComplianceCheck,
    /// SHA256("attester-v1" || attester_id_bytes)
    pub attester_hash: [u8; 32],
}

#[derive(Debug, PartialEq, Eq)]
pub enum ComplianceError {
    ExpiredCheck,
    SubjectMismatch,
    InvalidCheckType,
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/// Build a `ComplianceCheck` from raw subject data and outcome.
///
/// * `subject_hash` = SHA256("compliance-subject-v1" || subject_data)
/// * `result_hash`  = SHA256("compliance-result-v1" || passed_u8 || check_type_u8 || checked_at_unix_le64)
/// * `mainnet_ready` is always `false`.
pub fn create_compliance_check(
    check_type: ComplianceType,
    subject_data: &[u8],
    passed: bool,
    checked_at_unix: i64,
    expires_at_unix: i64,
) -> ComplianceCheck {
    // subject_hash
    let subject_hash = {
        let mut h = Sha256::new();
        h.update(b"compliance-subject-v1");
        h.update(subject_data);
        h.finalize().into()
    };

    // result_hash
    let result_hash = {
        let mut h = Sha256::new();
        h.update(b"compliance-result-v1");
        h.update([passed as u8]);
        h.update([check_type.as_u8()]);
        h.update(checked_at_unix.to_le_bytes());
        h.finalize().into()
    };

    ComplianceCheck {
        check_type,
        subject_hash,
        result_hash,
        checked_at_unix,
        expires_at_unix,
        mainnet_ready: false,
    }
}

/// Wrap a `ComplianceCheck` in an attester-signed `ComplianceAttestation`.
///
/// * `attester_hash` = SHA256("attester-v1" || attester_id)
/// * `receipt_hash`  = SHA256("compliance-receipt-v1" || subject_hash || result_hash || checked_at_unix_le64)
pub fn attest_compliance(check: ComplianceCheck, attester_id: &[u8]) -> ComplianceAttestation {
    let attester_hash = {
        let mut h = Sha256::new();
        h.update(b"attester-v1");
        h.update(attester_id);
        h.finalize().into()
    };

    let receipt_hash = {
        let mut h = Sha256::new();
        h.update(b"compliance-receipt-v1");
        h.update(check.subject_hash);
        h.update(check.result_hash);
        h.update(check.checked_at_unix.to_le_bytes());
        h.finalize().into()
    };

    ComplianceAttestation {
        receipt_hash,
        compliance_check: check,
        attester_hash,
    }
}

/// Re-derive the subject hash and compare it to `check.subject_hash`.
/// Returns `true` if they match — i.e. `subject_data` is the data that was checked.
pub fn verify_subject(check: &ComplianceCheck, subject_data: &[u8]) -> bool {
    let mut h = Sha256::new();
    h.update(b"compliance-subject-v1");
    h.update(subject_data);
    let derived: [u8; 32] = h.finalize().into();
    derived == check.subject_hash
}

/// Returns `true` if `current_unix` is strictly after `expires_at_unix`.
pub fn check_expired(check: &ComplianceCheck, current_unix: i64) -> bool {
    current_unix > check.expires_at_unix
}

/// Produce a JSON public record for on-chain / audit publication.
///
/// Privacy rules enforced here:
/// - DOES NOT include `subject_hash` (would reveal a linkable identifier).
/// - DOES NOT include pass/fail result detail (leaks outcome).
/// - Only publishes `receipt_hash`, `attester_hash`, `check_type`, timestamps,
///   and `mainnet_ready`.
pub fn compliance_public_record(attestation: &ComplianceAttestation) -> String {
    let receipt_hex = hex_encode(&attestation.receipt_hash);
    let attester_hex = hex_encode(&attestation.attester_hash);
    let check = &attestation.compliance_check;

    serde_json::json!({
        "receipt_hash":     receipt_hex,
        "attester_hash":    attester_hex,
        "check_type":       check.check_type.name(),
        "checked_at_unix":  check.checked_at_unix,
        "expires_at_unix":  check.expires_at_unix,
        "mainnet_ready":    check.mainnet_ready,
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const SUBJECT: &[u8] = b"alice@example.com";
    const ATTESTER: &[u8] = b"attester-node-1";
    const NOW: i64 = 1_700_000_000;
    const FUTURE: i64 = NOW + 86_400;

    // 1. create_compliance_check + verify_subject: correct data → true
    #[test]
    fn test_create_and_verify_subject() {
        let check = create_compliance_check(
            ComplianceType::KycBasic,
            SUBJECT,
            true,
            NOW,
            FUTURE,
        );
        assert!(verify_subject(&check, SUBJECT));
    }

    // 2. Different subject data → verify_subject returns false
    #[test]
    fn test_wrong_subject_fails_verify() {
        let check = create_compliance_check(
            ComplianceType::KycBasic,
            SUBJECT,
            true,
            NOW,
            FUTURE,
        );
        assert!(!verify_subject(&check, b"bob@example.com"));
    }

    // 3. check_expired returns true when current_unix > expires_at_unix
    #[test]
    fn test_expired_check_detected() {
        let check = create_compliance_check(
            ComplianceType::AmlScreening,
            SUBJECT,
            true,
            NOW,
            FUTURE,
        );
        // not expired at expiry timestamp itself
        assert!(!check_expired(&check, FUTURE));
        // expired one second later
        assert!(check_expired(&check, FUTURE + 1));
    }

    // 4. compliance_public_record must NOT contain the subject_hash hex
    #[test]
    fn test_public_record_hides_subject() {
        let check = create_compliance_check(
            ComplianceType::SanctionsCheck,
            SUBJECT,
            true,
            NOW,
            FUTURE,
        );
        let subject_hash_hex = hex_encode(&check.subject_hash);
        let attestation = attest_compliance(check, ATTESTER);
        let record = compliance_public_record(&attestation);

        assert!(
            !record.contains(&subject_hash_hex),
            "public record must not contain subject_hash; got: {record}"
        );
        // Sanity: receipt_hash IS present
        let receipt_hex = hex_encode(&attestation.receipt_hash);
        assert!(record.contains(&receipt_hex));
    }

    // 5. Same inputs always produce the same receipt_hash (deterministic)
    #[test]
    fn test_attestation_receipt_deterministic() {
        let make = || {
            let check = create_compliance_check(
                ComplianceType::KycEnhanced,
                SUBJECT,
                false,
                NOW,
                FUTURE,
            );
            attest_compliance(check, ATTESTER)
        };
        let a1 = make();
        let a2 = make();
        assert_eq!(a1.receipt_hash, a2.receipt_hash);
        assert_eq!(a1.attester_hash, a2.attester_hash);
    }
}
