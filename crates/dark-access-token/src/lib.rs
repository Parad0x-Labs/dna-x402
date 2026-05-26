use sha2::{Digest, Sha256};

// ── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct AccessToken {
    /// SHA256("access-token-v1" || issuer_hash || scope_hash || holder_hash || issued_at_le || expires_at_le)
    pub token_id: [u8; 32],
    /// SHA256("issuer-hash-v1" || issuer_secret)
    pub issuer_hash: [u8; 32],
    /// SHA256("scope-hash-v1" || scope_bytes)
    pub scope_hash: [u8; 32],
    /// SHA256("holder-hash-v1" || holder_secret)
    pub holder_hash: [u8; 32],
    pub issued_at_unix: i64,
    pub expires_at_unix: i64,
    pub revoked: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone)]
pub struct TokenVerification {
    pub token_id: [u8; 32],
    pub scope_hash: [u8; 32],
    pub verified: bool,
    pub verified_at_unix: i64,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum TokenError {
    IssuerSecretZero,
    HolderSecretZero,
    ScopeEmpty,
    TokenExpired { expired_at: i64, current: i64 },
    TokenRevoked,
    ScopeMismatch,
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ── Public API ───────────────────────────────────────────────────────────────

/// Issue a time-bounded capability token.
///
/// The token is entirely commitment-based: verification requires only the
/// public token fields and the raw `scope_bytes` — no issuer online presence.
pub fn issue_token(
    issuer_secret: &[u8; 32],
    holder_secret: &[u8; 32],
    scope_bytes: &[u8],
    issued_at_unix: i64,
    expires_at_unix: i64,
) -> Result<AccessToken, TokenError> {
    if issuer_secret == &[0u8; 32] {
        return Err(TokenError::IssuerSecretZero);
    }
    if holder_secret == &[0u8; 32] {
        return Err(TokenError::HolderSecretZero);
    }
    if scope_bytes.is_empty() {
        return Err(TokenError::ScopeEmpty);
    }

    // issuer_hash = SHA256("issuer-hash-v1" || issuer_secret)
    let issuer_hash = {
        let mut preimage = b"issuer-hash-v1".to_vec();
        preimage.extend_from_slice(issuer_secret);
        sha256(&preimage)
    };

    // scope_hash = SHA256("scope-hash-v1" || scope_bytes)
    let scope_hash = {
        let mut preimage = b"scope-hash-v1".to_vec();
        preimage.extend_from_slice(scope_bytes);
        sha256(&preimage)
    };

    // holder_hash = SHA256("holder-hash-v1" || holder_secret)
    let holder_hash = {
        let mut preimage = b"holder-hash-v1".to_vec();
        preimage.extend_from_slice(holder_secret);
        sha256(&preimage)
    };

    // token_id = SHA256("access-token-v1" || issuer_hash || scope_hash
    //                   || holder_hash || issued_at_le || expires_at_le)
    let token_id = {
        let mut preimage = b"access-token-v1".to_vec();
        preimage.extend_from_slice(&issuer_hash);
        preimage.extend_from_slice(&scope_hash);
        preimage.extend_from_slice(&holder_hash);
        preimage.extend_from_slice(&issued_at_unix.to_le_bytes());
        preimage.extend_from_slice(&expires_at_unix.to_le_bytes());
        sha256(&preimage)
    };

    Ok(AccessToken {
        token_id,
        issuer_hash,
        scope_hash,
        holder_hash,
        issued_at_unix,
        expires_at_unix,
        revoked: false,
        mainnet_ready: false,
    })
}

/// Verify a token against a scope and a current wall-clock time.
///
/// Checks (in order): revocation, expiry, scope binding.
pub fn verify_token(
    token: &AccessToken,
    scope_bytes: &[u8],
    current_unix: i64,
) -> Result<TokenVerification, TokenError> {
    if token.revoked {
        return Err(TokenError::TokenRevoked);
    }

    if current_unix > token.expires_at_unix {
        return Err(TokenError::TokenExpired {
            expired_at: token.expires_at_unix,
            current: current_unix,
        });
    }

    // Recompute scope_hash and compare
    let scope_hash = {
        let mut preimage = b"scope-hash-v1".to_vec();
        preimage.extend_from_slice(scope_bytes);
        sha256(&preimage)
    };

    if scope_hash != token.scope_hash {
        return Err(TokenError::ScopeMismatch);
    }

    Ok(TokenVerification {
        token_id: token.token_id,
        scope_hash,
        verified: true,
        verified_at_unix: current_unix,
        mainnet_ready: token.mainnet_ready,
    })
}

/// Revoke a token in place; subsequent `verify_token` calls will return
/// `TokenError::TokenRevoked`.
pub fn revoke_token(token: &mut AccessToken) {
    token.revoked = true;
}

/// Return a JSON public record for the token.
///
/// Includes `token_id` and `scope_hash` (as hex), timestamps, `revoked`, and
/// `mainnet_ready`.  Does NOT include `issuer_hash` or `holder_hash` — those
/// remain private to issuer and holder respectively.
pub fn token_public_record(token: &AccessToken) -> String {
    serde_json::json!({
        "token_id":       hex(&token.token_id),
        "scope_hash":     hex(&token.scope_hash),
        "issued_at_unix": token.issued_at_unix,
        "expires_at_unix": token.expires_at_unix,
        "revoked":        token.revoked,
        "mainnet_ready":  token.mainnet_ready,
    })
    .to_string()
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn issuer() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xAB;
        s[31] = 0xCD;
        s
    }

    fn holder() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0x12;
        s[31] = 0x34;
        s
    }

