//! Oracle attestation over a blinded commitment, authenticated with HMAC-SHA256.
//!
//! The client commits to its data with a blinding factor and sends only the
//! commitment. The oracle authenticates the commitment and a timestamp with
//! HMAC-SHA256 under its secret key. The client later opens the commitment
//! (data + blinding factor) to show which data the attestation covers.
//!
//! Trust model, stated plainly:
//! - The tag is a MAC, not a public-key signature. Only a holder of the oracle
//!   secret can create or check a tag: `verify_attestation` needs the secret.
//!   A third party without the key cannot verify an attestation; it has to ask
//!   the oracle (or a party that shares the key).
//! - `oracle_key_id` is SHA-256 of the secret under a domain prefix. It names the
//!   key; it is not a public key and cannot be used to verify anything.
//! - The commitment hides the data only while the blinding factor stays secret
//!   and has enough entropy. This is a commitment scheme, not a blind signature:
//!   the oracle can link the commitment it saw to the opened attestation.
//! - Not reviewed for production use; every struct carries `mainnet_ready: false`.

use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

// ---------------------------------------------------------------------------
// Domain-separation prefixes
// ---------------------------------------------------------------------------

const DOM_DATA: &[u8] = b"blind-data-v1";
const DOM_REQ: &[u8] = b"blind-req-v1";
const DOM_KEY_ID: &[u8] = b"oracle-key-id-v1";
const DOM_TAG: &[u8] = b"oracle-hmac-tag-v1";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// A blinded request sent to the oracle. Contains no raw data.
#[derive(Debug, Clone, PartialEq)]
pub struct BlindedRequest {
    /// SHA256(DOM_REQ || data_hash || blinding_factor)
    /// where data_hash = SHA256(DOM_DATA || data)
    pub blinded_commitment: [u8; 32],
    pub mainnet_ready: bool,
}

/// The oracle's attestation over a blinded commitment.
#[derive(Debug, Clone)]
pub struct OracleAttestation {
    pub blinded_commitment: [u8; 32],
    /// HMAC-SHA256(key = oracle_secret,
    ///             DOM_TAG || oracle_key_id || blinded_commitment || attested_at_unix as i64 LE)
    pub oracle_tag: [u8; 32],
    /// SHA256(DOM_KEY_ID || oracle_secret): identifies the key, does not verify.
    pub oracle_key_id: [u8; 32],
    pub attested_at_unix: i64,
    pub mainnet_ready: bool,
}

/// The result of opening an attestation: ties the oracle tag back to real data.
#[derive(Debug, Clone, PartialEq)]
pub struct UnblindedAttestation {
    /// SHA256(DOM_DATA || data)
    pub data_hash: [u8; 32],
    pub blinded_commitment: [u8; 32],
    pub oracle_tag: [u8; 32],
    pub oracle_key_id: [u8; 32],
    pub attested_at_unix: i64,
    pub mainnet_ready: bool,
}

