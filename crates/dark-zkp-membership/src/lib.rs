use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MembershipSet {
    pub set_id: [u8; 32],
    pub element_root: [u8; 32],
    pub size: u32,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MembershipProof {
    pub proof_id: [u8; 32],
    pub set_id: [u8; 32],
    pub commitment: [u8; 32],
    pub verified: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum MembershipError {
    EmptySet,
    ElementNotInSet,
    ZeroSecret,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

fn hex(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
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

pub fn compute_element_hash(element_bytes: &[u8]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"memb-elem-v1");
    d.extend_from_slice(element_bytes);
    sha256(&d)
}

fn compute_element_root(element_hashes: &[[u8; 32]]) -> [u8; 32] {
    let xored = xor_fold(element_hashes);
    let mut d = Vec::new();
    d.extend_from_slice(b"memb-root-v1");
    d.extend_from_slice(&xored);
    sha256(&d)
}

fn compute_set_id(element_root: &[u8; 32], size: u32) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"memb-set-v1");
    d.extend_from_slice(element_root);
    d.extend_from_slice(&size.to_le_bytes());
    sha256(&d)
}

fn compute_commitment(element_hash: &[u8; 32], secret: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"memb-commit-v1");
    d.extend_from_slice(element_hash);
    d.extend_from_slice(secret);
    sha256(&d)
}

fn compute_proof_id(set_id: &[u8; 32], commitment: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"memb-proof-v1");
    d.extend_from_slice(set_id);
    d.extend_from_slice(commitment);
    sha256(&d)
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn build_set(elements: &[&[u8]]) -> Result<MembershipSet, MembershipError> {
    if elements.is_empty() {
        return Err(MembershipError::EmptySet);
    }
    let element_hashes: Vec<[u8; 32]> = elements.iter().map(|e| compute_element_hash(e)).collect();
    let element_root = compute_element_root(&element_hashes);
    let size = elements.len() as u32;
    let set_id = compute_set_id(&element_root, size);
    Ok(MembershipSet {
        set_id,
        element_root,
        size,
        mainnet_ready: false,
    })
}

pub fn prove_membership(
    set: &MembershipSet,
    element_hashes: &[[u8; 32]],
    claimed_element: &[u8],
    secret: &[u8; 32],
) -> Result<MembershipProof, MembershipError> {
    if secret == &[0u8; 32] {
        return Err(MembershipError::ZeroSecret);
    }
    let claimed_hash = compute_element_hash(claimed_element);
    // Check claimed element is in the set
    if !element_hashes.iter().any(|h| h == &claimed_hash) {
        return Err(MembershipError::ElementNotInSet);
    }
    let commitment = compute_commitment(&claimed_hash, secret);
    let proof_id = compute_proof_id(&set.set_id, &commitment);
    Ok(MembershipProof {
        proof_id,
        set_id: set.set_id,
        commitment,
        verified: true,
        mainnet_ready: false,
    })
}

pub fn verify_membership(
    proof: &MembershipProof,
    set: &MembershipSet,
    element_hashes: &[[u8; 32]],
    claimed_element: &[u8],
    secret: &[u8; 32],
) -> bool {
    if secret == &[0u8; 32] {
        return false;
    }
    let claimed_hash = compute_element_hash(claimed_element);
    if !element_hashes.iter().any(|h| h == &claimed_hash) {
        return false;
    }
    if proof.set_id != set.set_id {
        return false;
    }
    let expected_commitment = compute_commitment(&claimed_hash, secret);
    if expected_commitment != proof.commitment {
        return false;
    }
    let expected_proof_id = compute_proof_id(&set.set_id, &expected_commitment);
    expected_proof_id == proof.proof_id
}

