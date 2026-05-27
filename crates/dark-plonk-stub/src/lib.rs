use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlonkProof {
    pub commitment: [u8; 32],
    pub opening: [u8; 32],
    pub eval_hash: [u8; 32],
    pub is_stub: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PlonkError {
    EmptyWitness,
    ZeroSRS,
}

fn sha256(data: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for d in data {
        h.update(d);
    }
    h.finalize().into()
}

fn xor_fold(hashes: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = [0u8; 32];
    for h in hashes {
        for (a, b) in acc.iter_mut().zip(h.iter()) {
            *a ^= b;
        }
    }
    acc
}

fn compute_witness_hash(witness: &[&[u8]]) -> [u8; 32] {
    let w_hashes: Vec<[u8; 32]> = witness
        .iter()
        .enumerate()
        .map(|(i, w)| sha256(&[b"plonk-w-v1", &[i as u8], w]))
        .collect();
    let folded = xor_fold(&w_hashes);
    sha256(&[b"plonk-witness-v1", &folded])
}

pub fn create_plonk_proof(srs: &[u8; 32], witness: &[&[u8]]) -> Result<PlonkProof, PlonkError> {
    if srs == &[0u8; 32] {
        return Err(PlonkError::ZeroSRS);
    }
    if witness.is_empty() {
        return Err(PlonkError::EmptyWitness);
    }
    let srs_hash = sha256(&[b"plonk-srs-v1", srs]);
    let witness_hash = compute_witness_hash(witness);
    let commitment = sha256(&[b"plonk-commit-v1", &srs_hash, &witness_hash]);
    let challenge_hash = sha256(&[b"plonk-challenge-v1", &commitment]);
    let opening = sha256(&[b"plonk-open-v1", &commitment, &challenge_hash]);
    let eval_hash = sha256(&[b"plonk-eval-v1", &opening, &commitment]);
    Ok(PlonkProof {
        commitment,
        opening,
        eval_hash,
        is_stub: true,
        mainnet_ready: false,
    })
}

pub fn verify_plonk(proof: &PlonkProof, srs: &[u8; 32], witness: &[&[u8]]) -> bool {
    if srs == &[0u8; 32] || witness.is_empty() {
        return false;
    }
    let srs_hash = sha256(&[b"plonk-srs-v1", srs]);
    let witness_hash = compute_witness_hash(witness);
    let expected_commitment = sha256(&[b"plonk-commit-v1", &srs_hash, &witness_hash]);
    expected_commitment == proof.commitment
}

pub fn plonk_public_record(proof: &PlonkProof) -> String {
    let obj = serde_json::json!({
        "commitment": hex_encode(proof.commitment),
        "opening": hex_encode(proof.opening),
        "eval_hash": hex_encode(proof.eval_hash),
        "is_stub": proof.is_stub,
        "mainnet_ready": proof.mainnet_ready,
    });
    serde_json::to_string(&obj).unwrap()
}

fn hex_encode(b: [u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn srs() -> [u8; 32] {
        [2u8; 32]
    }

    fn witness<'a>() -> Vec<&'a [u8]> {
        vec![b"witness1", b"witness2"]
    }

    #[test]
    fn test_happy_path_verify() {
        let proof = create_plonk_proof(&srs(), &witness()).unwrap();
        assert!(verify_plonk(&proof, &srs(), &witness()));
        assert!(proof.is_stub);
        assert!(!proof.mainnet_ready);
    }

    #[test]
    fn test_deterministic() {
        let p1 = create_plonk_proof(&srs(), &witness()).unwrap();
        let p2 = create_plonk_proof(&srs(), &witness()).unwrap();
        assert_eq!(p1.commitment, p2.commitment);
        assert_eq!(p1.opening, p2.opening);
        assert_eq!(p1.eval_hash, p2.eval_hash);
    }

    #[test]
    fn test_witness_sensitivity() {
        let p1 = create_plonk_proof(&srs(), &[b"a" as &[u8]]).unwrap();
        let p2 = create_plonk_proof(&srs(), &[b"b" as &[u8]]).unwrap();
        assert_ne!(p1.commitment, p2.commitment);
        assert_ne!(p1.opening, p2.opening);
    }

    #[test]
    fn test_zero_srs_rejected() {
        let zero = [0u8; 32];
        let err = create_plonk_proof(&zero, &witness()).unwrap_err();
        assert_eq!(err, PlonkError::ZeroSRS);
    }

    #[test]
    fn test_empty_witness_rejected() {
        let err = create_plonk_proof(&srs(), &[]).unwrap_err();
        assert_eq!(err, PlonkError::EmptyWitness);
    }

    #[test]
    fn test_is_stub_and_mainnet_ready() {
        let proof = create_plonk_proof(&srs(), &witness()).unwrap();
        let record = plonk_public_record(&proof);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert_eq!(v["is_stub"], true);
        assert_eq!(v["mainnet_ready"], false);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_commitment_nonzero() {
        let proof = create_plonk_proof(&srs(), &witness()).unwrap();
        assert_ne!(proof.commitment, [0u8; 32]);
    }

    #[test]
    fn test_opening_nonzero() {
        let proof = create_plonk_proof(&srs(), &witness()).unwrap();
        assert_ne!(proof.opening, [0u8; 32]);
    }

    #[test]
    fn test_eval_hash_nonzero() {
        let proof = create_plonk_proof(&srs(), &witness()).unwrap();
        assert_ne!(proof.eval_hash, [0u8; 32]);
    }

    #[test]
    fn test_srs_sensitivity() {
        let srs2 = [3u8; 32];
        let p1 = create_plonk_proof(&srs(), &witness()).unwrap();
        let p2 = create_plonk_proof(&srs2, &witness()).unwrap();
        assert_ne!(p1.commitment, p2.commitment);
    }

    #[test]
    fn test_wrong_witness_verify_fails() {
        let proof = create_plonk_proof(&srs(), &witness()).unwrap();
        assert!(!verify_plonk(&proof, &srs(), &[b"wrong_witness" as &[u8]]));
    }

    #[test]
    fn test_zero_srs_verify_returns_false() {
        let proof = create_plonk_proof(&srs(), &witness()).unwrap();
        assert!(!verify_plonk(&proof, &[0u8; 32], &witness()));
    }

    #[test]
    fn test_empty_witness_verify_returns_false() {
        let proof = create_plonk_proof(&srs(), &witness()).unwrap();
        assert!(!verify_plonk(&proof, &srs(), &[]));
    }

    #[test]
    fn test_public_record_keys() {
        let proof = create_plonk_proof(&srs(), &witness()).unwrap();
        let record = plonk_public_record(&proof);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["commitment"].is_string());
        assert!(v["opening"].is_string());
        assert!(v["eval_hash"].is_string());
    }

    #[test]
    fn test_is_stub_always_true() {
        let proof = create_plonk_proof(&srs(), &witness()).unwrap();
        assert!(proof.is_stub);
    }

    #[test]
    fn test_verify_tampered_proof_fails() {
        let mut proof = create_plonk_proof(&srs(), &witness()).unwrap();
        proof.commitment[0] ^= 0xFF;
        assert!(!verify_plonk(&proof, &srs(), &witness()));
    }
}
