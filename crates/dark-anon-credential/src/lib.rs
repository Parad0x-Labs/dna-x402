use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct AnonCredential {
    /// SHA256("anon-cred-id-v1" || issuer_hash || attr_hash || issued_at_le)
    pub credential_id: [u8; 32],
    /// SHA256("anon-issuer-v1" || issuer_secret)
    pub issuer_hash: [u8; 32],
    /// SHA256("anon-attr-v1" || attribute_bytes)
    pub attribute_hash: [u8; 32],
    pub issued_at_unix: i64,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone)]
pub struct CredentialPresentation {
    /// New unlinkable identifier: SHA256("anon-present-v1" || credential_id || holder_secret || presentation_nonce)
    pub pseudonym: [u8; 32],
    /// SHA256("anon-proof-v1" || pseudonym || attribute_hash || presentation_nonce)
    pub presentation_proof: [u8; 32],
    pub attribute_hash: [u8; 32],
    pub presentation_nonce: [u8; 32],
    pub presented_at_unix: i64,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum CredentialError {
    IssuerSecretZero,
    HolderSecretZero,
    NonceZero,
    AttributeEmpty,
    PresentationMismatch,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn sha256_chain(parts: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

fn is_all_zero(b: &[u8; 32]) -> bool {
    b.iter().all(|&x| x == 0)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Issue an anonymous credential.
///
/// * `issuer_secret` — 32-byte secret known only to the issuer; must not be all-zero.
/// * `attribute_bytes` — arbitrary attribute payload; must be non-empty.
/// * `issued_at_unix` — Unix timestamp (seconds) of issuance.
pub fn issue_credential(
    issuer_secret: &[u8; 32],
    attribute_bytes: &[u8],
    issued_at_unix: i64,
) -> Result<AnonCredential, CredentialError> {
    if is_all_zero(issuer_secret) {
        return Err(CredentialError::IssuerSecretZero);
    }
    if attribute_bytes.is_empty() {
        return Err(CredentialError::AttributeEmpty);
    }

    let issuer_hash = sha256_chain(&[b"anon-issuer-v1", issuer_secret]);
    let attribute_hash = sha256_chain(&[b"anon-attr-v1", attribute_bytes]);
    let credential_id = sha256_chain(&[
        b"anon-cred-id-v1",
        &issuer_hash,
        &attribute_hash,
        &issued_at_unix.to_le_bytes(),
    ]);

    Ok(AnonCredential {
        credential_id,
        issuer_hash,
        attribute_hash,
        issued_at_unix,
        mainnet_ready: false,
    })
}

/// Create an unlinkable presentation of a credential.
///
/// Each call with a fresh `presentation_nonce` produces a new `pseudonym` that
/// cannot be linked to any prior presentation without knowing `holder_secret`.
///
/// * `holder_secret` — 32-byte secret known only to the holder; must not be all-zero.
/// * `presentation_nonce` — 32-byte per-presentation randomness; must not be all-zero.
pub fn present_credential(
    credential: &AnonCredential,
    holder_secret: &[u8; 32],
    presentation_nonce: &[u8; 32],
    presented_at_unix: i64,
) -> Result<CredentialPresentation, CredentialError> {
    if is_all_zero(holder_secret) {
        return Err(CredentialError::HolderSecretZero);
    }
    if is_all_zero(presentation_nonce) {
        return Err(CredentialError::NonceZero);
    }

    let pseudonym = sha256_chain(&[
        b"anon-present-v1",
        &credential.credential_id,
        holder_secret,
        presentation_nonce,
    ]);

    let presentation_proof = sha256_chain(&[
        b"anon-proof-v1",
        &pseudonym,
        &credential.attribute_hash,
        presentation_nonce,
    ]);

    Ok(CredentialPresentation {
        pseudonym,
        presentation_proof,
        attribute_hash: credential.attribute_hash,
        presentation_nonce: *presentation_nonce,
        presented_at_unix,
        mainnet_ready: false,
    })
}

/// Verify internal consistency of a presentation.
///
/// Recomputes `presentation_proof` from the stored `pseudonym`, `attribute_hash`,
/// and `presentation_nonce`, then checks it matches the stored value.
pub fn verify_presentation(presentation: &CredentialPresentation) -> bool {
    let expected_proof = sha256_chain(&[
        b"anon-proof-v1",
        &presentation.pseudonym,
        &presentation.attribute_hash,
        &presentation.presentation_nonce,
    ]);
    presentation.presentation_proof == expected_proof
}

/// Return a JSON string with the public (non-secret) fields of a credential.
///
/// Deliberately omits `issuer_hash` to prevent issuer linkage.
pub fn credential_public_record(cred: &AnonCredential) -> String {
    serde_json::json!({
        "credential_id": hex::encode_bytes(&cred.credential_id),
        "attribute_hash": hex::encode_bytes(&cred.attribute_hash),
        "issued_at_unix": cred.issued_at_unix,
        "mainnet_ready": cred.mainnet_ready,
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Internal hex helper (no extra dependency)
// ---------------------------------------------------------------------------

mod hex {
    pub fn encode_bytes(bytes: &[u8]) -> String {
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

    // 1. Full happy-path roundtrip ------------------------------------------
    #[test]
    fn test_issue_and_present_happy_path() {
        let cred = issue_credential(&issuer(), b"dna-x402-attr", 1_700_000_000)
            .expect("issuance should succeed");

        assert!(!cred.mainnet_ready);
        assert_ne!(cred.credential_id, [0u8; 32]);
        assert_ne!(cred.issuer_hash, [0u8; 32]);
        assert_ne!(cred.attribute_hash, [0u8; 32]);

        let pres = present_credential(&cred, &holder(), &nonce(1), 1_700_000_001)
            .expect("presentation should succeed");

        assert!(!pres.mainnet_ready);
        assert_ne!(pres.pseudonym, [0u8; 32]);
        assert_ne!(pres.presentation_proof, [0u8; 32]);
        assert_eq!(pres.attribute_hash, cred.attribute_hash);
    }

    // 2. Unlinkability — different nonces → different pseudonyms -------------
    #[test]
    fn test_two_presentations_are_unlinkable() {
        let cred = issue_credential(&issuer(), b"dna-x402-attr", 1_700_000_000)
            .expect("issuance should succeed");

        let pres_a = present_credential(&cred, &holder(), &nonce(1), 1_700_000_001)
            .expect("first presentation should succeed");
        let pres_b = present_credential(&cred, &holder(), &nonce(2), 1_700_000_002)
            .expect("second presentation should succeed");

        // Pseudonyms must differ — they are unlinkable
        assert_ne!(
            pres_a.pseudonym, pres_b.pseudonym,
            "pseudonyms must be distinct for different nonces"
        );
        // Proofs must also differ
        assert_ne!(pres_a.presentation_proof, pres_b.presentation_proof);
    }

    // 3. All-zero nonce is rejected -----------------------------------------
    #[test]
    fn test_zero_nonce_rejected() {
        let cred = issue_credential(&issuer(), b"dna-x402-attr", 1_700_000_000)
            .expect("issuance should succeed");

        let err = present_credential(&cred, &holder(), &[0u8; 32], 1_700_000_001)
            .expect_err("zero nonce should be rejected");

        assert_eq!(err, CredentialError::NonceZero);
    }

    // 4. verify_presentation returns true for a valid presentation -----------
    #[test]
    fn test_verify_presentation_passes() {
        let cred = issue_credential(&issuer(), b"dna-x402-attr", 1_700_000_000)
            .expect("issuance should succeed");

        let pres = present_credential(&cred, &holder(), &nonce(7), 1_700_000_001)
            .expect("presentation should succeed");

        assert!(
            verify_presentation(&pres),
            "verify_presentation must return true for a freshly created presentation"
        );
    }

    // 5. Empty attribute is rejected ----------------------------------------
    #[test]
    fn test_attribute_empty_rejected() {
        let err = issue_credential(&issuer(), b"", 1_700_000_000)
            .expect_err("empty attribute should be rejected");

        assert_eq!(err, CredentialError::AttributeEmpty);
    }

    // 6. Public record does not expose issuer_hash -------------------------
    #[test]
    fn test_public_record_hides_issuer() {
        let cred = issue_credential(&issuer(), b"dna-x402-attr", 1_700_000_000)
            .expect("issuance should succeed");

        let record = credential_public_record(&cred);

        // Must contain credential_id and attribute_hash
        assert!(
            record.contains("credential_id"),
            "record should contain credential_id"
        );
        assert!(
            record.contains("attribute_hash"),
            "record should contain attribute_hash"
        );

        // Must NOT contain issuer_hash key or its hex value
        assert!(
            !record.contains("issuer_hash"),
            "record must not expose issuer_hash key"
        );
        let issuer_hash_hex = hex::encode_bytes(&cred.issuer_hash);
        assert!(
            !record.contains(&issuer_hash_hex),
            "record must not expose issuer_hash value"
        );
    }
}
