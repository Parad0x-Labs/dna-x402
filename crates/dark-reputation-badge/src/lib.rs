use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReputationBadge {
    pub badge_id: [u8; 32],
    pub holder_hash: [u8; 32],
    pub issuer_hash: [u8; 32],
    pub level: u8,
    pub domain_hash: [u8; 32],
    pub issued_at_unix: i64,
    pub expires_at_unix: i64,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BadgePresentation {
    pub pseudonym: [u8; 32],
    pub badge_id: [u8; 32],
    pub domain_hash: [u8; 32],
    pub level: u8,
    pub presented_at_unix: i64,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum BadgeError {
    ZeroHolderSecret,
    ZeroIssuerSecret,
    EmptyDomain,
    LevelZero,
    BadgeExpired { expired_at: i64, current: i64 },
    DomainMismatch,
}

// ---------------------------------------------------------------------------
// Internal hash helpers
// ---------------------------------------------------------------------------

fn hash_holder(holder_secret: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"badge-holder-v1");
    h.update(holder_secret);
    h.finalize().into()
}

fn hash_issuer(issuer_secret: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"badge-issuer-v1");
    h.update(issuer_secret);
    h.finalize().into()
}

fn hash_domain(domain_bytes: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"badge-domain-v1");
    h.update(domain_bytes);
    h.finalize().into()
}

fn compute_badge_id(
    holder_hash: &[u8; 32],
    issuer_hash: &[u8; 32],
    domain_hash: &[u8; 32],
    level: u8,
    issued_at: i64,
    expires_at: i64,
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"badge-id-v1");
    h.update(holder_hash);
    h.update(issuer_hash);
    h.update(domain_hash);
    h.update([level]);
    h.update(issued_at.to_le_bytes());
    h.update(expires_at.to_le_bytes());
    h.finalize().into()
}

fn compute_pseudonym(badge_id: &[u8; 32], holder_secret: &[u8; 32], nonce: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"badge-pseudo-v1");
    h.update(badge_id);
    h.update(holder_secret);
    h.update(nonce);
    h.finalize().into()
}