    const SCOPE: &[u8] = b"dna:x402:read:receipts";
    const T0: i64 = 1_700_000_000;
    const T1: i64 = 1_700_003_600; // +1 hour

    #[test]
    fn test_issue_and_verify_happy_path() {
        let token = issue_token(&issuer(), &holder(), SCOPE, T0, T1)
            .expect("issue should succeed");

        assert!(!token.revoked);
        assert!(!token.mainnet_ready);

        // Verify at exactly T0 (well within window)
        let v = verify_token(&token, SCOPE, T0).expect("verify should succeed");
        assert!(v.verified);
        assert_eq!(v.token_id, token.token_id);
        assert_eq!(v.scope_hash, token.scope_hash);
        assert_eq!(v.verified_at_unix, T0);
        assert!(!v.mainnet_ready);
    }

    #[test]
    fn test_expired_token_rejected() {
        let token = issue_token(&issuer(), &holder(), SCOPE, T0, T1)
            .expect("issue should succeed");

        let current = T1 + 1; // one second past expiry
        let err = verify_token(&token, SCOPE, current).unwrap_err();
        assert_eq!(
            err,
            TokenError::TokenExpired {
                expired_at: T1,
                current,
            }
        );
    }

    #[test]
    fn test_revoked_token_rejected() {
        let mut token = issue_token(&issuer(), &holder(), SCOPE, T0, T1)
            .expect("issue should succeed");

        revoke_token(&mut token);
        assert!(token.revoked);

        let err = verify_token(&token, SCOPE, T0).unwrap_err();
        assert_eq!(err, TokenError::TokenRevoked);
    }

    #[test]
    fn test_scope_mismatch_rejected() {
        let token = issue_token(&issuer(), &holder(), SCOPE, T0, T1)
            .expect("issue should succeed");

        let wrong_scope = b"dna:x402:write:receipts";
        let err = verify_token(&token, wrong_scope, T0).unwrap_err();
        assert_eq!(err, TokenError::ScopeMismatch);
    }

    #[test]
    fn test_zero_issuer_secret_rejected() {
        let zero = [0u8; 32];
        let err = issue_token(&zero, &holder(), SCOPE, T0, T1).unwrap_err();
        assert_eq!(err, TokenError::IssuerSecretZero);
    }

    #[test]
    fn test_public_record_hides_identities() {
        let token = issue_token(&issuer(), &holder(), SCOPE, T0, T1)
            .expect("issue should succeed");

        let record = token_public_record(&token);

        let issuer_hex = hex(&token.issuer_hash);
        let holder_hex = hex(&token.holder_hash);

        assert!(
            !record.contains(&issuer_hex),
            "public record must not expose issuer_hash"
        );
        assert!(
            !record.contains(&holder_hex),
            "public record must not expose holder_hash"
        );

        // Sanity: token_id and scope_hash ARE present
        assert!(record.contains(&hex(&token.token_id)));
        assert!(record.contains(&hex(&token.scope_hash)));
    }
}
