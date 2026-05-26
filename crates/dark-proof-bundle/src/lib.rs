use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};

// ── Constants ──────────────────────────────────────────────────────────────

pub const MAX_BUNDLE_SIZE: usize = 16;

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProofBundle {
    pub bundle_id: [u8; 32],
    pub proof_hashes: Vec<[u8; 32]>,
    pub aggregate_hash: [u8; 32],
    pub proof_count: u32,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum BundleError {
    EmptyBundle,
    TooManyProofs,
    DuplicateProof,
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

fn compute_aggregate(proof_hashes: &[[u8; 32]]) -> [u8; 32] {
    let xor = xor_fold(proof_hashes);
    let count = proof_hashes.len() as u32;
    let mut d = Vec::new();
    d.extend_from_slice(b"bundle-agg-v1");
    d.extend_from_slice(&xor);
    d.extend_from_slice(&count.to_le_bytes());
    sha256(&d)
}

fn compute_bundle_id(aggregate_hash: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"bundle-id-v1");
    d.extend_from_slice(aggregate_hash);
    sha256(&d)
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn create_bundle(proof_hashes: Vec<[u8; 32]>) -> Result<ProofBundle, BundleError> {
    if proof_hashes.is_empty() {
        return Err(BundleError::EmptyBundle);
    }
    if proof_hashes.len() > MAX_BUNDLE_SIZE {
        return Err(BundleError::TooManyProofs);
    }
    // check for duplicates
    for i in 0..proof_hashes.len() {
        for j in (i + 1)..proof_hashes.len() {
            if proof_hashes[i] == proof_hashes[j] {
                return Err(BundleError::DuplicateProof);
            }
        }
    }
    let count = proof_hashes.len() as u32;
    let aggregate_hash = compute_aggregate(&proof_hashes);
    let bundle_id = compute_bundle_id(&aggregate_hash);
    Ok(ProofBundle {
        bundle_id,
        proof_hashes,
        aggregate_hash,
        proof_count: count,
        mainnet_ready: false,
    })
}

pub fn verify_bundle(bundle: &ProofBundle) -> bool {
    let agg = compute_aggregate(&bundle.proof_hashes);
    if agg != bundle.aggregate_hash {
        return false;
    }
    let bid = compute_bundle_id(&agg);
    bid == bundle.bundle_id
}

pub fn add_proof(bundle: &mut ProofBundle, proof_hash: [u8; 32]) -> Result<(), BundleError> {
    if bundle.proof_hashes.contains(&proof_hash) {
        return Err(BundleError::DuplicateProof);
    }
    if bundle.proof_hashes.len() >= MAX_BUNDLE_SIZE {
        return Err(BundleError::TooManyProofs);
    }
    bundle.proof_hashes.push(proof_hash);
    bundle.proof_count = bundle.proof_hashes.len() as u32;
    bundle.aggregate_hash = compute_aggregate(&bundle.proof_hashes);
    bundle.bundle_id = compute_bundle_id(&bundle.aggregate_hash);
    Ok(())
}

pub fn bundle_public_record(bundle: &ProofBundle) -> String {
    serde_json::json!({
        "bundle_id": hex(&bundle.bundle_id),
        "aggregate_hash": hex(&bundle.aggregate_hash),
        "proof_count": bundle.proof_count,
        "mainnet_ready": bundle.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn ph(b: u8) -> [u8; 32] {
        let mut h = [0u8; 32];
        h[0] = b;
        h
    }

    // Test 1: create + verify passes
    #[test]
    fn test_create_and_verify() {
        let bundle = create_bundle(vec![ph(1), ph(2), ph(3)]).unwrap();
        assert!(!bundle.mainnet_ready);
        assert_eq!(bundle.proof_count, 3);
        assert!(verify_bundle(&bundle));
    }

    // Test 2: add_proof grows bundle and verify still passes
    #[test]
    fn test_add_proof_grows() {
        let mut bundle = create_bundle(vec![ph(1), ph(2)]).unwrap();
        assert_eq!(bundle.proof_count, 2);
        add_proof(&mut bundle, ph(5)).unwrap();
        assert_eq!(bundle.proof_count, 3);
        assert!(verify_bundle(&bundle));
    }

    // Test 3: too many proofs rejected
    #[test]
    fn test_too_many_proofs() {
        let hashes: Vec<[u8; 32]> = (0..17u8).map(|b| ph(b)).collect();
        let err = create_bundle(hashes).unwrap_err();
        assert_eq!(err, BundleError::TooManyProofs);
    }

    // Test 4: empty bundle rejected
    #[test]
    fn test_empty_bundle_rejected() {
        let err = create_bundle(vec![]).unwrap_err();
        assert_eq!(err, BundleError::EmptyBundle);
    }

    // Test 5: duplicate proof rejected
    #[test]
    fn test_duplicate_proof_rejected() {
        let err = create_bundle(vec![ph(1), ph(2), ph(1)]).unwrap_err();
        assert_eq!(err, BundleError::DuplicateProof);
    }

    // Test 6: deterministic aggregate — same inputs, same aggregate_hash
    #[test]
    fn test_deterministic_aggregate() {
        let b1 = create_bundle(vec![ph(10), ph(20)]).unwrap();
        let b2 = create_bundle(vec![ph(10), ph(20)]).unwrap();
        assert_eq!(b1.aggregate_hash, b2.aggregate_hash);
        assert_eq!(b1.bundle_id, b2.bundle_id);
    }
}
