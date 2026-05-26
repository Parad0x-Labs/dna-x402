//! dark-swarm-capsule — Proof-Carrying Service Posture Capsule
//!
//! Each Dark Null relayer / prover / indexer publishes a signed capsule
//! proving: git commit, manifest hash, config hash, role, caps, fee policy,
//! custody posture (no root key, no upgrade key, no user keys).
//!
//! This is NOT a validator network. NOT BFT. NOT decentralized consensus.
//! It is a verifiable service declaration: "here is what I claim to run."
//!
//! Daily use case: A relayer signs a capsule every hour. Users pick the
//! relayer with the most recently verified capsule, lowest declared fees,
//! and clean custody attestation. No trust required — the capsule proves
//! the claim or the signature fails.
//!
//! NOT_PRODUCTION — devnet only. Not audited. mainnet_ready = false.

use sha2::{Digest, Sha256};
use thiserror::Error;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// The role a Dark Null service node is declaring.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SwarmRole {
    Relayer,
    Prover,
    Indexer,
    Monitor,
    RootCoordinator,
    X402Adapter,
}

/// Capability limits declared by the service node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwarmCaps {
    pub max_total_value_locked_lamports: u64,
    pub max_deposit_lamports: u64,
    pub daily_withdraw_limit_lamports: u64,
}

/// Attestation that the service holds no dangerous key material.
/// All three fields MUST be false for a clean capsule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustodyAttestation {
    pub root_key_present: bool,
    pub upgrade_key_present: bool,
    pub user_spending_keys_present: bool,
}

/// Liveness/readiness probe paths for this service.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LivenessConfig {
    pub health_path: String,
    pub ready_path: String,
    pub metrics_path: String,
}

/// A fully-described, hashable service capsule.
#[derive(Debug, Clone, PartialEq)]
pub struct ServiceCapsule {
    pub schema_version: String,
    pub role: SwarmRole,
    pub repo_commit: String,
    pub manifest_sha256: [u8; 32],
    pub config_sha256: [u8; 32],
    pub service_id: String,
    pub network: String,
    pub caps: SwarmCaps,
    pub fee_policy_sha256: [u8; 32],
    pub liveness: LivenessConfig,
    pub custody: CustodyAttestation,
    pub created_at_unix: u64,
    pub capsule_hash: [u8; 32],
}

/// A capsule with an attached hex-encoded signature.
/// The signature is produced over `capsule.capsule_hash` by the service key.
#[derive(Debug, Clone)]
pub struct SignedCapsule {
    pub capsule: ServiceCapsule,
    pub signature_hex: String,
    pub signer_pubkey_hex: String,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, Error, PartialEq)]
