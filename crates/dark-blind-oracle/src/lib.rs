//! Blind oracle attestation for the DNA x402 privacy project.
//!
//! The client blinds their data before sending it to the oracle.
//! The oracle signs the blinded commitment without ever seeing the raw data.
//! The client then unblinds the attestation to prove the oracle endorsed their data.

use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Domain-separation prefixes
// ---------------------------------------------------------------------------

const DOM_DATA: &[u8] = b"blind-data-v1";
const DOM_REQ: &[u8] = b"blind-req-v1";
const DOM_PUB: &[u8] = b"oracle-pub-v1";
const DOM_SIGN: &[u8] = b"oracle-sign-v1";

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
    /// SHA256(DOM_SIGN || oracle_pubkey || blinded_commitment)
    pub oracle_sig: [u8; 32],
    /// SHA256(DOM_PUB || oracle_secret)
    pub oracle_pubkey: [u8; 32],
    pub attested_at_unix: i64,
    pub mainnet_ready: bool,
}

/// The result of unblinding an attestation — ties the oracle sig back to real data.
#[derive(Debug, Clone, PartialEq)]
pub struct UnblindedAttestation {
    /// SHA256(DOM_DATA || data)
    pub data_hash: [u8; 32],
    pub oracle_sig: [u8; 32],
    pub oracle_pubkey: [u8; 32],
    pub mainnet_ready: bool,
}

/// Errors returned by the blind oracle protocol.
#[derive(Debug, PartialEq)]
pub enum OracleError {
    /// The caller supplied an all-zero blinding factor, which provides no hiding.
    BlindingFactorZero,
    /// The recomputed blinded commitment does not match the attestation.
    AttestationMismatch,
    /// The data hash did not match what was attested (unused path, kept for completeness).
    DataHashMismatch,
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

fn oracle_pubkey_from_secret(oracle_secret: &[u8; 32]) -> [u8; 32] {
    sha256_domain(DOM_PUB, &[oracle_secret.as_ref()])
}

fn oracle_sig_from_parts(oracle_pubkey: &[u8; 32], blinded_commitment: &[u8; 32]) -> [u8; 32] {
    sha256_domain(DOM_SIGN, &[oracle_pubkey.as_ref(), blinded_commitment.as_ref()])
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
pub fn blind_data(
    data: &[u8],
    blinding_factor: &[u8; 32],
) -> Result<BlindedRequest, OracleError> {
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

/// Oracle-side: sign a [`BlindedRequest`] without knowing the raw data.
pub fn oracle_attest(
    oracle_secret: &[u8; 32],
    request: &BlindedRequest,
    attested_at_unix: i64,
) -> OracleAttestation {
    let oracle_pubkey = oracle_pubkey_from_secret(oracle_secret);
    let oracle_sig = oracle_sig_from_parts(&oracle_pubkey, &request.blinded_commitment);

    OracleAttestation {
        blinded_commitment: request.blinded_commitment,
        oracle_sig,
        oracle_pubkey,
        attested_at_unix,
        mainnet_ready: false,
    }
}

/// Client-side: unblind an [`OracleAttestation`] by providing the original `data`
/// and the `blinding_factor` used during blinding.
///
/// Returns [`OracleError::AttestationMismatch`] if the recomputed blinded commitment
/// does not match what the oracle signed.
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
        oracle_sig: attestation.oracle_sig,
        oracle_pubkey: attestation.oracle_pubkey,
        mainnet_ready: false,
    })
}

/// Verify that an [`OracleAttestation`] is internally self-consistent —
/// i.e. the oracle sig was produced from the oracle pubkey and blinded commitment
/// stored in the attestation.
pub fn verify_attestation(attestation: &OracleAttestation) -> bool {
    let expected_sig =
        oracle_sig_from_parts(&attestation.oracle_pubkey, &attestation.blinded_commitment);
    expected_sig == attestation.oracle_sig
}

