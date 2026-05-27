use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComplianceRule {
    pub rule_id: [u8; 32],
    pub rule_hash: [u8; 32],
    pub issuer_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComplianceAttestation {
    pub attestation_id: [u8; 32],
    pub rule_id: [u8; 32],
    pub subject_hash: [u8; 32],
    pub passes: bool,
    pub proof_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum ComplianceError {
    ZeroIssuerSecret,
    ZeroSubjectSecret,
    EmptyRule,
    RuleNotSatisfied,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn hex32(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn compute_issuer_hash(issuer_secret: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"comply-issuer-v1", issuer_secret])
}

fn compute_rule_hash(rule_bytes: &[u8]) -> [u8; 32] {
    sha256_multi(&[b"comply-rule-v1", rule_bytes])
}

fn compute_rule_id(issuer_hash: &[u8; 32], rule_hash: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"comply-rule-id-v1", issuer_hash, rule_hash])
}

fn compute_subject_hash(subject_secret: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"comply-subject-v1", subject_secret])
}

fn compute_proof_hash(rule_id: &[u8; 32], subject_hash: &[u8; 32], passes: bool) -> [u8; 32] {
    sha256_multi(&[b"comply-proof-v1", rule_id, subject_hash, &[passes as u8]])
}

fn compute_attestation_id(proof_hash: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"comply-attest-v1", proof_hash])
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn create_rule(
    issuer_secret: &[u8; 32],
    rule_bytes: &[u8],
) -> Result<ComplianceRule, ComplianceError> {
    if issuer_secret == &[0u8; 32] {
        return Err(ComplianceError::ZeroIssuerSecret);
    }
    if rule_bytes.is_empty() {
        return Err(ComplianceError::EmptyRule);
    }
    let issuer_hash = compute_issuer_hash(issuer_secret);
    let rule_hash = compute_rule_hash(rule_bytes);
    let rule_id = compute_rule_id(&issuer_hash, &rule_hash);
    Ok(ComplianceRule {
        rule_id,
        rule_hash,
        issuer_hash,
        mainnet_ready: false,
    })
}

pub fn attest(
    rule: &ComplianceRule,
    subject_secret: &[u8; 32],
    passes: bool,
) -> Result<ComplianceAttestation, ComplianceError> {
    if subject_secret == &[0u8; 32] {
        return Err(ComplianceError::ZeroSubjectSecret);
    }
    if !passes {
        return Err(ComplianceError::RuleNotSatisfied);
    }
    let subject_hash = compute_subject_hash(subject_secret);
    let proof_hash = compute_proof_hash(&rule.rule_id, &subject_hash, passes);
    let attestation_id = compute_attestation_id(&proof_hash);
    Ok(ComplianceAttestation {
        attestation_id,
        rule_id: rule.rule_id,
        subject_hash,
        passes,
        proof_hash,
        mainnet_ready: false,
    })
}

pub fn verify_attestation(rule: &ComplianceRule, attestation: &ComplianceAttestation) -> bool {
    if attestation.rule_id != rule.rule_id {
        return false;
    }
    let expected_proof =
        compute_proof_hash(&rule.rule_id, &attestation.subject_hash, attestation.passes);
    if expected_proof != attestation.proof_hash {
        return false;
    }
    let expected_id = compute_attestation_id(&expected_proof);
    expected_id == attestation.attestation_id
}

