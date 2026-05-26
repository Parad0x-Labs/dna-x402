use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnonCredential {
    pub cred_id: [u8; 32],
    pub issuer_hash: [u8; 32],
    pub holder_hash: [u8; 32],
    pub attr_root: [u8; 32],
    pub attr_count: u32,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisclosureProof {
    pub proof_id: [u8; 32],
    pub cred_id: [u8; 32],
    pub disclosed_attrs_root: [u8; 32],
    pub nullifier: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum CredError {
    ZeroIssuerSecret,
    ZeroHolderSecret,
    NoAttributes,
    AttributeNotFound,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn xor_fold(hashes: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = [0u8; 32];
    for h in hashes {
        for i in 0..32 {
            acc[i] ^= h[i];
        }
    }
    acc
}

fn hex32(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

// ── Hash formulas ──────────────────────────────────────────────────────────

fn compute_issuer_hash(secret: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"acred3-issuer-v1", secret])
}

fn compute_holder_hash(secret: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"acred3-holder-v1", secret])
}

fn compute_attr_hash(name: &[u8], value: &[u8]) -> [u8; 32] {
    sha256_multi(&[b"acred3-attr-v1", name, value])
}

fn compute_attr_root(attr_hashes: &[[u8; 32]], count: u32) -> [u8; 32] {
    let xored = xor_fold(attr_hashes);
    sha256_multi(&[b"acred3-aroot-v1", &xored, &count.to_le_bytes()])
}

fn compute_cred_id(
    issuer_hash: &[u8; 32],
    holder_hash: &[u8; 32],
    attr_root: &[u8; 32],
) -> [u8; 32] {
    sha256_multi(&[b"acred3-id-v1", issuer_hash, holder_hash, attr_root])
}

fn compute_disclosure_nullifier(
    holder_hash: &[u8; 32],
    cred_id: &[u8; 32],
    nonce: &[u8; 32],
) -> [u8; 32] {
    sha256_multi(&[b"acred3-null-v1", holder_hash, cred_id, nonce])
}

fn compute_disclosed_root(disclosed_hashes: &[[u8; 32]], count: u32) -> [u8; 32] {
    let xored = xor_fold(disclosed_hashes);
    sha256_multi(&[b"acred3-disc-v1", &xored, &count.to_le_bytes()])
}

