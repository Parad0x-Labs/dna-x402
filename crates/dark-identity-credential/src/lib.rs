use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum AttributeType {
    AgeOver18 = 1,
    KycVerified = 2,
    AccreditedInvestor = 3,
    SolanaHolder = 4,
}

impl AttributeType {
    pub fn as_u8(self) -> u8 {
        self as u8
    }

    pub fn label(&self) -> &'static str {
        match self {
            AttributeType::AgeOver18 => "age_over_18",
            AttributeType::KycVerified => "kyc_verified",
            AttributeType::AccreditedInvestor => "accredited_investor",
            AttributeType::SolanaHolder => "solana_holder",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Credential {
    /// SHA256("credential-id-v1" || holder_hash || attribute_bits || issued_at_le)
    pub credential_id: [u8; 32],
    /// SHA256("holder-hash-v1" || holder_secret)
    pub holder_hash: [u8; 32],
    /// Bitmask of AttributeType values (1 << attr.as_u8())
    pub attribute_bits: u32,
    pub issued_at_unix: i64,
    pub expires_at_unix: i64,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AttributeDisclosure {
    pub credential_id: [u8; 32],
    /// Which attribute is being disclosed
    pub attribute: AttributeType,
    /// SHA256("disclose-v1" || credential_id || attr_byte || holder_hash)
    pub disclosure_proof: [u8; 32],
    pub disclosed_at_unix: i64,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum CredentialError {
    HolderSecretZero,
    AttributeNotPresent { requested: u8 },
    CredentialExpired { expired_at: i64, current: i64 },
    NoAttributesSet,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn compute_holder_hash(holder_secret: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"holder-hash-v1");
    h.update(holder_secret);
    h.finalize().into()
}

fn compute_credential_id(
    holder_hash: &[u8; 32],
    attribute_bits: u32,
    issued_at_unix: i64,
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"credential-id-v1");
    h.update(holder_hash);
    h.update(attribute_bits.to_le_bytes());
    h.update(issued_at_unix.to_le_bytes());
    h.finalize().into()
}

fn compute_disclosure_proof(
    credential_id: &[u8; 32],
    attr_byte: u8,
    holder_hash: &[u8; 32],
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"disclose-v1");
    h.update(credential_id);
    h.update([attr_byte]);
    h.update(holder_hash);
    h.finalize().into()
}

fn bytes_to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Issue a new credential for a holder identified by `holder_secret`.
///
/// Returns `Err(HolderSecretZero)` if the secret is all-zero bytes.
/// Returns `Err(NoAttributesSet)` if `attributes` is empty.
pub fn issue_credential(
    holder_secret: &[u8; 32],
    attributes: &[AttributeType],
    issued_at_unix: i64,
    expires_at_unix: i64,
) -> Result<Credential, CredentialError> {
    if holder_secret == &[0u8; 32] {
        return Err(CredentialError::HolderSecretZero);
    }
    if attributes.is_empty() {
        return Err(CredentialError::NoAttributesSet);
    }

    let holder_hash = compute_holder_hash(holder_secret);

    let attribute_bits = attributes
        .iter()
        .fold(0u32, |acc, a| acc | (1u32 << a.clone().as_u8()));

    let credential_id = compute_credential_id(&holder_hash, attribute_bits, issued_at_unix);

    Ok(Credential {
        credential_id,
        holder_hash,
        attribute_bits,
        issued_at_unix,
        expires_at_unix,
        mainnet_ready: false,
    })
}

/// Produce a selective-disclosure proof for a single `attribute`.
///
/// Returns `Err(CredentialExpired)` if `current_unix > expires_at_unix`.
/// Returns `Err(AttributeNotPresent)` if the attribute is not encoded in the credential.
pub fn disclose_attribute(
    credential: &Credential,
    holder_secret: &[u8; 32],
    attribute: AttributeType,
    current_unix: i64,
) -> Result<AttributeDisclosure, CredentialError> {
    if current_unix > credential.expires_at_unix {
        return Err(CredentialError::CredentialExpired {
            expired_at: credential.expires_at_unix,
            current: current_unix,
        });
    }

    let attr_byte = attribute.clone().as_u8();
    if (credential.attribute_bits & (1u32 << attr_byte)) == 0 {
        return Err(CredentialError::AttributeNotPresent {
            requested: attr_byte,
        });
    }

    // Recompute holder_hash from the secret to bind the disclosure to this holder.
    let holder_hash = compute_holder_hash(holder_secret);

    let disclosure_proof =
        compute_disclosure_proof(&credential.credential_id, attr_byte, &holder_hash);

    Ok(AttributeDisclosure {
        credential_id: credential.credential_id,
        attribute,
        disclosure_proof,
        disclosed_at_unix: current_unix,
        mainnet_ready: false,
    })
}

/// Verify that a disclosure is consistent with the given credential.
///
/// Checks:
/// 1. The disclosed attribute is present in the credential's attribute_bits.
/// 2. The disclosure_proof matches the expected hash computed from the
///    credential's stored holder_hash (no secret needed at verify time).
pub fn verify_disclosure(credential: &Credential, disclosure: &AttributeDisclosure) -> bool {
    let attr_byte = disclosure.attribute.clone().as_u8();

    // Attribute must be present in the credential.
    if (credential.attribute_bits & (1u32 << attr_byte)) == 0 {
        return false;
    }

    // Recompute expected proof using the credential's stored holder_hash.
    let expected = compute_disclosure_proof(
        &credential.credential_id,
        attr_byte,
        &credential.holder_hash,
    );

    expected == disclosure.disclosure_proof
}

/// Return a JSON string containing only public fields of the credential.
/// Does NOT expose holder_hash or any holder identity information.
pub fn credential_public_record(credential: &Credential) -> String {
    serde_json::json!({
        "credential_id": bytes_to_hex(&credential.credential_id),
        "attribute_bits": credential.attribute_bits,
        "issued_at_unix": credential.issued_at_unix,
        "expires_at_unix": credential.expires_at_unix,
        "mainnet_ready": credential.mainnet_ready,
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_secret(seed: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = seed;
        s[1] = 0xde;
        s[2] = 0xad;
        s
    }

    // 1. Happy path: issue + disclose a single attribute.
    #[test]
    fn test_issue_and_disclose_happy_path() {
        let secret = make_secret(1);
        let attrs = vec![AttributeType::AgeOver18, AttributeType::KycVerified];
        let cred = issue_credential(&secret, &attrs, 1_000_000, 9_999_999_999).unwrap();

        // Both bits should be set.
        assert!(cred.attribute_bits & (1u32 << AttributeType::AgeOver18.as_u8()) != 0);
        assert!(cred.attribute_bits & (1u32 << AttributeType::KycVerified.as_u8()) != 0);

        let disclosure =
            disclose_attribute(&cred, &secret, AttributeType::AgeOver18, 2_000_000).unwrap();

        assert_eq!(disclosure.credential_id, cred.credential_id);
        assert_eq!(disclosure.attribute, AttributeType::AgeOver18);
        assert!(!disclosure.mainnet_ready);
    }

    // 2. Disclosing an attribute not present in the credential must fail.
    #[test]
    fn test_attribute_not_present_rejected() {
        let secret = make_secret(2);
        let attrs = vec![AttributeType::AgeOver18];
        let cred = issue_credential(&secret, &attrs, 1_000_000, 9_999_999_999).unwrap();

        let result =
            disclose_attribute(&cred, &secret, AttributeType::AccreditedInvestor, 2_000_000);

        assert_eq!(
            result,
            Err(CredentialError::AttributeNotPresent {
                requested: AttributeType::AccreditedInvestor.as_u8()
            })
        );
    }

    // 3. Disclosing from an expired credential must fail.
    #[test]
    fn test_expired_credential_rejected() {
        let secret = make_secret(3);
        let attrs = vec![AttributeType::KycVerified];
        let cred = issue_credential(&secret, &attrs, 1_000, 5_000).unwrap();

        // current_unix is after expires_at_unix.
        let result = disclose_attribute(&cred, &secret, AttributeType::KycVerified, 6_000);

        assert_eq!(
            result,
            Err(CredentialError::CredentialExpired {
                expired_at: 5_000,
                current: 6_000
            })
        );
    }

    // 4. Full verify roundtrip must pass.
    #[test]
    fn test_verify_disclosure_passes() {
        let secret = make_secret(4);
        let attrs = vec![
            AttributeType::AgeOver18,
            AttributeType::KycVerified,
            AttributeType::SolanaHolder,
        ];
        let cred = issue_credential(&secret, &attrs, 1_000_000, 9_999_999_999).unwrap();

        let disclosure =
            disclose_attribute(&cred, &secret, AttributeType::SolanaHolder, 2_000_000).unwrap();

        assert!(verify_disclosure(&cred, &disclosure));
    }

    // 5. Issuing with an empty attributes slice must return NoAttributesSet.
    #[test]
    fn test_no_attributes_rejected() {
        let secret = make_secret(5);
        let result = issue_credential(&secret, &[], 1_000_000, 9_999_999_999);
        assert_eq!(result, Err(CredentialError::NoAttributesSet));
    }

    // 6. credential_public_record must not contain the holder_hash hex string.
    #[test]
    fn test_public_record_hides_holder() {
        let secret = make_secret(6);
        let attrs = vec![AttributeType::AccreditedInvestor];
        let cred = issue_credential(&secret, &attrs, 1_000_000, 9_999_999_999).unwrap();

        let record = credential_public_record(&cred);

        // The holder_hash must not appear anywhere in the public record.
        let holder_hex = bytes_to_hex(&cred.holder_hash);
        assert!(
            !record.contains(&holder_hex),
            "public record must not expose holder_hash"
        );

        // Sanity: credential_id and attribute_bits must be present.
        let cred_id_hex = bytes_to_hex(&cred.credential_id);
        assert!(record.contains(&cred_id_hex));
        assert!(record.contains(&cred.attribute_bits.to_string()));
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_credential_id_nonzero() {
        let secret = make_secret(10);
        let cred = issue_credential(&secret, &[AttributeType::AgeOver18], 0, 9999).unwrap();
        assert_ne!(cred.credential_id, [0u8; 32]);
    }

    #[test]
    fn test_holder_hash_nonzero() {
        let secret = make_secret(11);
        let cred = issue_credential(&secret, &[AttributeType::AgeOver18], 0, 9999).unwrap();
        assert_ne!(cred.holder_hash, [0u8; 32]);
    }

    #[test]
    fn test_credential_id_deterministic() {
        let secret = make_secret(12);
        let c1 = issue_credential(&secret, &[AttributeType::AgeOver18], 0, 9999).unwrap();
        let c2 = issue_credential(&secret, &[AttributeType::AgeOver18], 0, 9999).unwrap();
        assert_eq!(c1.credential_id, c2.credential_id);
    }

    #[test]
    fn test_mainnet_ready_always_false() {
        let secret = make_secret(13);
        let cred = issue_credential(&secret, &[AttributeType::KycVerified], 0, 9999).unwrap();
        assert!(!cred.mainnet_ready);
    }

    #[test]
    fn test_attribute_bits_set_for_issued_attributes() {
        let secret = make_secret(14);
        let cred = issue_credential(&secret, &[AttributeType::SolanaHolder], 0, 9999).unwrap();
        let bit = 1u32 << AttributeType::SolanaHolder.clone().as_u8();
        assert!(cred.attribute_bits & bit != 0);
    }

    #[test]
    fn test_disclosure_proof_nonzero() {
        let secret = make_secret(15);
        let cred = issue_credential(&secret, &[AttributeType::AgeOver18], 0, 9999).unwrap();
        let disc = disclose_attribute(&cred, &secret, AttributeType::AgeOver18, 1).unwrap();
        assert_ne!(disc.disclosure_proof, [0u8; 32]);
    }

    #[test]
    fn test_disclosure_proof_deterministic() {
        let secret = make_secret(16);
        let cred = issue_credential(&secret, &[AttributeType::KycVerified], 0, 9999).unwrap();
        let d1 = disclose_attribute(&cred, &secret, AttributeType::KycVerified, 1).unwrap();
        let d2 = disclose_attribute(&cred, &secret, AttributeType::KycVerified, 1).unwrap();
        assert_eq!(d1.disclosure_proof, d2.disclosure_proof);
    }

    #[test]
    fn test_disclosure_mainnet_ready_false() {
        let secret = make_secret(17);
        let cred = issue_credential(&secret, &[AttributeType::AgeOver18], 0, 9999).unwrap();
        let disc = disclose_attribute(&cred, &secret, AttributeType::AgeOver18, 1).unwrap();
        assert!(!disc.mainnet_ready);
    }

    #[test]
    fn test_holder_secret_zero_rejected() {
        let err = issue_credential(&[0u8; 32], &[AttributeType::AgeOver18], 0, 9999).unwrap_err();
        assert_eq!(err, CredentialError::HolderSecretZero);
    }

    #[test]
    fn test_disclose_at_exact_expiry_ok() {
        // check is `current_unix > expires_at_unix`, so == expires_at_unix is allowed
        let secret = make_secret(18);
        let cred = issue_credential(&secret, &[AttributeType::AgeOver18], 0, 1000).unwrap();
        let result = disclose_attribute(&cred, &secret, AttributeType::AgeOver18, 1000);
        assert!(result.is_ok(), "disclosure at exact expiry must succeed");
    }
}