fn is_zero(bytes: &[u8; 32]) -> bool {
    bytes.iter().all(|&b| b == 0)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Issue a new reputation badge.
///
/// `mainnet_ready` is always `false` — this is a pre-production implementation.
pub fn issue_badge(
    issuer_secret: &[u8; 32],
    holder_secret: &[u8; 32],
    domain_bytes: &[u8],
    level: u8,
    issued_at: i64,
    expires_at: i64,
) -> Result<ReputationBadge, BadgeError> {
    if is_zero(holder_secret) {
        return Err(BadgeError::ZeroHolderSecret);
    }
    if is_zero(issuer_secret) {
        return Err(BadgeError::ZeroIssuerSecret);
    }
    if domain_bytes.is_empty() {
        return Err(BadgeError::EmptyDomain);
    }
    if level == 0 {
        return Err(BadgeError::LevelZero);
    }

    let holder_hash = hash_holder(holder_secret);
    let issuer_hash = hash_issuer(issuer_secret);
    let domain_hash = hash_domain(domain_bytes);
    let badge_id = compute_badge_id(&holder_hash, &issuer_hash, &domain_hash, level, issued_at, expires_at);

    Ok(ReputationBadge {
        badge_id,
        holder_hash,
        issuer_hash,
        level,
        domain_hash,
        issued_at_unix: issued_at,
        expires_at_unix: expires_at,
        mainnet_ready: false,
    })
}

/// Present a badge for verification.
///
/// Produces an unlinkable `BadgePresentation` whose `pseudonym` is unique per nonce.
/// `mainnet_ready` is always `false`.
pub fn present_badge(
    badge: &ReputationBadge,
    holder_secret: &[u8; 32],
    nonce: &[u8; 32],
    domain_bytes: &[u8],
    current_unix: i64,
) -> Result<BadgePresentation, BadgeError> {
    if current_unix > badge.expires_at_unix {
        return Err(BadgeError::BadgeExpired {
            expired_at: badge.expires_at_unix,
            current: current_unix,
        });
    }

    let domain_hash = hash_domain(domain_bytes);
    if domain_hash != badge.domain_hash {
        return Err(BadgeError::DomainMismatch);
    }

    let pseudonym = compute_pseudonym(&badge.badge_id, holder_secret, nonce);

    Ok(BadgePresentation {
        pseudonym,
        badge_id: badge.badge_id,
        domain_hash: badge.domain_hash,
        level: badge.level,
        presented_at_unix: current_unix,
        mainnet_ready: false,
    })
}

/// Verify that a presentation matches the original badge (badge_id and level match).
pub fn verify_presentation(badge: &ReputationBadge, presentation: &BadgePresentation) -> bool {
    badge.badge_id == presentation.badge_id && badge.level == presentation.level
}

/// Return a JSON public record for the badge.
///
/// DOES NOT include `holder_hash` or `issuer_hash` — those remain private.
pub fn badge_public_record(badge: &ReputationBadge) -> String {
    serde_json::json!({
        "badge_id": hex::encode(badge.badge_id),
        "domain_hash": hex::encode(badge.domain_hash),
        "level": badge.level,
        "issued_at_unix": badge.issued_at_unix,
        "expires_at_unix": badge.expires_at_unix,
        "mainnet_ready": badge.mainnet_ready,
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Minimal hex encoder (avoids adding a dep — hex is not in Cargo.toml)
// ---------------------------------------------------------------------------

mod hex {
    pub fn encode(bytes: [u8; 32]) -> String {
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn issuer() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xAB;
        s
    }

    fn holder() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xCD;
        s
    }

    fn nonce(seed: u8) -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = seed;
        n
    }

    const DOMAIN: &[u8] = b"defi.dark.test";
    const ISSUED: i64 = 1_700_000_000;
    const EXPIRES: i64 = 1_800_000_000;

    #[test]
    fn test_issue_present_verify() {
        let badge = issue_badge(&issuer(), &holder(), DOMAIN, 3, ISSUED, EXPIRES)
            .expect("issue_badge should succeed");

        assert!(!badge.mainnet_ready, "mainnet_ready must be false after issue");

        let presentation = present_badge(&badge, &holder(), &nonce(1), DOMAIN, ISSUED + 1000)
            .expect("present_badge should succeed");

        assert!(!presentation.mainnet_ready, "mainnet_ready must be false after present");
        assert!(verify_presentation(&badge, &presentation), "presentation should verify");
    }

    #[test]
    fn test_expired_badge_rejected() {
        let badge = issue_badge(&issuer(), &holder(), DOMAIN, 2, ISSUED, EXPIRES)
            .expect("issue_badge should succeed");

        let current = EXPIRES + 1;
        let err = present_badge(&badge, &holder(), &nonce(1), DOMAIN, current)
            .expect_err("should fail with BadgeExpired");

        assert_eq!(
            err,
            BadgeError::BadgeExpired { expired_at: EXPIRES, current },
            "wrong error variant"
        );
    }

    #[test]
    fn test_domain_mismatch_rejected() {
        let badge = issue_badge(&issuer(), &holder(), DOMAIN, 2, ISSUED, EXPIRES)
            .expect("issue_badge should succeed");

        let err = present_badge(&badge, &holder(), &nonce(1), b"other.domain", ISSUED + 1)
            .expect_err("should fail with DomainMismatch");

        assert_eq!(err, BadgeError::DomainMismatch, "wrong error variant");
    }

    #[test]
    fn test_pseudonym_unlinkable_per_nonce() {
        let badge = issue_badge(&issuer(), &holder(), DOMAIN, 5, ISSUED, EXPIRES)
            .expect("issue_badge should succeed");

        let p1 = present_badge(&badge, &holder(), &nonce(1), DOMAIN, ISSUED + 1)
            .expect("present 1 should succeed");
        let p2 = present_badge(&badge, &holder(), &nonce(2), DOMAIN, ISSUED + 1)
            .expect("present 2 should succeed");

        assert_ne!(p1.pseudonym, p2.pseudonym, "pseudonyms must differ per nonce");
    }

    #[test]
    fn test_zero_holder_rejected() {
        let zero_holder = [0u8; 32];
        let err = issue_badge(&issuer(), &zero_holder, DOMAIN, 1, ISSUED, EXPIRES)
            .expect_err("should fail with ZeroHolderSecret");

        assert_eq!(err, BadgeError::ZeroHolderSecret, "wrong error variant");
    }

    #[test]
    fn test_public_record_hides_holder_issuer() {
        let badge = issue_badge(&issuer(), &holder(), DOMAIN, 4, ISSUED, EXPIRES)
            .expect("issue_badge should succeed");

        let record = badge_public_record(&badge);

        let holder_hex = hex::encode(badge.holder_hash);
        let issuer_hex = hex::encode(badge.issuer_hash);

        assert!(
            !record.contains(&holder_hex),
            "public record must not contain holder_hash"
        );
        assert!(
            !record.contains(&issuer_hex),
            "public record must not contain issuer_hash"
        );

        // Sanity-check the record is valid JSON and has expected keys
        let v: serde_json::Value = serde_json::from_str(&record).expect("record must be valid JSON");
        assert!(v.get("badge_id").is_some());
        assert!(v.get("domain_hash").is_some());
        assert!(v.get("level").is_some());
        assert!(v.get("mainnet_ready").is_some());
        assert_eq!(v["mainnet_ready"], false);
    }
}