pub fn attestation_public_record(att: &ComplianceAttestation) -> String {
    serde_json::json!({
        "attestation_id": hex32(&att.attestation_id),
        "rule_id":        hex32(&att.rule_id),
        "passes":         att.passes,
        "mainnet_ready":  att.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn secret(b: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = b;
        s
    }

    // Test 1: create rule + attest + verify
    #[test]
    fn test_create_attest_verify() {
        let rule = create_rule(&secret(0x11), b"age >= 18").unwrap();
        assert!(!rule.mainnet_ready);
        let att = attest(&rule, &secret(0x22), true).unwrap();
        assert!(!att.mainnet_ready);
        assert!(att.passes);
        assert!(verify_attestation(&rule, &att));
    }

    // Test 2: rule not satisfied rejected
    #[test]
    fn test_rule_not_satisfied_rejected() {
        let rule = create_rule(&secret(0x11), b"kyc-verified").unwrap();
        let err = attest(&rule, &secret(0x22), false).unwrap_err();
        assert_eq!(err, ComplianceError::RuleNotSatisfied);
    }

    // Test 3: zero issuer rejected
    #[test]
    fn test_zero_issuer_rejected() {
        let err = create_rule(&[0u8; 32], b"some-rule").unwrap_err();
        assert_eq!(err, ComplianceError::ZeroIssuerSecret);
    }

    // Test 4: zero subject rejected
    #[test]
    fn test_zero_subject_rejected() {
        let rule = create_rule(&secret(0x11), b"some-rule").unwrap();
        let err = attest(&rule, &[0u8; 32], true).unwrap_err();
        assert_eq!(err, ComplianceError::ZeroSubjectSecret);
    }

    // Test 5: attestation_id deterministic
    #[test]
    fn test_attestation_id_deterministic() {
        let rule = create_rule(&secret(0x33), b"balance >= 0").unwrap();
        let att1 = attest(&rule, &secret(0x44), true).unwrap();
        let att2 = attest(&rule, &secret(0x44), true).unwrap();
        assert_eq!(att1.attestation_id, att2.attestation_id);
        assert_eq!(att1.proof_hash, att2.proof_hash);
        // Different subject → different attestation
        let att3 = attest(&rule, &secret(0x55), true).unwrap();
        assert_ne!(att1.attestation_id, att3.attestation_id);
    }

    // Test 6: public record hides subject_hash
    #[test]
    fn test_public_record_hides_subject() {
        let rule = create_rule(&secret(0x11), b"gdpr-consent").unwrap();
        let att = attest(&rule, &secret(0x22), true).unwrap();
        let record = attestation_public_record(&att);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["attestation_id"].is_string());
        assert!(v["rule_id"].is_string());
        assert_eq!(v["passes"], true);
        assert_eq!(v["mainnet_ready"], false);
        // subject_hash must NOT appear
        assert!(v.get("subject_hash").is_none());
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_rule_mainnet_ready_false() {
        let rule = create_rule(&secret(0x11), b"rule-bytes").unwrap();
        assert!(!rule.mainnet_ready);
    }

    #[test]
    fn test_attestation_mainnet_ready_false() {
        let rule = create_rule(&secret(0x11), b"rule-bytes").unwrap();
        let att = attest(&rule, &secret(0x22), true).unwrap();
        assert!(!att.mainnet_ready);
    }

    #[test]
    fn test_rule_id_deterministic() {
        let r1 = create_rule(&secret(0xAA), b"rule-abc").unwrap();
        let r2 = create_rule(&secret(0xAA), b"rule-abc").unwrap();
        assert_eq!(r1.rule_id, r2.rule_id);
    }

    #[test]
    fn test_rule_id_rule_sensitive() {
        let r1 = create_rule(&secret(0xAA), b"rule-one").unwrap();
        let r2 = create_rule(&secret(0xAA), b"rule-two").unwrap();
        assert_ne!(r1.rule_id, r2.rule_id);
    }

    #[test]
    fn test_rule_id_issuer_sensitive() {
        let r1 = create_rule(&secret(0x01), b"same-rule").unwrap();
        let r2 = create_rule(&secret(0x02), b"same-rule").unwrap();
        assert_ne!(r1.rule_id, r2.rule_id);
    }

    #[test]
    fn test_empty_rule_rejected() {
        let err = create_rule(&secret(0x11), b"").unwrap_err();
        assert_eq!(err, ComplianceError::EmptyRule);
    }

    #[test]
    fn test_tampered_rule_id_fails_verify() {
        let rule = create_rule(&secret(0x11), b"some-rule").unwrap();
        let mut att = attest(&rule, &secret(0x22), true).unwrap();
        att.rule_id[0] ^= 0xFF; // tamper the rule_id in the attestation
        assert!(!verify_attestation(&rule, &att));
    }

    #[test]
    fn test_subject_hash_differs_between_subjects() {
        let rule = create_rule(&secret(0x11), b"rule").unwrap();
        let att1 = attest(&rule, &secret(0x01), true).unwrap();
        let att2 = attest(&rule, &secret(0x02), true).unwrap();
        assert_ne!(att1.subject_hash, att2.subject_hash);
    }

    #[test]
    fn test_proof_hash_nonzero() {
        let rule = create_rule(&secret(0x11), b"rule").unwrap();
        let att = attest(&rule, &secret(0x22), true).unwrap();
        assert_ne!(att.proof_hash, [0u8; 32]);
    }

    #[test]
    fn test_attestation_id_nonzero() {
        let rule = create_rule(&secret(0x11), b"rule").unwrap();
        let att = attest(&rule, &secret(0x22), true).unwrap();
        assert_ne!(att.attestation_id, [0u8; 32]);
    }
}
