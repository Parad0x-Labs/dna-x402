use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SovereignProof {
    pub proof_id: [u8; 32],
    pub owner_hash: [u8; 32],
    pub data_commitment: [u8; 32],
    pub domain_hash: [u8; 32],
    pub issued_at: i64,
    pub valid: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum SovereignError {
    ZeroOwnerSecret,
    EmptyData,
    EmptyDomain,
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

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

fn compute_owner_hash(owner_secret: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"sov-owner-v1", owner_secret])
}

fn compute_data_hash(data_bytes: &[u8]) -> [u8; 32] {
    sha256_multi(&[b"sov-data-v1", data_bytes])
}

fn compute_domain_hash(domain_bytes: &[u8]) -> [u8; 32] {
    sha256_multi(&[b"sov-domain-v1", domain_bytes])
}

fn compute_data_commitment(
    data_hash: &[u8; 32],
    blinding: &[u8; 32],
    owner_hash: &[u8; 32],
) -> [u8; 32] {
    sha256_multi(&[b"sov-commit-v1", data_hash, blinding, owner_hash])
}

fn compute_proof_id(
    owner_hash: &[u8; 32],
    data_commitment: &[u8; 32],
    domain_hash: &[u8; 32],
    issued_at: i64,
) -> [u8; 32] {
    sha256_multi(&[
        b"sov-proof-v1",
        owner_hash,
        data_commitment,
        domain_hash,
        &issued_at.to_le_bytes(),
    ])
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Prove sovereignty over data within a domain.
///
/// Errors: ZeroOwnerSecret, EmptyData, EmptyDomain
pub fn prove_sovereignty(
    owner_secret: &[u8; 32],
    data_bytes: &[u8],
    domain_bytes: &[u8],
    blinding: &[u8; 32],
    issued_at: i64,
) -> Result<SovereignProof, SovereignError> {
    if *owner_secret == [0u8; 32] {
        return Err(SovereignError::ZeroOwnerSecret);
    }
    if data_bytes.is_empty() {
        return Err(SovereignError::EmptyData);
    }
    if domain_bytes.is_empty() {
        return Err(SovereignError::EmptyDomain);
    }
    let owner_hash = compute_owner_hash(owner_secret);
    let data_hash = compute_data_hash(data_bytes);
    let domain_hash = compute_domain_hash(domain_bytes);
    let data_commitment = compute_data_commitment(&data_hash, blinding, &owner_hash);
    let proof_id = compute_proof_id(&owner_hash, &data_commitment, &domain_hash, issued_at);
    Ok(SovereignProof {
        proof_id,
        owner_hash,
        data_commitment,
        domain_hash,
        issued_at,
        valid: true,
        mainnet_ready: false,
    })
}

/// Verify sovereignty: returns proof.valid (trivially true if constructed properly).
pub fn verify_sovereignty(proof: &SovereignProof) -> bool {
    proof.valid
}

/// Update the domain of a proof, recomputing domain_hash and proof_id.
pub fn update_domain(proof: &mut SovereignProof, domain_bytes: &[u8]) {
    proof.domain_hash = compute_domain_hash(domain_bytes);
    proof.proof_id = compute_proof_id(
        &proof.owner_hash,
        &proof.data_commitment,
        &proof.domain_hash,
        proof.issued_at,
    );
}

/// Public JSON record: proof_id, domain_hash, issued_at, valid, mainnet_ready.
/// Does NOT expose owner_hash or data.
pub fn proof_public_record(proof: &SovereignProof) -> String {
    let proof_id_hex: String = proof
        .proof_id
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    let domain_hex: String = proof
        .domain_hash
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    serde_json::json!({
        "proof_id": proof_id_hex,
        "domain_hash": domain_hex,
        "issued_at": proof.issued_at,
        "valid": proof.valid,
        "mainnet_ready": proof.mainnet_ready,
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn owner_secret() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xE1;
        s
    }
    fn blinding() -> [u8; 32] {
        let mut b = [0u8; 32];
        b[0] = 0xE2;
        b
    }

    #[test]
    fn test_prove_and_verify() {
        let proof = prove_sovereignty(
            &owner_secret(),
            b"sensitive-data-payload",
            b"finance.dark.null",
            &blinding(),
            1_000_000,
        )
        .unwrap();
        assert!(proof.valid);
        assert!(!proof.mainnet_ready);
        assert!(verify_sovereignty(&proof));
    }

    #[test]
    fn test_different_domains_different_proof_ids() {
        let p1 =
            prove_sovereignty(&owner_secret(), b"data", b"domain-alpha", &blinding(), 0).unwrap();
        let p2 =
            prove_sovereignty(&owner_secret(), b"data", b"domain-beta", &blinding(), 0).unwrap();
        assert_ne!(p1.proof_id, p2.proof_id);
    }

    #[test]
    fn test_domain_update_changes_proof_id() {
        let mut proof = prove_sovereignty(
            &owner_secret(),
            b"my-data",
            b"original-domain",
            &blinding(),
            500,
        )
        .unwrap();
        let original_proof_id = proof.proof_id;
        let original_domain_hash = proof.domain_hash;

        update_domain(&mut proof, b"new-domain");
        assert_ne!(proof.domain_hash, original_domain_hash);
        assert_ne!(proof.proof_id, original_proof_id);
    }

    #[test]
    fn test_zero_owner_rejected() {
        let err = prove_sovereignty(&[0u8; 32], b"data", b"domain", &blinding(), 0).unwrap_err();
        assert_eq!(err, SovereignError::ZeroOwnerSecret);
    }

    #[test]
    fn test_empty_data_rejected() {
        let err = prove_sovereignty(&owner_secret(), b"", b"domain", &blinding(), 0).unwrap_err();
        assert_eq!(err, SovereignError::EmptyData);
    }

    #[test]
    fn test_public_record_hides_owner_and_data() {
        let proof = prove_sovereignty(
            &owner_secret(),
            b"private-dataset-xyz",
            b"healthcare.dark.null",
            &blinding(),
            1_234_567,
        )
        .unwrap();
        let record = proof_public_record(&proof);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();

        let owner_hex: String = proof
            .owner_hash
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();
        let data_commit_hex: String = proof
            .data_commitment
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();

        assert!(
            !record.contains(&owner_hex),
            "owner_hash must not appear in public record"
        );
        assert!(
            !record.contains(&data_commit_hex),
            "data_commitment must not appear in public record"
        );
        assert!(v.get("owner_hash").is_none());
        assert!(v.get("data_commitment").is_none());
        assert_eq!(v["mainnet_ready"], false);
        assert_eq!(v["valid"], true);
        assert!(v["proof_id"].is_string());
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_mainnet_ready_always_false() {
        let p = prove_sovereignty(&owner_secret(), b"data", b"domain", &blinding(), 0).unwrap();
        assert!(!p.mainnet_ready);
    }

    #[test]
    fn test_proof_id_deterministic() {
        let p1 = prove_sovereignty(&owner_secret(), b"data", b"domain", &blinding(), 100).unwrap();
        let p2 = prove_sovereignty(&owner_secret(), b"data", b"domain", &blinding(), 100).unwrap();
        assert_eq!(p1.proof_id, p2.proof_id);
    }

    #[test]
    fn test_different_data_different_commitment() {
        let p1 = prove_sovereignty(&owner_secret(), b"data-a", b"domain", &blinding(), 0).unwrap();
        let p2 = prove_sovereignty(&owner_secret(), b"data-b", b"domain", &blinding(), 0).unwrap();
        assert_ne!(p1.data_commitment, p2.data_commitment);
    }

    #[test]
    fn test_different_blinding_different_commitment() {
        let mut b2 = blinding();
        b2[0] ^= 0xFF;
        let p1 = prove_sovereignty(&owner_secret(), b"data", b"domain", &blinding(), 0).unwrap();
        let p2 = prove_sovereignty(&owner_secret(), b"data", b"domain", &b2, 0).unwrap();
        assert_ne!(p1.data_commitment, p2.data_commitment);
    }

    #[test]
    fn test_proof_valid_flag_true() {
        let p = prove_sovereignty(&owner_secret(), b"data", b"domain", &blinding(), 0).unwrap();
        assert!(p.valid);
        assert!(verify_sovereignty(&p));
    }

    #[test]
    fn test_empty_domain_rejected() {
        let err = prove_sovereignty(&owner_secret(), b"data", b"", &blinding(), 0).unwrap_err();
        assert_eq!(err, SovereignError::EmptyDomain);
    }

    #[test]
    fn test_issued_at_stored() {
        let p =
            prove_sovereignty(&owner_secret(), b"data", b"dom", &blinding(), 42_000_000).unwrap();
        assert_eq!(p.issued_at, 42_000_000);
    }

    #[test]
    fn test_update_domain_preserves_owner_hash() {
        let mut p = prove_sovereignty(&owner_secret(), b"data", b"dom-1", &blinding(), 0).unwrap();
        let original_owner_hash = p.owner_hash;
        update_domain(&mut p, b"dom-2");
        assert_eq!(p.owner_hash, original_owner_hash);
    }

    #[test]
    fn test_public_record_issued_at() {
        let p = prove_sovereignty(&owner_secret(), b"data", b"dom", &blinding(), 9_999).unwrap();
        let record = proof_public_record(&p);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert_eq!(v["issued_at"], 9_999i64);
    }

    #[test]
    fn test_proof_id_sensitive_to_timestamp() {
        let p1 = prove_sovereignty(&owner_secret(), b"data", b"dom", &blinding(), 100).unwrap();
        let p2 = prove_sovereignty(&owner_secret(), b"data", b"dom", &blinding(), 200).unwrap();
        assert_ne!(p1.proof_id, p2.proof_id);
    }
}
