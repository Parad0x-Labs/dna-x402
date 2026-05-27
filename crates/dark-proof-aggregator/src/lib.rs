use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

// ── Constants ──────────────────────────────────────────────────────────────

pub const MAX_INPUTS: usize = 32;

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AggregatedProof {
    pub agg_id: [u8; 32],
    pub input_proofs: Vec<[u8; 32]>,
    pub output_hash: [u8; 32],
    pub compression_ratio: f32,
    pub is_stub: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum AggError {
    EmptyInputs,
    TooManyInputs,
    DuplicateInput,
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

fn compute_output_hash(input_proofs: &[[u8; 32]], count: u32) -> [u8; 32] {
    let xored = xor_fold(input_proofs);
    let mut d = Vec::new();
    d.extend_from_slice(b"agg-output-v1");
    d.extend_from_slice(&xored);
    d.extend_from_slice(&count.to_le_bytes());
    sha256(&d)
}

fn compute_agg_id(output_hash: &[u8; 32], count: u32) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"agg-id-v1");
    d.extend_from_slice(output_hash);
    d.extend_from_slice(&count.to_le_bytes());
    sha256(&d)
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn aggregate_proofs(input_proofs: Vec<[u8; 32]>) -> Result<AggregatedProof, AggError> {
    if input_proofs.is_empty() {
        return Err(AggError::EmptyInputs);
    }
    if input_proofs.len() > MAX_INPUTS {
        return Err(AggError::TooManyInputs);
    }
    let mut seen: HashSet<[u8; 32]> = HashSet::new();
    for p in &input_proofs {
        if !seen.insert(*p) {
            return Err(AggError::DuplicateInput);
        }
    }
    let count = input_proofs.len() as u32;
    let output_hash = compute_output_hash(&input_proofs, count);
    let agg_id = compute_agg_id(&output_hash, count);
    let compression_ratio = input_proofs.len() as f32 / 1.0;
    Ok(AggregatedProof {
        agg_id,
        input_proofs,
        output_hash,
        compression_ratio,
        is_stub: true,
        mainnet_ready: false,
    })
}

pub fn verify_aggregated(proof: &AggregatedProof) -> bool {
    let count = proof.input_proofs.len() as u32;
    let expected_output = compute_output_hash(&proof.input_proofs, count);
    if expected_output != proof.output_hash {
        return false;
    }
    let expected_id = compute_agg_id(&proof.output_hash, count);
    expected_id == proof.agg_id
}

pub fn agg_public_record(proof: &AggregatedProof) -> String {
    serde_json::json!({
        "agg_id": hex(&proof.agg_id),
        "output_hash": hex(&proof.output_hash),
        "proof_count": proof.input_proofs.len(),
        "compression_ratio": proof.compression_ratio,
        "is_stub": proof.is_stub,
        "mainnet_ready": proof.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_proof(seed: u8) -> [u8; 32] {
        let mut p = [0u8; 32];
        p[0] = seed;
        p
    }

    // Test 1: aggregate 4 proofs + verify passes
    #[test]
    fn test_aggregate_and_verify() {
        let proofs = vec![make_proof(1), make_proof(2), make_proof(3), make_proof(4)];
        let agg = aggregate_proofs(proofs).unwrap();
        assert_eq!(agg.input_proofs.len(), 4);
        assert!(agg.is_stub);
        assert!(!agg.mainnet_ready);
        assert!(verify_aggregated(&agg));
    }

    // Test 2: deterministic
    #[test]
    fn test_deterministic() {
        let proofs = vec![make_proof(5), make_proof(6)];
        let a1 = aggregate_proofs(proofs.clone()).unwrap();
        let a2 = aggregate_proofs(proofs).unwrap();
        assert_eq!(a1.agg_id, a2.agg_id);
        assert_eq!(a1.output_hash, a2.output_hash);
    }

    // Test 3: output sensitive to inputs
    #[test]
    fn test_output_sensitive_to_inputs() {
        // Use clearly distinct proofs so XOR-fold cannot collide
        let p1 = vec![make_proof(1), make_proof(2), make_proof(3)];
        let p2 = vec![make_proof(4), make_proof(5), make_proof(6)];
        let a1 = aggregate_proofs(p1).unwrap();
        let a2 = aggregate_proofs(p2).unwrap();
        assert_ne!(a1.output_hash, a2.output_hash);
        assert_ne!(a1.agg_id, a2.agg_id);
    }

    // Test 4: empty inputs rejected
    #[test]
    fn test_empty_rejected() {
        let err = aggregate_proofs(vec![]).unwrap_err();
        assert_eq!(err, AggError::EmptyInputs);
    }

    // Test 5: too many inputs rejected
    #[test]
    fn test_too_many_rejected() {
        let proofs: Vec<[u8; 32]> = (0u8..=32).map(make_proof).collect();
        let err = aggregate_proofs(proofs).unwrap_err();
        assert_eq!(err, AggError::TooManyInputs);
    }

    // Test 6: duplicate input rejected
    #[test]
    fn test_duplicate_rejected() {
        let proofs = vec![make_proof(7), make_proof(7)];
        let err = aggregate_proofs(proofs).unwrap_err();
        assert_eq!(err, AggError::DuplicateInput);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_agg_id_nonzero() {
        let agg = aggregate_proofs(vec![make_proof(1), make_proof(2)]).unwrap();
        assert_ne!(agg.agg_id, [0u8; 32]);
    }

    #[test]
    fn test_output_hash_nonzero() {
        let agg = aggregate_proofs(vec![make_proof(3), make_proof(4)]).unwrap();
        assert_ne!(agg.output_hash, [0u8; 32]);
    }

    #[test]
    fn test_is_stub_true() {
        let agg = aggregate_proofs(vec![make_proof(5)]).unwrap();
        assert!(agg.is_stub);
    }

    #[test]
    fn test_mainnet_ready_false() {
        let agg = aggregate_proofs(vec![make_proof(6)]).unwrap();
        assert!(!agg.mainnet_ready);
    }

    #[test]
    fn test_proof_count_stored() {
        let agg = aggregate_proofs(vec![make_proof(8), make_proof(9), make_proof(10)]).unwrap();
        assert_eq!(agg.input_proofs.len(), 3);
    }

    #[test]
    fn test_verify_fails_on_tampered_output_hash() {
        let mut agg = aggregate_proofs(vec![make_proof(11), make_proof(12)]).unwrap();
        agg.output_hash[0] ^= 0xFF;
        assert!(!verify_aggregated(&agg));
    }

    #[test]
    fn test_max_inputs_ok() {
        let proofs: Vec<[u8; 32]> = (0u8..32).map(make_proof).collect();
        let agg = aggregate_proofs(proofs).unwrap();
        assert_eq!(agg.input_proofs.len(), MAX_INPUTS);
        assert!(verify_aggregated(&agg));
    }

    #[test]
    fn test_public_record_has_proof_count() {
        let agg = aggregate_proofs(vec![make_proof(20), make_proof(21)]).unwrap();
        let record = agg_public_record(&agg);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert_eq!(v["proof_count"], 2u64);
        assert_eq!(v["mainnet_ready"], false);
        assert!(v["agg_id"].is_string());
    }

    #[test]
    fn test_agg_id_count_sensitive() {
        let agg1 = aggregate_proofs(vec![make_proof(30)]).unwrap();
        let agg2 = aggregate_proofs(vec![make_proof(30), make_proof(31)]).unwrap();
        assert_ne!(agg1.agg_id, agg2.agg_id);
    }

    #[test]
    fn test_compression_ratio_reflects_count() {
        let agg3 = aggregate_proofs(vec![make_proof(40), make_proof(41), make_proof(42)]).unwrap();
        assert!((agg3.compression_ratio - 3.0_f32).abs() < f32::EPSILON);
    }
}