/// Return a JSON string suitable for a public audit log. Does NOT include raw
/// data or the blinding factor — only the oracle-visible fields.
pub fn attestation_public_record(attestation: &OracleAttestation) -> String {
    // Build manually to avoid pulling in serde_json Value allocation for a
    // simple fixed-schema record.
    let record = serde_json::json!({
        "oracle_pubkey": hex_encode(&attestation.oracle_pubkey),
        "oracle_sig": hex_encode(&attestation.oracle_sig),
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
    fn test_blind_attest_unblind_happy_path() {
        let data = b"oracle please attest this";
        let blinding = sample_blinding();
        let secret = sample_secret();

        let request = blind_data(data, &blinding).expect("blind_data should succeed");
        assert!(!request.mainnet_ready);

        let attestation = oracle_attest(&secret, &request, 1_700_000_000);
        assert!(!attestation.mainnet_ready);
        assert_eq!(attestation.blinded_commitment, request.blinded_commitment);

        let unblinded = unblind_attestation(&attestation, data, &blinding)
            .expect("unblind should succeed");
        assert!(!unblinded.mainnet_ready);
        assert_eq!(unblinded.oracle_sig, attestation.oracle_sig);
        assert_eq!(unblinded.oracle_pubkey, attestation.oracle_pubkey);

        // The data_hash must be consistent with what blind_data computed internally.
        let expected_dh = sha256_domain(DOM_DATA, &[data.as_ref()]);
        assert_eq!(unblinded.data_hash, expected_dh);
    }

    #[test]
    fn test_wrong_data_fails_unblind() {
        let data = b"original data";
        let wrong_data = b"tampered data";
        let blinding = sample_blinding();
        let secret = sample_secret();

        let request = blind_data(data, &blinding).unwrap();
        let attestation = oracle_attest(&secret, &request, 1_700_000_000);

        let result = unblind_attestation(&attestation, wrong_data, &blinding);
        assert_eq!(result, Err(OracleError::AttestationMismatch));
    }

    #[test]
    fn test_wrong_blinding_factor_fails() {
        let data = b"some secret data";
        let blinding = sample_blinding();
        let mut wrong_blinding = sample_blinding();
        wrong_blinding[0] ^= 0xff; // flip bits to make it different
        let secret = sample_secret();

        let request = blind_data(data, &blinding).unwrap();
        let attestation = oracle_attest(&secret, &request, 1_700_000_000);

        let result = unblind_attestation(&attestation, data, &wrong_blinding);
        assert_eq!(result, Err(OracleError::AttestationMismatch));
    }

    #[test]
    fn test_zero_blinding_factor_rejected() {
        let data = b"some data";
        let zero_blinding = [0u8; 32];

        let result = blind_data(data, &zero_blinding);
        assert_eq!(result, Err(OracleError::BlindingFactorZero));
    }

    #[test]
    fn test_verify_attestation_passes() {
        let data = b"data to attest";
        let blinding = sample_blinding();
        let secret = sample_secret();

        let request = blind_data(data, &blinding).unwrap();
        let attestation = oracle_attest(&secret, &request, 1_700_000_001);

        assert!(verify_attestation(&attestation));
    }

    #[test]
    fn test_public_record_hides_data() {
        let data = b"super secret payload";
        let blinding = sample_blinding();
        let secret = sample_secret();

        let request = blind_data(data, &blinding).unwrap();
        let attestation = oracle_attest(&secret, &request, 1_700_000_002);

        let record = attestation_public_record(&attestation);

        // The raw data must not appear in the public record.
        let data_str = std::str::from_utf8(data).unwrap();
        assert!(
            !record.contains(data_str),
            "public record must not contain raw data"
        );

        // The record should contain expected public fields.
        assert!(record.contains("oracle_pubkey"));
        assert!(record.contains("oracle_sig"));
        assert!(record.contains("attested_at_unix"));
        assert!(record.contains("mainnet_ready"));

        // Sanity-check it is valid JSON.
        let parsed: serde_json::Value =
            serde_json::from_str(&record).expect("record must be valid JSON");
        assert_eq!(parsed["mainnet_ready"], false);
    }
}