/// Errors returned by the oracle attestation protocol.
#[derive(Debug, PartialEq)]
pub enum OracleError {
    /// The caller supplied an all-zero blinding factor, which provides no hiding.
    BlindingFactorZero,
    /// The recomputed blinded commitment does not match the attestation.
    AttestationMismatch,
    /// The HMAC tag does not verify under the supplied oracle secret.
    InvalidTag,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn sha256_domain(domain: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(domain);
    for part in parts {
        h.update(part);
    }
    h.finalize().into()
}

fn data_hash(data: &[u8]) -> [u8; 32] {
    sha256_domain(DOM_DATA, &[data])
}

fn blinded_commitment_from_parts(dh: &[u8; 32], blinding_factor: &[u8; 32]) -> [u8; 32] {
    sha256_domain(DOM_REQ, &[dh.as_ref(), blinding_factor.as_ref()])
}

/// Key identifier for an oracle secret: SHA256(DOM_KEY_ID || secret).
pub fn oracle_key_id(oracle_secret: &[u8; 32]) -> [u8; 32] {
    sha256_domain(DOM_KEY_ID, &[oracle_secret.as_ref()])
}

fn tag_mac(oracle_secret: &[u8; 32], key_id: &[u8; 32], blinded_commitment: &[u8; 32], attested_at_unix: i64) -> HmacSha256 {
    let mut mac = <HmacSha256 as KeyInit>::new_from_slice(oracle_secret).expect("HMAC accepts any key length");
    mac.update(DOM_TAG);
    mac.update(key_id);
    mac.update(blinded_commitment);
    mac.update(&attested_at_unix.to_le_bytes());
    mac
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Blind raw `data` with a `blinding_factor` so it can be sent to an oracle
/// without revealing the underlying content.
///
/// Returns [`OracleError::BlindingFactorZero`] if `blinding_factor` is all zeros.
pub fn blind_data(data: &[u8], blinding_factor: &[u8; 32]) -> Result<BlindedRequest, OracleError> {
    if blinding_factor == &[0u8; 32] {
        return Err(OracleError::BlindingFactorZero);
    }

    let dh = data_hash(data);
    let bc = blinded_commitment_from_parts(&dh, blinding_factor);

    Ok(BlindedRequest {
        blinded_commitment: bc,
        mainnet_ready: false,
    })
}

/// Oracle-side: authenticate a [`BlindedRequest`] and a timestamp with
/// HMAC-SHA256 under `oracle_secret`, without seeing the raw data.
pub fn oracle_attest(
    oracle_secret: &[u8; 32],
    request: &BlindedRequest,
    attested_at_unix: i64,
) -> OracleAttestation {
    let key_id = oracle_key_id(oracle_secret);
    let tag: [u8; 32] = tag_mac(oracle_secret, &key_id, &request.blinded_commitment, attested_at_unix)
        .finalize()
        .into_bytes()
        .into();

    OracleAttestation {
        blinded_commitment: request.blinded_commitment,
        oracle_tag: tag,
        oracle_key_id: key_id,
        attested_at_unix,
        mainnet_ready: false,
    }
}

/// Client-side: open an [`OracleAttestation`] by providing the original `data`
/// and the `blinding_factor` used during blinding.
///
/// Returns [`OracleError::AttestationMismatch`] if the recomputed blinded
/// commitment does not match what the oracle attested. This checks the opening
/// only; the tag itself is checked with [`verify_attestation`] by a key holder.
pub fn unblind_attestation(
    attestation: &OracleAttestation,
    data: &[u8],
    blinding_factor: &[u8; 32],
) -> Result<UnblindedAttestation, OracleError> {
    let dh = data_hash(data);
    let bc = blinded_commitment_from_parts(&dh, blinding_factor);

    if bc != attestation.blinded_commitment {
        return Err(OracleError::AttestationMismatch);
    }

    Ok(UnblindedAttestation {
        data_hash: dh,
        blinded_commitment: bc,
        oracle_tag: attestation.oracle_tag,
        oracle_key_id: attestation.oracle_key_id,
        attested_at_unix: attestation.attested_at_unix,
        mainnet_ready: false,
    })
}

/// Key-holder check: true only if `attestation.oracle_tag` is the HMAC-SHA256
/// tag of its commitment and timestamp under `oracle_secret`, and the key id
/// matches that secret. Comparison is constant-time. Without the secret an
/// attestation cannot be verified.
pub fn verify_attestation(oracle_secret: &[u8; 32], attestation: &OracleAttestation) -> bool {
    let key_id = oracle_key_id(oracle_secret);
    if key_id != attestation.oracle_key_id {
        return false;
    }
    tag_mac(oracle_secret, &key_id, &attestation.blinded_commitment, attestation.attested_at_unix)
        .verify_slice(&attestation.oracle_tag)
        .is_ok()
}

/// Key-holder check of an opened attestation: the opening must match `data` and
/// `blinding_factor`, and the tag must verify under `oracle_secret`.
pub fn verify_opened(
    oracle_secret: &[u8; 32],
    attestation: &OracleAttestation,
    data: &[u8],
    blinding_factor: &[u8; 32],
) -> Result<UnblindedAttestation, OracleError> {
    let opened = unblind_attestation(attestation, data, blinding_factor)?;
    if !verify_attestation(oracle_secret, attestation) {
        return Err(OracleError::InvalidTag);
    }
    Ok(opened)
}

/// Return a JSON string suitable for a public log. Does NOT include raw data,
/// the blinding factor or the commitment, only the oracle-visible fields. The
/// tag in this record can be checked only by a holder of the oracle secret.
pub fn attestation_public_record(attestation: &OracleAttestation) -> String {
    let record = serde_json::json!({
        "scheme": "hmac-sha256",
        "oracle_key_id": hex_encode(&attestation.oracle_key_id),
        "oracle_tag": hex_encode(&attestation.oracle_tag),
        "attested_at_unix": attestation.attested_at_unix,
        "mainnet_ready": attestation.mainnet_ready,
    });
    record.to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_secret() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xde;
        s[1] = 0xad;
        s[31] = 0x01;
        s
    }

    fn sample_blinding() -> [u8; 32] {
        let mut b = [0u8; 32];
        b[0] = 0xca;
        b[1] = 0xfe;
        b[31] = 0x42;
        b
    }

    #[test]
    fn hmac_sha256_matches_rfc4231_case_2() {
        // RFC 4231 test case 2: key "Jefe", data "what do ya want for nothing?"
        let mut mac = <HmacSha256 as KeyInit>::new_from_slice(b"Jefe").unwrap();
        mac.update(b"what do ya want for nothing?");
        let out = mac.finalize().into_bytes();
        assert_eq!(
            hex_encode(&out),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn tag_is_hmac_sha256_over_the_documented_message() {
        let secret = sample_secret();
        let req = blind_data(b"spec check", &sample_blinding()).unwrap();
        let att = oracle_attest(&secret, &req, 1_700_000_000);
        let mut mac = <HmacSha256 as KeyInit>::new_from_slice(&secret).unwrap();
        mac.update(b"oracle-hmac-tag-v1");
        mac.update(&oracle_key_id(&secret));
        mac.update(&req.blinded_commitment);
        mac.update(&1_700_000_000i64.to_le_bytes());
        let expected: [u8; 32] = mac.finalize().into_bytes().into();
        assert_eq!(att.oracle_tag, expected);
    }

    #[test]
    fn test_blind_attest_unblind_happy_path() {
        let data = b"oracle please attest this";
        let blinding = sample_blinding();
        let secret = sample_secret();

        let request = blind_data(data, &blinding).expect("blind_data should succeed");
        assert!(!request.mainnet_ready);

        let attestation = oracle_attest(&secret, &request, 1_700_000_000);
        assert!(!attestation.mainnet_ready);
        assert_eq!(attestation.blinded_commitment, request.blinded_commitment);
        assert!(verify_attestation(&secret, &attestation));

        let unblinded = verify_opened(&secret, &attestation, data, &blinding).expect("open should succeed");
        assert!(!unblinded.mainnet_ready);
        assert_eq!(unblinded.oracle_tag, attestation.oracle_tag);
        assert_eq!(unblinded.oracle_key_id, attestation.oracle_key_id);
        assert_eq!(unblinded.data_hash, sha256_domain(DOM_DATA, &[data.as_ref()]));
    }

    #[test]
    fn forgery_without_the_secret_is_rejected() {
        // The earlier scheme computed the "signature" from public fields only, so
        // anyone could mint one. Recreate that forgery and check it now fails.
        let secret = sample_secret();
        let req = blind_data(b"forge me", &sample_blinding()).unwrap();
        let key_id = oracle_key_id(&secret);
        let forged_tag = sha256_domain(b"oracle-sign-v1", &[key_id.as_ref(), req.blinded_commitment.as_ref()]);
        let forged = OracleAttestation {
            blinded_commitment: req.blinded_commitment,
            oracle_tag: forged_tag,
            oracle_key_id: key_id,
            attested_at_unix: 0,
            mainnet_ready: false,
        };
        assert!(!verify_attestation(&secret, &forged));
    }

    #[test]
    fn wrong_secret_does_not_verify() {
        let req = blind_data(b"x", &sample_blinding()).unwrap();
        let att = oracle_attest(&sample_secret(), &req, 0);
        let mut other = sample_secret();
        other[0] ^= 0xFF;
        assert!(!verify_attestation(&other, &att));
        // Even with the original key id copied in, the tag does not verify.
        let mut relabelled = att.clone();
        relabelled.oracle_key_id = oracle_key_id(&other);
        assert!(!verify_attestation(&other, &relabelled));
    }

    #[test]
    fn tampering_with_any_field_breaks_verification() {
        let secret = sample_secret();
        let req = blind_data(b"tamper test", &sample_blinding()).unwrap();
        let att = oracle_attest(&secret, &req, 42);

        let mut t = att.clone();
        t.oracle_tag[0] ^= 0xFF;
        assert!(!verify_attestation(&secret, &t));

        let mut t = att.clone();
        t.blinded_commitment[0] ^= 0x01;
        assert!(!verify_attestation(&secret, &t));

        let mut t = att.clone();
        t.attested_at_unix += 1;
        assert!(!verify_attestation(&secret, &t));

        let mut t = att.clone();
        t.oracle_key_id[0] ^= 0x01;
        assert!(!verify_attestation(&secret, &t));
    }

    #[test]
    fn verify_opened_rejects_bad_tag_and_bad_opening() {
        let secret = sample_secret();
        let data = b"payload";
        let blinding = sample_blinding();
        let req = blind_data(data, &blinding).unwrap();
        let att = oracle_attest(&secret, &req, 7);

        assert_eq!(verify_opened(&secret, &att, b"other", &blinding), Err(OracleError::AttestationMismatch));
        let mut bad = att.clone();
        bad.oracle_tag[31] ^= 0x01;
        assert_eq!(verify_opened(&secret, &bad, data, &blinding), Err(OracleError::InvalidTag));
    }

    #[test]
    fn test_wrong_data_fails_unblind() {
        let blinding = sample_blinding();
        let request = blind_data(b"original data", &blinding).unwrap();
        let attestation = oracle_attest(&sample_secret(), &request, 1_700_000_000);
        let result = unblind_attestation(&attestation, b"tampered data", &blinding);
        assert_eq!(result, Err(OracleError::AttestationMismatch));
    }

    #[test]
    fn test_wrong_blinding_factor_fails() {
        let data = b"some secret data";
        let blinding = sample_blinding();
        let mut wrong_blinding = sample_blinding();
        wrong_blinding[0] ^= 0xff;
        let request = blind_data(data, &blinding).unwrap();
        let attestation = oracle_attest(&sample_secret(), &request, 1_700_000_000);
        let result = unblind_attestation(&attestation, data, &wrong_blinding);
        assert_eq!(result, Err(OracleError::AttestationMismatch));
    }

    #[test]
    fn test_zero_blinding_factor_rejected() {
        assert_eq!(blind_data(b"some data", &[0u8; 32]), Err(OracleError::BlindingFactorZero));
    }

    #[test]
    fn test_public_record_hides_data_and_names_the_scheme() {
        let data = b"super secret payload";
        let blinding = sample_blinding();
        let request = blind_data(data, &blinding).unwrap();
        let attestation = oracle_attest(&sample_secret(), &request, 1_700_000_002);

        let record = attestation_public_record(&attestation);
        assert!(!record.contains(std::str::from_utf8(data).unwrap()));
        assert!(!record.contains(&hex_encode(&blinding)));
        assert!(!record.contains(&hex_encode(&attestation.blinded_commitment)));

        let parsed: serde_json::Value = serde_json::from_str(&record).expect("record must be valid JSON");
        assert_eq!(parsed["scheme"], "hmac-sha256");
        assert_eq!(parsed["mainnet_ready"], false);
        assert_eq!(parsed["oracle_tag"].as_str().unwrap().len(), 64);
        assert_eq!(parsed["oracle_key_id"].as_str().unwrap().len(), 64);
    }

    #[test]
    fn test_mainnet_ready_always_false() {
        let blinding = sample_blinding();
        let req = blind_data(b"check flags", &blinding).unwrap();
        assert!(!req.mainnet_ready);
        let att = oracle_attest(&sample_secret(), &req, 1_000_000);
        assert!(!att.mainnet_ready);
        let unb = unblind_attestation(&att, b"check flags", &blinding).unwrap();
        assert!(!unb.mainnet_ready);
    }

    #[test]
    fn test_blind_commitment_deterministic_and_input_sensitive() {
        let blinding = sample_blinding();
        let r1 = blind_data(b"deterministic input", &blinding).unwrap();
        let r2 = blind_data(b"deterministic input", &blinding).unwrap();
        assert_eq!(r1.blinded_commitment, r2.blinded_commitment);
        let r3 = blind_data(b"other input", &blinding).unwrap();
        assert_ne!(r1.blinded_commitment, r3.blinded_commitment);
        let mut b2 = sample_blinding();
        b2[0] ^= 0xFF;
        let r4 = blind_data(b"deterministic input", &b2).unwrap();
        assert_ne!(r1.blinded_commitment, r4.blinded_commitment);
    }

    #[test]
    fn test_key_id_deterministic_and_per_secret() {
        let s1 = sample_secret();
        let mut s2 = sample_secret();
        s2[0] ^= 0xFF;
        assert_eq!(oracle_key_id(&s1), oracle_key_id(&s1));
        assert_ne!(oracle_key_id(&s1), oracle_key_id(&s2));
    }

    #[test]
    fn test_tag_depends_on_commitment_and_time() {
        let secret = sample_secret();
        let mut b2 = sample_blinding();
        b2[5] ^= 0x01;
        let req1 = blind_data(b"x", &sample_blinding()).unwrap();
        let req2 = blind_data(b"x", &b2).unwrap();
        assert_ne!(oracle_attest(&secret, &req1, 0).oracle_tag, oracle_attest(&secret, &req2, 0).oracle_tag);
        assert_ne!(oracle_attest(&secret, &req1, 0).oracle_tag, oracle_attest(&secret, &req1, 1).oracle_tag);
        assert_eq!(oracle_attest(&secret, &req1, 9).oracle_tag, oracle_attest(&secret, &req1, 9).oracle_tag);
    }
}