pub enum CapsuleError {
    #[error("root key is present — forbidden for Dark Null relayers")]
    RootKeyForbidden,
    #[error("upgrade key is present — forbidden for capsule-declared services")]
    UpgradeKeyForbidden,
    #[error("user spending keys are present — relayer must not hold user keys")]
    UserKeysPresent,
    #[error("capsule is stale: age {age_seconds}s exceeds max")]
    StaleCapsule { age_seconds: u64 },
    #[error("manifest hash mismatch")]
    WrongManifestHash,
    #[error("invalid or unverifiable capsule signature")]
    InvalidSignature,
    #[error("conflicting capsule: same service_id with different repo_commit")]
    ConflictingServiceId,
    #[error("x402 adapter enabled but no supporting evidence provided")]
    X402EnabledWithoutEvidence,
}

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// Encode a SwarmRole as a stable byte for hashing.
fn role_byte(role: &SwarmRole) -> u8 {
    match role {
        SwarmRole::Relayer => 0x01,
        SwarmRole::Prover => 0x02,
        SwarmRole::Indexer => 0x03,
        SwarmRole::Monitor => 0x04,
        SwarmRole::RootCoordinator => 0x05,
        SwarmRole::X402Adapter => 0x06,
    }
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/// Computes the canonical capsule hash.
///
/// Hash: SHA256("dark-null-capsule-v1"
///   || schema_version  || role_byte
///   || repo_commit     || manifest_sha256
///   || config_sha256   || service_id
///   || network         || max_tvl || max_deposit || daily_withdraw
///   || fee_policy_sha256
///   || health_path || ready_path || metrics_path
///   || root_key_byte || upgrade_key_byte || user_keys_byte
///   || created_at_unix.to_le_bytes())
pub fn compute_capsule_hash(capsule: &ServiceCapsule) -> [u8; 32] {
    sha256_multi(&[
        b"dark-null-capsule-v1",
        capsule.schema_version.as_bytes(),
        &[role_byte(&capsule.role)],
        capsule.repo_commit.as_bytes(),
        capsule.manifest_sha256.as_ref(),
        capsule.config_sha256.as_ref(),
        capsule.service_id.as_bytes(),
        capsule.network.as_bytes(),
        &capsule.caps.max_total_value_locked_lamports.to_le_bytes(),
        &capsule.caps.max_deposit_lamports.to_le_bytes(),
        &capsule.caps.daily_withdraw_limit_lamports.to_le_bytes(),
        capsule.fee_policy_sha256.as_ref(),
        capsule.liveness.health_path.as_bytes(),
        capsule.liveness.ready_path.as_bytes(),
        capsule.liveness.metrics_path.as_bytes(),
        &[capsule.custody.root_key_present as u8],
        &[capsule.custody.upgrade_key_present as u8],
        &[capsule.custody.user_spending_keys_present as u8],
        &capsule.created_at_unix.to_le_bytes(),
    ])
}

/// Creates a capsule, validates custody, and computes its hash.
/// Returns `Err` if any custody flag is forbidden.
pub fn create_capsule(
    role: SwarmRole,
    repo_commit: &str,
    manifest_sha256: [u8; 32],
    config_sha256: [u8; 32],
    service_id: &str,
    network: &str,
    caps: SwarmCaps,
    fee_policy_sha256: [u8; 32],
    liveness: LivenessConfig,
    custody: CustodyAttestation,
    created_at_unix: u64,
) -> Result<ServiceCapsule, CapsuleError> {
    assert_no_custody(&custody)?;

    // Build with a zeroed hash first, then recompute.
    let mut capsule = ServiceCapsule {
        schema_version: "1".to_string(),
        role,
        repo_commit: repo_commit.to_string(),
        manifest_sha256,
        config_sha256,
        service_id: service_id.to_string(),
        network: network.to_string(),
        caps,
        fee_policy_sha256,
        liveness,
        custody,
        created_at_unix,
        capsule_hash: [0u8; 32],
    };

    capsule.capsule_hash = compute_capsule_hash(&capsule);
    Ok(capsule)
}

/// Asserts that no forbidden key material is declared in the custody attestation.
pub fn assert_no_custody(custody: &CustodyAttestation) -> Result<(), CapsuleError> {
    if custody.root_key_present {
        return Err(CapsuleError::RootKeyForbidden);
    }
    if custody.upgrade_key_present {
        return Err(CapsuleError::UpgradeKeyForbidden);
    }
    if custody.user_spending_keys_present {
        return Err(CapsuleError::UserKeysPresent);
    }
    Ok(())
}

/// Returns `Err(StaleCapsule)` if the capsule is older than `max_age_seconds`.
pub fn check_freshness(
    capsule: &ServiceCapsule,
    current_unix: u64,
    max_age_seconds: u64,
) -> Result<(), CapsuleError> {
    let age = current_unix.saturating_sub(capsule.created_at_unix);
    if age > max_age_seconds {
        Err(CapsuleError::StaleCapsule { age_seconds: age })
    } else {
        Ok(())
    }
}

/// Detects conflicting capsules: same `service_id` but different `repo_commit`.
pub fn detect_conflict(a: &ServiceCapsule, b: &ServiceCapsule) -> Result<(), CapsuleError> {
    if a.service_id == b.service_id && a.repo_commit != b.repo_commit {
        return Err(CapsuleError::ConflictingServiceId);
    }
    Ok(())
}

/// Computes a `config_sha256` from a JSON string (SHA-256 of its UTF-8 bytes).
pub fn config_sha256_from_json(json: &str) -> [u8; 32] {
    sha256_multi(&[json.as_bytes()])
}

/// Computes a `fee_policy_sha256` from a fee policy string.
pub fn fee_policy_sha256_from_str(policy: &str) -> [u8; 32] {
    sha256_multi(&[policy.as_bytes()])
}

/// Returns a reference to the "better" of two capsules.
/// Ranking criteria (in order of priority):
///   1. Clean custody (no forbidden keys) wins.
///   2. Fresher capsule (larger `created_at_unix`) wins.
///   3. Lower max_deposit_lamports (lower fee cap) wins.
///   4. Tie → return `a`.
pub fn rank_capsules<'a>(
    a: &'a ServiceCapsule,
    b: &'a ServiceCapsule,
    _current_unix: u64,
) -> &'a ServiceCapsule {
    // Check custody cleanliness.
    let a_clean = assert_no_custody(&a.custody).is_ok();
    let b_clean = assert_no_custody(&b.custody).is_ok();

    match (a_clean, b_clean) {
        (true, false) => return a,
        (false, true) => return b,
        _ => {}
    }

    // Both have equal custody posture — prefer the fresher one.
    if a.created_at_unix != b.created_at_unix {
        return if a.created_at_unix > b.created_at_unix {
            a
        } else {
            b
        };
    }

    // Same freshness — prefer lower fee cap.
    if a.caps.max_deposit_lamports <= b.caps.max_deposit_lamports {
        a
    } else {
        b
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn clean_custody() -> CustodyAttestation {
        CustodyAttestation {
            root_key_present: false,
            upgrade_key_present: false,
            user_spending_keys_present: false,
        }
    }

    fn default_caps() -> SwarmCaps {
        SwarmCaps {
            max_total_value_locked_lamports: 1_000_000_000,
            max_deposit_lamports: 50_000_000,
            daily_withdraw_limit_lamports: 100_000_000,
        }
    }

    fn default_liveness() -> LivenessConfig {
        LivenessConfig {
            health_path: "/health".to_string(),
            ready_path: "/ready".to_string(),
            metrics_path: "/metrics".to_string(),
        }
    }

    fn make_capsule(commit: &str, service_id: &str, created_at: u64) -> ServiceCapsule {
        create_capsule(
            SwarmRole::Relayer,
            commit,
            [0xAAu8; 32],
            [0xBBu8; 32],
            service_id,
            "devnet",
            default_caps(),
            [0xCCu8; 32],
            default_liveness(),
            clean_custody(),
            created_at,
        )
        .expect("capsule creation should succeed with clean custody")
    }

    // 1. Capsule hash is deterministic.
    #[test]
    fn test_capsule_hash_deterministic() {
        let c1 = make_capsule("abc123", "relayer-1", 1_700_000_000);
        let c2 = make_capsule("abc123", "relayer-1", 1_700_000_000);
        assert_eq!(c1.capsule_hash, c2.capsule_hash);
    }

    // 2. Different repo_commit → different capsule hash.
    #[test]
    fn test_capsule_hash_changes_with_commit() {
        let c1 = make_capsule("abc123", "relayer-1", 1_700_000_000);
        let c2 = make_capsule("def456", "relayer-1", 1_700_000_000);
        assert_ne!(c1.capsule_hash, c2.capsule_hash);
    }

    // 3. root_key_present → RootKeyForbidden.
    #[test]
    fn test_root_key_forbidden() {
        let bad_custody = CustodyAttestation {
            root_key_present: true,
            upgrade_key_present: false,
            user_spending_keys_present: false,
        };
        let result = create_capsule(
            SwarmRole::Relayer,
            "abc123",
            [0u8; 32],
            [0u8; 32],
            "svc-1",
            "devnet",
            default_caps(),
            [0u8; 32],
            default_liveness(),
            bad_custody,
            1_700_000_000,
        );
        assert_eq!(result, Err(CapsuleError::RootKeyForbidden));
    }

    // 4. upgrade_key_present → UpgradeKeyForbidden.
    #[test]
    fn test_upgrade_key_forbidden() {
        let bad_custody = CustodyAttestation {
            root_key_present: false,
            upgrade_key_present: true,
            user_spending_keys_present: false,
        };
        let result = create_capsule(
            SwarmRole::Prover,
            "abc123",
            [0u8; 32],
            [0u8; 32],
            "svc-2",
            "devnet",
            default_caps(),
            [0u8; 32],
            default_liveness(),
            bad_custody,
            1_700_000_000,
        );
        assert_eq!(result, Err(CapsuleError::UpgradeKeyForbidden));
    }

    // 5. user_spending_keys_present → UserKeysPresent.
    #[test]
    fn test_user_keys_forbidden() {
        let bad_custody = CustodyAttestation {
            root_key_present: false,
            upgrade_key_present: false,
            user_spending_keys_present: true,
        };
        let result = create_capsule(
            SwarmRole::Indexer,
            "abc123",
            [0u8; 32],
            [0u8; 32],
            "svc-3",
            "devnet",
            default_caps(),
            [0u8; 32],
            default_liveness(),
            bad_custody,
            1_700_000_000,
        );
        assert_eq!(result, Err(CapsuleError::UserKeysPresent));
    }

    // 6. Capsule older than 3600s → StaleCapsule.
    #[test]
    fn test_stale_capsule_detected() {
        let capsule = make_capsule("abc123", "relayer-1", 1_700_000_000);
        let current = 1_700_000_000 + 3601;
        let result = check_freshness(&capsule, current, 3600);
        assert!(matches!(
            result,
            Err(CapsuleError::StaleCapsule { age_seconds: 3601 })
        ));
    }

    // 7. Capsule younger than 3600s → Ok.
    #[test]
    fn test_fresh_capsule_accepted() {
        let capsule = make_capsule("abc123", "relayer-1", 1_700_000_000);
        let current = 1_700_000_000 + 3599;
        assert!(check_freshness(&capsule, current, 3600).is_ok());
    }

    // 8. Same service_id, different repo_commit → ConflictingServiceId.
    #[test]
    fn test_conflicting_service_id_detected() {
        let a = make_capsule("commit-aaa", "relayer-7", 1_700_000_000);
        let b = make_capsule("commit-bbb", "relayer-7", 1_700_000_000);
        assert_eq!(
            detect_conflict(&a, &b),
            Err(CapsuleError::ConflictingServiceId)
        );
    }

    // 9. Different service_ids → no conflict.
    #[test]
    fn test_no_conflict_different_service_ids() {
        let a = make_capsule("commit-aaa", "relayer-alpha", 1_700_000_000);
        let b = make_capsule("commit-aaa", "relayer-beta", 1_700_000_000);
        assert!(detect_conflict(&a, &b).is_ok());
    }

    // 10. config_sha256_from_json is deterministic.
    #[test]
    fn test_config_sha256_deterministic() {
        let json = r#"{"rpc":"https://devnet.solana.com","port":8080}"#;
        let h1 = config_sha256_from_json(json);
        let h2 = config_sha256_from_json(json);
        assert_eq!(h1, h2);
    }

    // 11. Different JSON string → different hash.
    #[test]
    fn test_config_sha256_changes_with_content() {
        let h1 = config_sha256_from_json(r#"{"port":8080}"#);
        let h2 = config_sha256_from_json(r#"{"port":9090}"#);
        assert_ne!(h1, h2);
    }

    // 12. rank_capsules prefers the fresher capsule.
    #[test]
    fn test_rank_capsules_prefers_fresher() {
        let old = make_capsule("commit-old", "relayer-x", 1_700_000_000);
        let new = make_capsule("commit-new", "relayer-x", 1_700_001_000);
        let current = 1_700_002_000;
        let winner = rank_capsules(&old, &new, current);
        // Fresher capsule has created_at = 1_700_001_000 which is `new`.
        assert_eq!(winner.repo_commit, "commit-new");
    }

    // 13. Capsule with all-false custody is accepted.
    #[test]
    fn test_capsule_custody_all_false_ok() {
        let custody = CustodyAttestation {
            root_key_present: false,
            upgrade_key_present: false,
            user_spending_keys_present: false,
        };
        assert!(assert_no_custody(&custody).is_ok());
    }
}