fn compute_proof_id(
    cred_id: &[u8; 32],
    disclosed_root: &[u8; 32],
    nullifier: &[u8; 32],
) -> [u8; 32] {
    sha256_multi(&[b"acred3-proof-v1", cred_id, disclosed_root, nullifier])
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn issue_credential(
    issuer_secret: &[u8; 32],
    holder_secret: &[u8; 32],
    attributes: &[(&[u8], &[u8])],
) -> Result<AnonCredential, CredError> {
    if issuer_secret == &[0u8; 32] {
        return Err(CredError::ZeroIssuerSecret);
    }
    if holder_secret == &[0u8; 32] {
        return Err(CredError::ZeroHolderSecret);
    }
    if attributes.is_empty() {
        return Err(CredError::NoAttributes);
    }
    let issuer_hash = compute_issuer_hash(issuer_secret);
    let holder_hash = compute_holder_hash(holder_secret);
    let attr_hashes: Vec<[u8; 32]> = attributes
        .iter()
        .map(|(n, v)| compute_attr_hash(n, v))
        .collect();
    let attr_count = attr_hashes.len() as u32;
    let attr_root = compute_attr_root(&attr_hashes, attr_count);
    let cred_id = compute_cred_id(&issuer_hash, &holder_hash, &attr_root);
    Ok(AnonCredential {
        cred_id,
        issuer_hash,
        holder_hash,
        attr_root,
        attr_count,
        mainnet_ready: false,
    })
}

pub fn disclose_attributes(
    cred: &AnonCredential,
    holder_secret: &[u8; 32],
    disclose_names: &[&[u8]],
    all_attributes: &[(&[u8], &[u8])],
    nonce: &[u8; 32],
) -> Result<DisclosureProof, CredError> {
    let holder_hash = compute_holder_hash(holder_secret);
    // Resolve each disclosed name to its value
    let mut disclosed_hashes: Vec<[u8; 32]> = Vec::new();
    for &name in disclose_names {
        let found = all_attributes.iter().find(|(n, _)| *n == name);
        match found {
            Some((n, v)) => disclosed_hashes.push(compute_attr_hash(n, v)),
            None => return Err(CredError::AttributeNotFound),
        }
    }
    let disc_count = disclosed_hashes.len() as u32;
    let disclosed_attrs_root = compute_disclosed_root(&disclosed_hashes, disc_count);
    let nullifier = compute_disclosure_nullifier(&holder_hash, &cred.cred_id, nonce);
    let proof_id = compute_proof_id(&cred.cred_id, &disclosed_attrs_root, &nullifier);
    Ok(DisclosureProof {
        proof_id,
        cred_id: cred.cred_id,
        disclosed_attrs_root,
        nullifier,
        mainnet_ready: false,
    })
}

pub fn cred_public_record(cred: &AnonCredential) -> String {
    serde_json::json!({
        "cred_id": hex32(&cred.cred_id),
        "attr_count": cred.attr_count,
        "mainnet_ready": cred.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn issuer() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0x11;
        s
    }
    fn holder() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0x22;
        s
    }
    fn nonce1() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0x33;
        s
    }
    fn nonce2() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0x44;
        s
    }

    fn attrs() -> Vec<(&'static [u8], &'static [u8])> {
        vec![(b"age", b"30"), (b"country", b"US"), (b"verified", b"true")]
    }

    // Test 1: issue_credential + mainnet_ready=false
    #[test]
    fn test_issue_credential_mainnet_ready_false() {
        let a = attrs();
        let cred = issue_credential(&issuer(), &holder(), &a).unwrap();
        assert!(!cred.mainnet_ready);
        assert_eq!(cred.attr_count, 3);
        assert_ne!(cred.cred_id, [0u8; 32]);
    }

    // Test 2: disclose_attributes creates proof
    #[test]
    fn test_disclose_attributes_creates_proof() {
        let a = attrs();
        let cred = issue_credential(&issuer(), &holder(), &a).unwrap();
        let proof = disclose_attributes(&cred, &holder(), &[b"age"], &a, &nonce1()).unwrap();
        assert_ne!(proof.proof_id, [0u8; 32]);
        assert!(!proof.mainnet_ready);
        assert_eq!(proof.cred_id, cred.cred_id);
    }

    // Test 3: different nonces → different nullifiers
    #[test]
    fn test_different_nonces_different_nullifiers() {
        let a = attrs();
        let cred = issue_credential(&issuer(), &holder(), &a).unwrap();
        let p1 = disclose_attributes(&cred, &holder(), &[b"age"], &a, &nonce1()).unwrap();
        let p2 = disclose_attributes(&cred, &holder(), &[b"age"], &a, &nonce2()).unwrap();
        assert_ne!(p1.nullifier, p2.nullifier);
    }

    // Test 4: zero_issuer rejected
    #[test]
    fn test_zero_issuer_rejected() {
        let a = attrs();
        let err = issue_credential(&[0u8; 32], &holder(), &a).unwrap_err();
        assert_eq!(err, CredError::ZeroIssuerSecret);
    }

    // Test 5: no_attributes rejected
    #[test]
    fn test_no_attributes_rejected() {
        let err = issue_credential(&issuer(), &holder(), &[]).unwrap_err();
        assert_eq!(err, CredError::NoAttributes);
    }

    // Test 6: attr_root changes with different attributes
    #[test]
    fn test_attr_root_changes_with_different_attributes() {
        let a1: Vec<(&[u8], &[u8])> = vec![(b"age", b"30")];
        let a2: Vec<(&[u8], &[u8])> = vec![(b"age", b"31")];
        let c1 = issue_credential(&issuer(), &holder(), &a1).unwrap();
        let c2 = issue_credential(&issuer(), &holder(), &a2).unwrap();
        assert_ne!(c1.attr_root, c2.attr_root);
    }
}
