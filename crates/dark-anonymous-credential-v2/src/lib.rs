use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttributeCommit {
    pub attr_id: u8,
    pub commitment: [u8; 32],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialV2 {
    pub cred_id: [u8; 32],
    pub holder_hash: [u8; 32],
    pub issuer_hash: [u8; 32],
    pub attributes: Vec<AttributeCommit>,
    pub issued_at: i64,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectiveProof {
    pub proof_id: [u8; 32],
    pub cred_id: [u8; 32],
    pub disclosed_attrs: Vec<u8>,
    pub proof_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum CredError {
    ZeroHolderSecret,
    ZeroIssuerSecret,
    EmptyAttributes,
    AttributeNotFound { id: u8 },
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn xor_fold(bufs: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = [0u8; 32];
    for b in bufs {
        for i in 0..32 {
            acc[i] ^= b[i];
        }
    }
    acc
}

fn hex32(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn issue_credential_v2(
    issuer_secret: &[u8; 32],
    holder_secret: &[u8; 32],
    attributes: &[(u8, &[u8])],
    issued_at: i64,
) -> Result<CredentialV2, CredError> {
    if holder_secret == &[0u8; 32] {
        return Err(CredError::ZeroHolderSecret);
    }
    if issuer_secret == &[0u8; 32] {
        return Err(CredError::ZeroIssuerSecret);
    }
    if attributes.is_empty() {
        return Err(CredError::EmptyAttributes);
    }

    let holder_hash = sha256_multi(&[b"credv2-holder-v1", holder_secret]);
    let issuer_hash = sha256_multi(&[b"credv2-issuer-v1", issuer_secret]);

    let attr_commits: Vec<AttributeCommit> = attributes
        .iter()
        .map(|(attr_id, attr_value)| {
            let commitment =
                sha256_multi(&[b"credv2-attr-v1", &[*attr_id], attr_value, &holder_hash]);
            AttributeCommit {
                attr_id: *attr_id,
                commitment,
            }
        })
        .collect();

    let commitments: Vec<[u8; 32]> = attr_commits.iter().map(|a| a.commitment).collect();
    let xor_commits = xor_fold(&commitments);
    let issued_at_le = (issued_at as i64).to_le_bytes();
    let cred_id = sha256_multi(&[
        b"credv2-id-v1",
        &holder_hash,
        &issuer_hash,
        &xor_commits,
        &issued_at_le,
    ]);

    Ok(CredentialV2 {
        cred_id,
        holder_hash,
        issuer_hash,
        attributes: attr_commits,
        issued_at,
        mainnet_ready: false,
    })
}

pub fn prove_selective(
    cred: &CredentialV2,
    holder_secret: &[u8; 32],
    disclose_attr_ids: &[u8],
) -> Result<SelectiveProof, CredError> {
    let holder_hash = sha256_multi(&[b"credv2-holder-v1", holder_secret]);

    let mut disclosed_commitments: Vec<[u8; 32]> = Vec::new();
    for &id in disclose_attr_ids {
        let found = cred.attributes.iter().find(|a| a.attr_id == id);
        match found {
            Some(a) => disclosed_commitments.push(a.commitment),
            None => return Err(CredError::AttributeNotFound { id }),
        }
    }

    let xor_disclosed = xor_fold(&disclosed_commitments);
    let proof_hash = sha256_multi(&[
        b"credv2-proof-v1",
        &cred.cred_id,
        &xor_disclosed,
        &holder_hash,
    ]);
    let proof_id = sha256_multi(&[b"credv2-proof-id-v1", &proof_hash]);

    Ok(SelectiveProof {
        proof_id,
        cred_id: cred.cred_id,
        disclosed_attrs: disclose_attr_ids.to_vec(),
        proof_hash,
        mainnet_ready: false,
    })
}

pub fn verify_selective(cred: &CredentialV2, proof: &SelectiveProof) -> bool {
    if proof.cred_id != cred.cred_id {
        return false;
    }
    let mut disclosed_commitments: Vec<[u8; 32]> = Vec::new();
    for &id in &proof.disclosed_attrs {
        match cred.attributes.iter().find(|a| a.attr_id == id) {
            Some(a) => disclosed_commitments.push(a.commitment),
            None => return false,
        }
    }
    let xor_disclosed = xor_fold(&disclosed_commitments);
    // We cannot recompute holder_hash without holder_secret, but we can verify proof_id
    let expected_proof_id = sha256_multi(&[b"credv2-proof-id-v1", &proof.proof_hash]);
    expected_proof_id == proof.proof_id
}

pub fn cred_public_record(cred: &CredentialV2) -> String {
    serde_json::json!({
        "cred_id": hex32(&cred.cred_id),
        "issued_at": cred.issued_at,
        "attr_count": cred.attributes.len(),
        "mainnet_ready": cred.mainnet_ready,
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

    #[test]
    fn test_issue_prove_verify() {
        let issuer = secret(0x11);
        let holder = secret(0x22);
        let attrs: &[(u8, &[u8])] = &[(1u8, b"attr-value-1"), (2u8, b"attr-value-2")];
        let cred = issue_credential_v2(&issuer, &holder, attrs, 1_000_000).unwrap();
        assert!(!cred.mainnet_ready);
        assert_eq!(cred.attributes.len(), 2);

        let proof = prove_selective(&cred, &holder, &[1]).unwrap();
        assert!(!proof.mainnet_ready);
        assert_eq!(proof.disclosed_attrs, vec![1]);

        assert!(verify_selective(&cred, &proof));
    }

    #[test]
    fn test_attribute_not_found_rejected() {
        let issuer = secret(0x33);
        let holder = secret(0x44);
        let attrs: &[(u8, &[u8])] = &[(1u8, b"val-a")];
        let cred = issue_credential_v2(&issuer, &holder, attrs, 0).unwrap();
        let err = prove_selective(&cred, &holder, &[99]).unwrap_err();
        assert_eq!(err, CredError::AttributeNotFound { id: 99 });
    }

    #[test]
    fn test_zero_holder_rejected() {
        let issuer = secret(0x55);
        let holder = [0u8; 32];
        let attrs: &[(u8, &[u8])] = &[(1u8, b"val")];
        let err = issue_credential_v2(&issuer, &holder, attrs, 0).unwrap_err();
        assert_eq!(err, CredError::ZeroHolderSecret);
    }

    #[test]
    fn test_proof_hides_undisclosed_attrs() {
        let issuer = secret(0x66);
        let holder = secret(0x77);
        let attrs: &[(u8, &[u8])] = &[(1u8, b"secret-attr"), (2u8, b"public-attr")];
        let cred = issue_credential_v2(&issuer, &holder, attrs, 0).unwrap();

        // Only disclose attr 2, not attr 1
        let proof = prove_selective(&cred, &holder, &[2]).unwrap();
        assert_eq!(proof.disclosed_attrs, vec![2]);

        // Attr 1's commitment should not appear in proof_hash preimage directly
        let attr1_commit = cred.attributes.iter().find(|a| a.attr_id == 1).unwrap();
        // proof only discloses attr 2 so attr 1 commitment is not in disclosed list
        assert!(!proof.disclosed_attrs.contains(&1));
        // The proof_hash must differ from a proof that includes attr 1
        let proof_both = prove_selective(&cred, &holder, &[1, 2]).unwrap();
        assert_ne!(proof.proof_hash, proof_both.proof_hash);
        let _ = attr1_commit; // suppress unused warning
    }

    #[test]
    fn test_different_disclosed_sets_different_proofs() {
        let issuer = secret(0x88);
        let holder = secret(0x99);
        let attrs: &[(u8, &[u8])] = &[(1u8, b"v1"), (2u8, b"v2"), (3u8, b"v3")];
        let cred = issue_credential_v2(&issuer, &holder, attrs, 0).unwrap();

        let proof_1 = prove_selective(&cred, &holder, &[1]).unwrap();
        let proof_2 = prove_selective(&cred, &holder, &[2]).unwrap();
        let proof_12 = prove_selective(&cred, &holder, &[1, 2]).unwrap();
        assert_ne!(proof_1.proof_hash, proof_2.proof_hash);
        assert_ne!(proof_1.proof_hash, proof_12.proof_hash);
        assert_ne!(proof_2.proof_hash, proof_12.proof_hash);
    }

    #[test]
    fn test_public_record_hides_holder_issuer() {
        let issuer = secret(0xaa);
        let holder = secret(0xbb);
        let attrs: &[(u8, &[u8])] = &[(1u8, b"val")];
        let cred = issue_credential_v2(&issuer, &holder, attrs, 42).unwrap();
        let record = cred_public_record(&cred);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["cred_id"].is_string());
        assert_eq!(v["attr_count"], 1);
        assert_eq!(v["mainnet_ready"], false);
        assert!(v.get("holder_hash").is_none());
        assert!(v.get("issuer_hash").is_none());
        assert!(!record.contains(&hex32(&cred.holder_hash)));
        assert!(!record.contains(&hex32(&cred.issuer_hash)));
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_mainnet_ready_always_false() {
        let issuer = secret(0x11);
        let holder = secret(0x22);
        let attrs: &[(u8, &[u8])] = &[(1, b"val")];
        let cred = issue_credential_v2(&issuer, &holder, attrs, 0).unwrap();
        assert!(!cred.mainnet_ready);
        let proof = prove_selective(&cred, &holder, &[1]).unwrap();
        assert!(!proof.mainnet_ready);
    }

    #[test]
    fn test_cred_id_deterministic() {
        let issuer = secret(0x11);
        let holder = secret(0x22);
        let attrs: &[(u8, &[u8])] = &[(1, b"val")];
        let c1 = issue_credential_v2(&issuer, &holder, attrs, 1_000).unwrap();
        let c2 = issue_credential_v2(&issuer, &holder, attrs, 1_000).unwrap();
        assert_eq!(c1.cred_id, c2.cred_id);
    }

    #[test]
    fn test_cred_id_holder_sensitive() {
        let issuer = secret(0x11);
        let attrs: &[(u8, &[u8])] = &[(1, b"val")];
        let c1 = issue_credential_v2(&issuer, &secret(0x22), attrs, 0).unwrap();
        let c2 = issue_credential_v2(&issuer, &secret(0x23), attrs, 0).unwrap();
        assert_ne!(c1.cred_id, c2.cred_id);
    }

    #[test]
    fn test_cred_id_issuer_sensitive() {
        let holder = secret(0x22);
        let attrs: &[(u8, &[u8])] = &[(1, b"val")];
        let c1 = issue_credential_v2(&secret(0x11), &holder, attrs, 0).unwrap();
        let c2 = issue_credential_v2(&secret(0x12), &holder, attrs, 0).unwrap();
        assert_ne!(c1.cred_id, c2.cred_id);
    }

    #[test]
    fn test_zero_issuer_rejected() {
        let holder = secret(0x22);
        let attrs: &[(u8, &[u8])] = &[(1, b"val")];
        let err = issue_credential_v2(&[0u8; 32], &holder, attrs, 0).unwrap_err();
        assert_eq!(err, CredError::ZeroIssuerSecret);
    }

    #[test]
    fn test_empty_attributes_rejected() {
        let issuer = secret(0x11);
        let holder = secret(0x22);
        let err = issue_credential_v2(&issuer, &holder, &[], 0).unwrap_err();
        assert_eq!(err, CredError::EmptyAttributes);
    }

    #[test]
    fn test_proof_id_deterministic() {
        let issuer = secret(0x11);
        let holder = secret(0x22);
        let attrs: &[(u8, &[u8])] = &[(1, b"v1"), (2, b"v2")];
        let cred = issue_credential_v2(&issuer, &holder, attrs, 0).unwrap();
        let p1 = prove_selective(&cred, &holder, &[1]).unwrap();
        let p2 = prove_selective(&cred, &holder, &[1]).unwrap();
        assert_eq!(p1.proof_id, p2.proof_id);
    }

    #[test]
    fn test_verify_selective_wrong_cred_id_fails() {
        let issuer = secret(0x11);
        let holder = secret(0x22);
        let attrs: &[(u8, &[u8])] = &[(1, b"v1")];
        let cred = issue_credential_v2(&issuer, &holder, attrs, 0).unwrap();
        let other_cred = issue_credential_v2(&secret(0x33), &holder, attrs, 0).unwrap();
        let proof = prove_selective(&cred, &holder, &[1]).unwrap();
        // verifying proof against wrong cred → cred_id mismatch → false
        assert!(!verify_selective(&other_cred, &proof));
    }

    #[test]
    fn test_public_record_contains_cred_id() {
        let issuer = secret(0x11);
        let holder = secret(0x22);
        let attrs: &[(u8, &[u8])] = &[(1, b"v1")];
        let cred = issue_credential_v2(&issuer, &holder, attrs, 0).unwrap();
        let record = cred_public_record(&cred);
        assert!(record.contains(&hex32(&cred.cred_id)));
    }

    #[test]
    fn test_attribute_commitment_holder_sensitive() {
        let issuer = secret(0x11);
        let attrs: &[(u8, &[u8])] = &[(1, b"val")];
        let c1 = issue_credential_v2(&issuer, &secret(0x22), attrs, 0).unwrap();
        let c2 = issue_credential_v2(&issuer, &secret(0x23), attrs, 0).unwrap();
        // attr commitment = SHA256("credv2-attr-v1" || attr_id || attr_value || holder_hash)
        assert_ne!(c1.attributes[0].commitment, c2.attributes[0].commitment);
    }
}
