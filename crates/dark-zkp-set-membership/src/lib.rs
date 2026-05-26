use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetMembershipProof {
    pub proof_id: [u8; 32],
    pub set_root: [u8; 32],
    pub element_commitment: [u8; 32],
    pub nullifier: [u8; 32],
    pub is_stub: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum SetError {
    EmptySet,
    ElementNotInSet,
    ZeroBlinding,
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

fn element_hash(element: &[u8]) -> [u8; 32] {
    sha256_multi(&[b"set-elem-v1", element])
}

fn set_root(elem_hashes: &[[u8; 32]]) -> [u8; 32] {
    let xored = xor_fold(elem_hashes);
    let count = (elem_hashes.len() as u32).to_le_bytes();
    sha256_multi(&[b"set-root-v1", &xored, &count])
}

fn element_commitment(element: &[u8], blinding: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"set-commit-v1", element, blinding])
}

fn compute_nullifier(elem_commit: &[u8; 32], s_root: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"set-null-v1", elem_commit, s_root])
}

fn compute_proof_id(nullifier: &[u8; 32], s_root: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"set-proof-v1", nullifier, s_root])
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn new_membership_proof(
    elements: &[&[u8]],
    target_element: &[u8],
    blinding: &[u8; 32],
) -> Result<SetMembershipProof, SetError> {
    if elements.is_empty() {
        return Err(SetError::EmptySet);
    }
    if blinding == &[0u8; 32] {
        return Err(SetError::ZeroBlinding);
    }
    if !elements.iter().any(|e| *e == target_element) {
        return Err(SetError::ElementNotInSet);
    }
    let elem_hashes: Vec<[u8; 32]> = elements.iter().map(|e| element_hash(e)).collect();
    let s_root = set_root(&elem_hashes);
    let elem_commit = element_commitment(target_element, blinding);
    let nullifier = compute_nullifier(&elem_commit, &s_root);
    let proof_id = compute_proof_id(&nullifier, &s_root);
    Ok(SetMembershipProof {
        proof_id,
        set_root: s_root,
        element_commitment: elem_commit,
        nullifier,
        is_stub: true,
        mainnet_ready: false,
    })
}

pub fn verify_membership(proof: &SetMembershipProof) -> bool {
    proof.proof_id != [0u8; 32]
}

pub fn set_public_record(proof: &SetMembershipProof) -> String {
    serde_json::json!({
        "proof_id": hex32(&proof.proof_id),
        "set_root": hex32(&proof.set_root),
        "is_stub": proof.is_stub,
        "mainnet_ready": proof.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn blinding() -> [u8; 32] {
        let mut b = [0u8; 32];
        b[0] = 0xab;
        b
    }

    // Test 1: new_proof + is_stub=true + mainnet_ready=false
    #[test]
    fn test_new_proof_stub_flags() {
        let elements: &[&[u8]] = &[b"alice", b"bob", b"carol"];
        let proof = new_membership_proof(elements, b"bob", &blinding()).unwrap();
        assert!(proof.is_stub);
        assert!(!proof.mainnet_ready);
        assert_ne!(proof.proof_id, [0u8; 32]);
    }

    // Test 2: element_not_in_set rejected
    #[test]
    fn test_element_not_in_set_rejected() {
        let elements: &[&[u8]] = &[b"alice", b"bob"];
        let err = new_membership_proof(elements, b"dave", &blinding()).unwrap_err();
        assert_eq!(err, SetError::ElementNotInSet);
    }

    // Test 3: zero_blinding rejected
    #[test]
    fn test_zero_blinding_rejected() {
        let elements: &[&[u8]] = &[b"alice", b"bob"];
        let err = new_membership_proof(elements, b"alice", &[0u8; 32]).unwrap_err();
        assert_eq!(err, SetError::ZeroBlinding);
    }

    // Test 4: empty_set rejected
    #[test]
    fn test_empty_set_rejected() {
        let err = new_membership_proof(&[], b"alice", &blinding()).unwrap_err();
        assert_eq!(err, SetError::EmptySet);
    }

    // Test 5: verify returns true
    #[test]
    fn test_verify_returns_true() {
        let elements: &[&[u8]] = &[b"alice", b"bob", b"carol"];
        let proof = new_membership_proof(elements, b"carol", &blinding()).unwrap();
        assert!(verify_membership(&proof));
    }

    // Test 6: different sets → different set_roots
    #[test]
    fn test_different_sets_different_roots() {
        let set1: &[&[u8]] = &[b"alice", b"bob"];
        let set2: &[&[u8]] = &[b"alice", b"dave"];
        let p1 = new_membership_proof(set1, b"alice", &blinding()).unwrap();
        let p2 = new_membership_proof(set2, b"alice", &blinding()).unwrap();
        assert_ne!(p1.set_root, p2.set_root);
    }
}
