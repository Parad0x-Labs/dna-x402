use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Did {
    pub did_id: [u8; 32],
    pub controller_hash: [u8; 32],
    pub verification_method_hash: [u8; 32],
    pub document_hash: [u8; 32],
    pub created_at: i64,
    pub revoked: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DidProof {
    pub proof_id: [u8; 32],
    pub did_id: [u8; 32],
    pub challenge_hash: [u8; 32],
    pub response_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum DidError {
    ZeroControllerSecret,
    EmptyDocument,
    AlreadyRevoked,
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

fn compute_controller_hash(controller_secret: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"did-controller-v1", controller_secret])
}

fn compute_verification_method_hash(controller_hash: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"did-vm-v1", controller_hash])
}

fn compute_document_hash(document_bytes: &[u8]) -> [u8; 32] {
    sha256_multi(&[b"did-doc-v1", document_bytes])
}

fn compute_did_id(
    controller_hash: &[u8; 32],
    vm_hash: &[u8; 32],
    document_hash: &[u8; 32],
    created_at: i64,
) -> [u8; 32] {
    sha256_multi(&[
        b"did-id-v1",
        controller_hash,
        vm_hash,
        document_hash,
        &created_at.to_le_bytes(),
    ])
}

fn compute_challenge_hash(did_id: &[u8; 32], nonce: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"did-challenge-v1", did_id, nonce])
}

fn compute_response_hash(controller_hash: &[u8; 32], challenge_hash: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"did-response-v1", controller_hash, challenge_hash])
}

fn compute_proof_id(did_id: &[u8; 32], response_hash: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"did-proof-v1", did_id, response_hash])
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Create a new self-sovereign DID.
///
/// Errors: ZeroControllerSecret, EmptyDocument
pub fn create_did(
    controller_secret: &[u8; 32],
    document_bytes: &[u8],
    created_at: i64,
) -> Result<Did, DidError> {
    if *controller_secret == [0u8; 32] {
        return Err(DidError::ZeroControllerSecret);
    }
    if document_bytes.is_empty() {
        return Err(DidError::EmptyDocument);
    }
    let controller_hash = compute_controller_hash(controller_secret);
    let vm_hash = compute_verification_method_hash(&controller_hash);
    let document_hash = compute_document_hash(document_bytes);
    let did_id = compute_did_id(&controller_hash, &vm_hash, &document_hash, created_at);
    Ok(Did {
        did_id,
        controller_hash,
        verification_method_hash: vm_hash,
        document_hash,
        created_at,
        revoked: false,
        mainnet_ready: false,
    })
}

/// Prove control of a DID by responding to a challenge.
///
/// Errors: AlreadyRevoked
pub fn prove_control(
    did: &Did,
    controller_secret: &[u8; 32],
    nonce: &[u8; 32],
) -> Result<DidProof, DidError> {
    if did.revoked {
        return Err(DidError::AlreadyRevoked);
    }
    let controller_hash = compute_controller_hash(controller_secret);
    let challenge_hash = compute_challenge_hash(&did.did_id, nonce);
    let response_hash = compute_response_hash(&controller_hash, &challenge_hash);
    let proof_id = compute_proof_id(&did.did_id, &response_hash);
    Ok(DidProof {
        proof_id,
        did_id: did.did_id,
        challenge_hash,
        response_hash,
        mainnet_ready: false,
    })
}

/// Verify a DID proof by recomputing challenge and response from stored did.controller_hash.
pub fn verify_did_proof(did: &Did, proof: &DidProof) -> bool {
    if did.revoked {
        return false;
    }
    if did.did_id != proof.did_id {
        return false;
    }
    // Recompute response_hash using the did's stored controller_hash
    let response_hash = compute_response_hash(&did.controller_hash, &proof.challenge_hash);
    if response_hash != proof.response_hash {
        return false;
    }
    // Recompute proof_id
    let proof_id = compute_proof_id(&did.did_id, &response_hash);
    proof_id == proof.proof_id
}

/// Revoke a DID.
///
/// Errors: AlreadyRevoked
pub fn revoke_did(did: &mut Did) -> Result<(), DidError> {
    if did.revoked {
        return Err(DidError::AlreadyRevoked);
    }
    did.revoked = true;
    Ok(())
}

/// Public JSON record: did_id, document_hash, created_at, revoked, mainnet_ready.
/// Does NOT expose controller_hash.
pub fn did_public_record(did: &Did) -> String {
    let did_id_hex: String = did.did_id.iter().map(|b| format!("{:02x}", b)).collect();
    let doc_hex: String = did
        .document_hash
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    serde_json::json!({
        "did_id": did_id_hex,
        "document_hash": doc_hex,
        "created_at": did.created_at,
        "revoked": did.revoked,
        "mainnet_ready": did.mainnet_ready,
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn controller_secret() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xCC;
        s
    }
    fn nonce() -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = 0xDD;
        n
    }

    #[test]
    fn test_create_prove_verify() {
        let did = create_did(&controller_secret(), b"did:dark:alice#doc", 1_000_000).unwrap();
        assert!(!did.revoked);
        assert!(!did.mainnet_ready);

        let proof = prove_control(&did, &controller_secret(), &nonce()).unwrap();
        assert!(!proof.mainnet_ready);
        assert!(verify_did_proof(&did, &proof));
    }

    #[test]
    fn test_revoked_did_proof_fails() {
        let mut did = create_did(&controller_secret(), b"doc-bytes", 1_000).unwrap();
        revoke_did(&mut did).unwrap();

        let err = prove_control(&did, &controller_secret(), &nonce()).unwrap_err();
        assert_eq!(err, DidError::AlreadyRevoked);
        // verify also returns false for revoked
        // (proof cannot be made, but if we had one it would fail)
        assert!(did.revoked);
    }

    #[test]
    fn test_already_revoked_rejected() {
        let mut did = create_did(&controller_secret(), b"doc", 0).unwrap();
        revoke_did(&mut did).unwrap();
        let err = revoke_did(&mut did).unwrap_err();
        assert_eq!(err, DidError::AlreadyRevoked);
    }

    #[test]
    fn test_zero_controller_rejected() {
        let err = create_did(&[0u8; 32], b"doc", 0).unwrap_err();
        assert_eq!(err, DidError::ZeroControllerSecret);
    }

    #[test]
    fn test_empty_document_rejected() {
        let err = create_did(&controller_secret(), b"", 0).unwrap_err();
        assert_eq!(err, DidError::EmptyDocument);
    }

    #[test]
    fn test_public_record_hides_controller() {
        let did = create_did(&controller_secret(), b"identity-document", 9_999).unwrap();
        let record = did_public_record(&did);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();

        let ctrl_hex: String = did
            .controller_hash
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();
        assert!(
            !record.contains(&ctrl_hex),
            "controller_hash must not appear in public record"
        );
        assert!(v.get("controller_hash").is_none());
        assert_eq!(v["mainnet_ready"], false);
        assert!(v["did_id"].is_string());
        assert!(v["document_hash"].is_string());
    }
}