pub fn set_public_record(set: &MembershipSet) -> String {
    serde_json::json!({
        "set_id":        hex(&set.set_id),
        "element_root":  hex(&set.element_root),
        "size":          set.size,
        "mainnet_ready": set.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn secret() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xcc;
        s
    }
    fn secret2() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xdd;
        s
    }

    fn elements() -> Vec<&'static [u8]> {
        vec![b"alice", b"bob", b"carol"]
    }

    fn hashes_for(elems: &[&[u8]]) -> Vec<[u8; 32]> {
        elems.iter().map(|e| compute_element_hash(e)).collect()
    }

    // Test 1: build + prove + verify happy path
    #[test]
    fn test_build_prove_verify() {
        let elems = elements();
        let set = build_set(&elems).unwrap();
        let hashes = hashes_for(&elems);
        let proof = prove_membership(&set, &hashes, b"bob", &secret()).unwrap();
        assert!(proof.verified);
        assert!(!proof.mainnet_ready);
        assert_eq!(proof.set_id, set.set_id);
        let ok = verify_membership(&proof, &set, &hashes, b"bob", &secret());
        assert!(ok);
        // Wrong secret fails
        let bad = verify_membership(&proof, &set, &hashes, b"bob", &secret2());
        assert!(!bad);
    }

    // Test 2: element not in set rejected
    #[test]
    fn test_element_not_in_set_rejected() {
        let elems = elements();
        let set = build_set(&elems).unwrap();
        let hashes = hashes_for(&elems);
        let err = prove_membership(&set, &hashes, b"dave", &secret()).unwrap_err();
        assert_eq!(err, MembershipError::ElementNotInSet);
    }

    // Test 3: empty set rejected
    #[test]
    fn test_empty_set_rejected() {
        let err = build_set(&[]).unwrap_err();
        assert_eq!(err, MembershipError::EmptySet);
    }

    // Test 4: zero secret rejected
    #[test]
    fn test_zero_secret_rejected() {
        let elems = elements();
        let set = build_set(&elems).unwrap();
        let hashes = hashes_for(&elems);
        let err = prove_membership(&set, &hashes, b"alice", &[0u8; 32]).unwrap_err();
        assert_eq!(err, MembershipError::ZeroSecret);
    }

    // Test 5: proof commitment unique per secret (same element, different secrets)
    #[test]
    fn test_commitment_unique_per_secret() {
        let elems = elements();
        let set = build_set(&elems).unwrap();
        let hashes = hashes_for(&elems);
        let proof1 = prove_membership(&set, &hashes, b"alice", &secret()).unwrap();
        let proof2 = prove_membership(&set, &hashes, b"alice", &secret2()).unwrap();
        assert_ne!(proof1.commitment, proof2.commitment);
        assert_ne!(proof1.proof_id, proof2.proof_id);
    }

    // Test 6: proof_id is deterministic (same element + same secret → same proof_id)
    #[test]
    fn test_deterministic_proof_id() {
        let elems = elements();
        let set = build_set(&elems).unwrap();
        let hashes = hashes_for(&elems);
        let p1 = prove_membership(&set, &hashes, b"carol", &secret()).unwrap();
        let p2 = prove_membership(&set, &hashes, b"carol", &secret()).unwrap();
        assert_eq!(p1.proof_id, p2.proof_id);
        assert_eq!(p1.commitment, p2.commitment);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_set_id_nonzero() {
        let set = build_set(&elements()).unwrap();
        assert_ne!(set.set_id, [0u8; 32]);
    }

    #[test]
    fn test_element_root_nonzero() {
        let set = build_set(&elements()).unwrap();
        assert_ne!(set.element_root, [0u8; 32]);
    }

    #[test]
    fn test_set_mainnet_ready_false() {
        let set = build_set(&elements()).unwrap();
        assert!(!set.mainnet_ready);
    }

    #[test]
    fn test_proof_mainnet_ready_false() {
        let elems = elements();
        let set = build_set(&elems).unwrap();
        let hashes = hashes_for(&elems);
        let proof = prove_membership(&set, &hashes, b"alice", &secret()).unwrap();
        assert!(!proof.mainnet_ready);
    }

    #[test]
    fn test_set_size_matches_element_count() {
        let set = build_set(&elements()).unwrap();
        assert_eq!(set.size, 3);
    }

    #[test]
    fn test_different_sets_different_set_id() {
        let s1 = build_set(&[b"a", b"b"]).unwrap();
        let s2 = build_set(&[b"c", b"d"]).unwrap();
        assert_ne!(s1.set_id, s2.set_id);
    }

    #[test]
    fn test_element_hash_nonzero() {
        let h = compute_element_hash(b"test_elem");
        assert_ne!(h, [0u8; 32]);
    }

    #[test]
    fn test_element_hash_deterministic() {
        let h1 = compute_element_hash(b"deterministic");
        let h2 = compute_element_hash(b"deterministic");
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_public_record_fields() {
        let set = build_set(&elements()).unwrap();
        let record = set_public_record(&set);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["set_id"].is_string());
        assert_eq!(v["mainnet_ready"], false);
        assert_eq!(v["size"], 3);
    }

    #[test]
    fn test_verify_wrong_element_fails() {
        let elems = elements();
        let set = build_set(&elems).unwrap();
        let hashes = hashes_for(&elems);
        let proof = prove_membership(&set, &hashes, b"alice", &secret()).unwrap();
        // Verify with wrong element (bob instead of alice)
        let ok = verify_membership(&proof, &set, &hashes, b"bob", &secret());
        assert!(!ok);
    }
}
