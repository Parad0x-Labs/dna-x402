use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Private domain-separated SHA-256 helper
// ---------------------------------------------------------------------------

fn sha256_domain(domain: &[u8], inputs: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(domain);
    for input in inputs {
        h.update(input);
    }
    h.finalize().into()
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Classes of keys the agent claims NOT to hold.
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub enum DeniedKeyClass {
    UserSpendKey,
    RootAuthority,
    UpgradeAuthority,
    SessionVaultSecret,
}

impl DeniedKeyClass {
    pub fn all() -> Vec<Self> {
        vec![
            Self::UserSpendKey,
            Self::RootAuthority,
            Self::UpgradeAuthority,
            Self::SessionVaultSecret,
        ]
    }

    pub fn class_byte(&self) -> u8 {
        match self {
            Self::UserSpendKey => 1,
            Self::RootAuthority => 2,
            Self::UpgradeAuthority => 3,
            Self::SessionVaultSecret => 4,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum RedactionPolicy {
    PiiRemoved,
    KeySlotsEmpty,
    EnvRedacted,
}

/// A no-custody attestation capsule.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NoCustodyCapsule {
    pub binary_hash: [u8; 32],
    pub config_hash: [u8; 32],
    pub denied_key_classes: Vec<DeniedKeyClass>,
    pub max_float_lamports: u64,
    pub redaction_policy_hash: [u8; 32],
    pub custody_denied: bool,
    pub issued_at_slot: u64,
    /// Ed25519 pubkey of the signer (as bytes). NOT a private key.
    pub signer_pubkey_hash: [u8; 32],
}

impl NoCustodyCapsule {
    pub fn capsule_hash(&self) -> [u8; 32] {
        // Collect the denied key class bytes so the slice reference lives long enough.
        let class_bytes: Vec<u8> = self
            .denied_key_classes
            .iter()
            .map(|k| k.class_byte())
            .collect();

        sha256_domain(
            b"dark_null_v1_no_custody",
            &[
                self.binary_hash.as_ref(),
                self.config_hash.as_ref(),
                &self.max_float_lamports.to_le_bytes(),
                self.redaction_policy_hash.as_ref(),
                &[self.custody_denied as u8],
                &self.issued_at_slot.to_le_bytes(),
                self.signer_pubkey_hash.as_ref(),
                // Include sorted denied key class bytes
                class_bytes.as_slice(),
            ],
        )
    }

    pub fn has_denied(&self, class: &DeniedKeyClass) -> bool {
        self.denied_key_classes.contains(class)
    }
}

/// Custody risk score: 0 = safe (all keys denied), 100 = high risk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustodyRiskScore(pub u8);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CustodyError {
    CustodyNotDenied,
    MissingDeniedKeyClass(DeniedKeyClass),
    StaleCapsule {
        issued_at: u64,
        max_age: u64,
        current: u64,
    },
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/// Validate the capsule.
///
/// Requirements:
/// 1. `custody_denied` must be true.
/// 2. All four [`DeniedKeyClass`] variants must be present in `denied_key_classes`.
/// 3. The capsule must not be stale: `current_slot - issued_at_slot <= max_age_slots`.
pub fn validate_capsule(
    capsule: &NoCustodyCapsule,
    current_slot: u64,
    max_age_slots: u64,
) -> Result<(), CustodyError> {
    if !capsule.custody_denied {
        return Err(CustodyError::CustodyNotDenied);
    }

    for class in DeniedKeyClass::all() {
        if !capsule.denied_key_classes.contains(&class) {
            return Err(CustodyError::MissingDeniedKeyClass(class));
        }
    }

    let age = current_slot.saturating_sub(capsule.issued_at_slot);
    if age > max_age_slots {
        return Err(CustodyError::StaleCapsule {
            issued_at: capsule.issued_at_slot,
            max_age: max_age_slots,
            current: current_slot,
        });
    }

    Ok(())
}

/// Compute a custody risk score.
///
/// Start at 0 (safe). Add 25 per missing [`DeniedKeyClass`].
/// If `custody_denied` is false, score is always 100.
pub fn compute_risk_score(capsule: &NoCustodyCapsule) -> CustodyRiskScore {
    if !capsule.custody_denied {
        return CustodyRiskScore(100);
    }

    let missing = DeniedKeyClass::all()
        .iter()
        .filter(|c| !capsule.denied_key_classes.contains(c))
        .count() as u8;

    CustodyRiskScore(missing.saturating_mul(25))
}

/// Bind a receipt hash to a capsule: produce a combined hash.
///
/// Returns `SHA256("dark_null_v1_receipt_capsule_bind" || receipt_hash || capsule_hash)`.
pub fn bind_to_receipt(receipt_hash: &[u8; 32], capsule: &NoCustodyCapsule) -> [u8; 32] {
    let capsule_hash = capsule.capsule_hash();
    sha256_domain(
        b"dark_null_v1_receipt_capsule_bind",
        &[receipt_hash.as_ref(), capsule_hash.as_ref()],
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_capsule() -> NoCustodyCapsule {
        NoCustodyCapsule {
            binary_hash: [0x01u8; 32],
            config_hash: [0x02u8; 32],
            denied_key_classes: DeniedKeyClass::all(),
            max_float_lamports: 1_000_000,
            redaction_policy_hash: [0x03u8; 32],
            custody_denied: true,
            issued_at_slot: 1000,
            signer_pubkey_hash: [0x04u8; 32],
        }
    }

    // 1. Valid capsule passes validation.
    #[test]
    fn test_valid_capsule_passes() {
        let capsule = make_capsule();
        assert!(validate_capsule(&capsule, 1500, 1000).is_ok());
    }

    // 2. custody_denied=false is rejected with CustodyNotDenied.
    #[test]
    fn test_custody_denied_false_rejected() {
        let mut capsule = make_capsule();
        capsule.custody_denied = false;
        let err = validate_capsule(&capsule, 1500, 1000).unwrap_err();
        assert!(matches!(err, CustodyError::CustodyNotDenied));
    }

    // 3. Missing UserSpendKey yields MissingDeniedKeyClass(UserSpendKey).
    #[test]
    fn test_missing_user_spend_key_rejected() {
        let mut capsule = make_capsule();
        capsule
            .denied_key_classes
            .retain(|k| k != &DeniedKeyClass::UserSpendKey);
        let err = validate_capsule(&capsule, 1500, 1000).unwrap_err();
        assert!(matches!(
            err,
            CustodyError::MissingDeniedKeyClass(DeniedKeyClass::UserSpendKey)
        ));
    }

    // 4. Missing UpgradeAuthority yields MissingDeniedKeyClass(UpgradeAuthority).
    #[test]
    fn test_missing_upgrade_key_rejected() {
        let mut capsule = make_capsule();
        capsule
            .denied_key_classes
            .retain(|k| k != &DeniedKeyClass::UpgradeAuthority);
        let err = validate_capsule(&capsule, 1500, 1000).unwrap_err();
        assert!(matches!(
            err,
            CustodyError::MissingDeniedKeyClass(DeniedKeyClass::UpgradeAuthority)
        ));
    }

    // 5. Stale capsule (issued=1000, current=5000, max_age=1000) → StaleCapsule.
    #[test]
    fn test_stale_capsule_rejected() {
        let capsule = make_capsule(); // issued_at_slot = 1000
        let err = validate_capsule(&capsule, 5000, 1000).unwrap_err();
        assert!(matches!(
            err,
            CustodyError::StaleCapsule {
                issued_at: 1000,
                max_age: 1000,
                current: 5000,
            }
        ));
    }

    // 6. bind_to_receipt output changes when the capsule changes.
    #[test]
    fn test_receipt_binds_capsule_hash() {
        let receipt_hash = [0xAAu8; 32];
        let capsule_a = make_capsule();
        let mut capsule_b = make_capsule();
        capsule_b.max_float_lamports = 999; // different capsule

        let bind_a = bind_to_receipt(&receipt_hash, &capsule_a);
        let bind_b = bind_to_receipt(&receipt_hash, &capsule_b);
        assert_ne!(bind_a, bind_b);
    }

    // 7. Full denial + custody_denied=true → risk score 0.
    #[test]
    fn test_risk_score_full_denial_is_zero() {
        let capsule = make_capsule();
        assert_eq!(compute_risk_score(&capsule), CustodyRiskScore(0));
    }

    // 8. Missing 2 DeniedKeyClass → risk score 50 (2 × 25).
    #[test]
    fn test_risk_score_increases_with_missing_fields() {
        let mut capsule = make_capsule();
        capsule
            .denied_key_classes
            .retain(|k| k == &DeniedKeyClass::UserSpendKey || k == &DeniedKeyClass::RootAuthority);
        // Two missing: UpgradeAuthority + SessionVaultSecret
        assert_eq!(compute_risk_score(&capsule), CustodyRiskScore(50));
    }

    // 9. custody_denied=false → risk score 100 regardless of denied_key_classes.
    #[test]
    fn test_risk_score_custody_not_denied_is_100() {
        let mut capsule = make_capsule();
        capsule.custody_denied = false;
        assert_eq!(compute_risk_score(&capsule), CustodyRiskScore(100));
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_capsule_hash_nonzero() {
        let capsule = make_capsule();
        assert_ne!(capsule.capsule_hash(), [0u8; 32]);
    }

    #[test]
    fn test_capsule_hash_config_sensitive() {
        let c1 = make_capsule();
        let mut c2 = make_capsule();
        c2.config_hash = [0xFFu8; 32];
        assert_ne!(c1.capsule_hash(), c2.capsule_hash());
    }

    #[test]
    fn test_risk_score_one_missing_is_25() {
        let mut capsule = make_capsule();
        capsule
            .denied_key_classes
            .retain(|k| k != &DeniedKeyClass::UserSpendKey);
        // One missing → 1 × 25 = 25
        assert_eq!(compute_risk_score(&capsule), CustodyRiskScore(25));
    }

    #[test]
    fn test_denied_key_class_bytes_distinct() {
        let all = DeniedKeyClass::all();
        let bytes: Vec<u8> = all.iter().map(|k| k.class_byte()).collect();
        let unique: std::collections::HashSet<u8> = bytes.iter().cloned().collect();
        assert_eq!(unique.len(), all.len());
    }

    #[test]
    fn test_bind_to_receipt_nonzero() {
        let receipt_hash = [0xAAu8; 32];
        let capsule = make_capsule();
        let bound = bind_to_receipt(&receipt_hash, &capsule);
        assert_ne!(bound, [0u8; 32]);
    }

    #[test]
    fn test_capsule_not_stale_at_exact_max_age() {
        // issued=1000, max_age=1000, current=2000 → age=1000, 1000 > 1000 is false → Ok
        let capsule = make_capsule(); // issued_at_slot=1000
        assert!(validate_capsule(&capsule, 2000, 1000).is_ok());
    }

    #[test]
    fn test_has_denied_true_for_all_classes() {
        let capsule = make_capsule();
        for class in DeniedKeyClass::all() {
            assert!(
                capsule.has_denied(&class),
                "has_denied must be true for {:?}",
                class
            );
        }
    }
}
