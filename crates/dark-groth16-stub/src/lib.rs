use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Groth16Proof {
    pub proof_a: [u8; 32],
    pub proof_b: [u8; 32],
    pub proof_c: [u8; 32],
    pub public_inputs_hash: [u8; 32],
    pub is_stub: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifyResult {
    pub verified: bool,
    pub is_stub: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Groth16Error {
    EmptyInputs,
    ZeroProvingKey,
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

fn compute_public_inputs_hash(public_inputs: &[&[u8]]) -> [u8; 32] {
    let input_hashes: Vec<[u8; 32]> = public_inputs
        .iter()
        .enumerate()
        .map(|(i, inp)| sha256(&[b"groth16-input-v1", &[i as u8], inp]))
        .collect();
    let folded = xor_fold(&input_hashes);
    sha256(&[b"groth16-inputs-v1", &folded])
}

pub fn create_proof(
    proving_key: &[u8; 32],
    public_inputs: &[&[u8]],
) -> Result<Groth16Proof, Groth16Error> {
    if proving_key == &[0u8; 32] {
        return Err(Groth16Error::ZeroProvingKey);
    }
    if public_inputs.is_empty() {
        return Err(Groth16Error::EmptyInputs);
    }
    let public_inputs_hash = compute_public_inputs_hash(public_inputs);
    let proof_a = sha256(&[b"groth16-a-v1", proving_key, &public_inputs_hash]);
    let proof_b = sha256(&[b"groth16-b-v1", proving_key, &proof_a]);
    let proof_c = sha256(&[b"groth16-c-v1", proving_key, &proof_a, &proof_b]);
    Ok(Groth16Proof {
        proof_a,
        proof_b,
        proof_c,
        public_inputs_hash,
        is_stub: true,
        mainnet_ready: false,
    })
}

pub fn verify_proof(
    proof: &Groth16Proof,
    _verifying_key: &[u8; 32],
    public_inputs: &[&[u8]],
) -> VerifyResult {
    let recomputed = compute_public_inputs_hash(public_inputs);
    VerifyResult {
        verified: recomputed == proof.public_inputs_hash,
        is_stub: true,
        mainnet_ready: false,
    }
}

pub fn proof_public_record(proof: &Groth16Proof) -> String {
    let obj = serde_json::json!({
        "proof_a": hex::encode_fixed(proof.proof_a),
        "proof_b": hex::encode_fixed(proof.proof_b),
        "proof_c": hex::encode_fixed(proof.proof_c),
        "public_inputs_hash": hex::encode_fixed(proof.public_inputs_hash),
        "is_stub": proof.is_stub,
        "mainnet_ready": proof.mainnet_ready,
    });
    serde_json::to_string(&obj).unwrap()
}

mod hex {
    pub fn encode_fixed(b: [u8; 32]) -> String {
        b.iter().map(|x| format!("{:02x}", x)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> [u8; 32] {
        [1u8; 32]
    }

    fn inputs<'a>() -> Vec<&'a [u8]> {
        vec![b"hello", b"world"]
    }

    #[test]
    fn test_happy_path() {
        let proof = create_proof(&key(), &inputs()).unwrap();
        let result = verify_proof(&proof, &key(), &inputs());
        assert!(result.verified);
        assert!(result.is_stub);
        assert!(!result.mainnet_ready);
    }

    #[test]
    fn test_deterministic() {
        let p1 = create_proof(&key(), &inputs()).unwrap();
        let p2 = create_proof(&key(), &inputs()).unwrap();
        assert_eq!(p1.proof_a, p2.proof_a);
        assert_eq!(p1.proof_b, p2.proof_b);
        assert_eq!(p1.proof_c, p2.proof_c);
        assert_eq!(p1.public_inputs_hash, p2.public_inputs_hash);
    }

    #[test]
    fn test_input_sensitivity() {
        let p1 = create_proof(&key(), &[b"hello" as &[u8]]).unwrap();
        let p2 = create_proof(&key(), &[b"world" as &[u8]]).unwrap();
        assert_ne!(p1.public_inputs_hash, p2.public_inputs_hash);
        assert_ne!(p1.proof_a, p2.proof_a);
    }

    #[test]
    fn test_zero_key_rejected() {
        let zero = [0u8; 32];
        let err = create_proof(&zero, &inputs()).unwrap_err();
        assert_eq!(err, Groth16Error::ZeroProvingKey);
    }

    #[test]
    fn test_empty_inputs_rejected() {
        let err = create_proof(&key(), &[]).unwrap_err();
        assert_eq!(err, Groth16Error::EmptyInputs);
    }

    #[test]
    fn test_public_record_flags() {
        let proof = create_proof(&key(), &inputs()).unwrap();
        let record = proof_public_record(&proof);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert_eq!(v["is_stub"], true);
        assert_eq!(v["mainnet_ready"], false);
    }
}
