use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InsurancePolicy {
    pub policy_id: [u8; 32],
    pub insured_hash: [u8; 32],
    pub coverage_hash: [u8; 32],
    pub premium: u64,
    pub payout: u64,
    pub active: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claim {
    pub claim_id: [u8; 32],
    pub policy_id: [u8; 32],
    pub claimant_hash: [u8; 32],
    pub event_hash: [u8; 32],
    pub approved: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum InsuranceError {
    ZeroInsuredSecret,
    ZeroPremium,
    ZeroPayout,
    PolicyInactive,
    ClaimAlreadyFiled,
}

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

fn sha256_2(a: &[u8], b: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(a);
    h.update(b);
    h.finalize().into()
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

/// insured_hash = SHA256("insur-insured-v1" || insured_secret)
fn compute_insured_hash(insured_secret: &[u8; 32]) -> [u8; 32] {
    sha256_2(b"insur-insured-v1", insured_secret)
}

/// coverage_hash = SHA256("insur-coverage-v1" || coverage_bytes)
fn compute_coverage_hash(coverage_bytes: &[u8]) -> [u8; 32] {
    sha256_2(b"insur-coverage-v1", coverage_bytes)
}

/// policy_id = SHA256("insur-policy-v1" || insured_hash || coverage_hash || premium_le || payout_le || nonce)
fn compute_policy_id(
    insured_hash: &[u8; 32],
    coverage_hash: &[u8; 32],
    premium: u64,
    payout: u64,
    nonce: &[u8; 32],
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"insur-policy-v1");
    hasher.update(insured_hash);
    hasher.update(coverage_hash);
    hasher.update(&premium.to_le_bytes());
    hasher.update(&payout.to_le_bytes());
    hasher.update(nonce);
    hasher.finalize().into()
}

/// claimant_hash = SHA256("insur-claimant-v1" || claimant_secret)
fn compute_claimant_hash(claimant_secret: &[u8; 32]) -> [u8; 32] {
    sha256_2(b"insur-claimant-v1", claimant_secret)
}

/// event_hash = SHA256("insur-event-v1" || event_bytes)
fn compute_event_hash(event_bytes: &[u8]) -> [u8; 32] {
    sha256_2(b"insur-event-v1", event_bytes)
}

/// claim_id = SHA256("insur-claim-v1" || policy_id || claimant_hash || event_hash)
fn compute_claim_id(
    policy_id: &[u8; 32],
    claimant_hash: &[u8; 32],
    event_hash: &[u8; 32],
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"insur-claim-v1");
    hasher.update(policy_id);
    hasher.update(claimant_hash);
    hasher.update(event_hash);
    hasher.finalize().into()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Create a privacy-preserving insurance policy.
///
/// Errors: ZeroInsuredSecret, ZeroPremium, ZeroPayout
pub fn create_policy(
    insured_secret: &[u8; 32],
    coverage_bytes: &[u8],
    premium: u64,
    payout: u64,
    nonce: &[u8; 32],
) -> Result<InsurancePolicy, InsuranceError> {
    if *insured_secret == [0u8; 32] {
        return Err(InsuranceError::ZeroInsuredSecret);
    }
    if premium == 0 {
        return Err(InsuranceError::ZeroPremium);
    }
    if payout == 0 {
        return Err(InsuranceError::ZeroPayout);
    }

    let insured_hash = compute_insured_hash(insured_secret);
    let coverage_hash = compute_coverage_hash(coverage_bytes);
    let policy_id = compute_policy_id(&insured_hash, &coverage_hash, premium, payout, nonce);

    Ok(InsurancePolicy {
        policy_id,
        insured_hash,
        coverage_hash,
        premium,
        payout,
        active: true,
        mainnet_ready: false,
    })
}

/// File a claim against an active policy.
///
/// Errors: PolicyInactive
pub fn file_claim(
    policy: &InsurancePolicy,
    claimant_secret: &[u8; 32],
    event_bytes: &[u8],
) -> Result<Claim, InsuranceError> {
    if !policy.active {
        return Err(InsuranceError::PolicyInactive);
    }

    let claimant_hash = compute_claimant_hash(claimant_secret);
    let event_hash = compute_event_hash(event_bytes);
    let claim_id = compute_claim_id(&policy.policy_id, &claimant_hash, &event_hash);

    Ok(Claim {
        claim_id,
        policy_id: policy.policy_id,
        claimant_hash,
        event_hash,
        approved: false,
        mainnet_ready: false,
    })
}

/// Approve a claim (sets approved=true).
pub fn approve_claim(claim: &mut Claim) {
    claim.approved = true;
}

/// Public JSON record: exposes policy_id, coverage_hash, premium, payout, active, mainnet_ready.
/// Does NOT expose insured_hash.
pub fn policy_public_record(policy: &InsurancePolicy) -> String {
    let pid_hex: String = policy
        .policy_id
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    let cov_hex: String = policy
        .coverage_hash
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    serde_json::json!({
        "policy_id": pid_hex,
        "coverage_hash": cov_hex,
        "premium": policy.premium,
        "payout": policy.payout,
        "active": policy.active,
        "mainnet_ready": policy.mainnet_ready,
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn insured_secret() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xAA;
        s
    }

    fn claimant_secret() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xBB;
        s
    }

    fn nonce() -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = 0x11;
        n
    }

    #[test]
    fn test_create_file_approve() {
        let policy = create_policy(
            &insured_secret(),
            b"fire-damage-coverage",
            100,
            10_000,
            &nonce(),
        )
        .unwrap();
        assert!(policy.active);
        assert!(!policy.mainnet_ready);

        let mut claim = file_claim(&policy, &claimant_secret(), b"fire-event-2025").unwrap();
        assert!(!claim.approved);
        assert!(!claim.mainnet_ready);

        approve_claim(&mut claim);
        assert!(claim.approved);
    }

    #[test]
    fn test_inactive_policy_rejected() {
        let mut policy =
            create_policy(&insured_secret(), b"coverage", 100, 1000, &nonce()).unwrap();
        policy.active = false;

        let err = file_claim(&policy, &claimant_secret(), b"event").unwrap_err();
        assert_eq!(err, InsuranceError::PolicyInactive);
    }

    #[test]
    fn test_zero_insured_rejected() {
        let err = create_policy(&[0u8; 32], b"coverage", 100, 1000, &nonce()).unwrap_err();
        assert_eq!(err, InsuranceError::ZeroInsuredSecret);
    }

    #[test]
    fn test_zero_premium_rejected() {
        let err = create_policy(&insured_secret(), b"coverage", 0, 1000, &nonce()).unwrap_err();
        assert_eq!(err, InsuranceError::ZeroPremium);
    }

    #[test]
    fn test_claim_id_deterministic() {
        let policy =
            create_policy(&insured_secret(), b"life-coverage", 200, 50_000, &nonce()).unwrap();

        let c1 = file_claim(&policy, &claimant_secret(), b"death-event").unwrap();
        let c2 = file_claim(&policy, &claimant_secret(), b"death-event").unwrap();
        assert_eq!(c1.claim_id, c2.claim_id);
    }

    #[test]
    fn test_public_record_hides_insured() {
        let policy =
            create_policy(&insured_secret(), b"health-coverage", 50, 5_000, &nonce()).unwrap();

        let record = policy_public_record(&policy);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();

        // insured_hash must NOT appear in public record
        let insured_hash_hex: String = policy
            .insured_hash
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();
        assert!(!record.contains(&insured_hash_hex));

        // Required fields
        assert!(v["policy_id"].is_string());
        assert!(v["coverage_hash"].is_string());
        assert_eq!(v["mainnet_ready"], false);
        assert!(v.get("insured_hash").is_none());
    }
}
