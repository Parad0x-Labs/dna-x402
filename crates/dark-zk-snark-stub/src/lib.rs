use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnarkStatement {
    pub circuit_id: [u8; 32],
    pub public_inputs_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnarkProof {
    pub statement: SnarkStatement,
    pub proof_a: Vec<u8>, // 64 bytes
    pub proof_b: Vec<u8>, // 128 bytes
    pub proof_c: Vec<u8>, // 64 bytes
    pub proof_hash: [u8; 32],
    pub is_stub: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum SnarkError {
    EmptyPublicInputs,
    CircuitIdZero,
}

fn hash_input(input: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"snark-input-v1");
    h.update(input);
    h.finalize().into()
}

pub fn create_statement(
    circuit_id: [u8; 32],
    public_inputs: &[&[u8]],
) -> Result<SnarkStatement, SnarkError> {
    if circuit_id == [0u8; 32] {
        return Err(SnarkError::CircuitIdZero);
    }
    if public_inputs.is_empty() {
        return Err(SnarkError::EmptyPublicInputs);
    }

    // XOR-fold SHA256("snark-input-v1" || input) for each input
    let mut accumulator = [0u8; 32];
    for input in public_inputs {
        let h = hash_input(input);
        for i in 0..32 {
            accumulator[i] ^= h[i];
        }
    }

    Ok(SnarkStatement {
        circuit_id,
        public_inputs_hash: accumulator,
        mainnet_ready: false,
    })
}

fn compute_proof_hash(circuit_id: &[u8; 32], public_inputs_hash: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"snark-proof-v1");
    h.update(circuit_id);
    h.update(public_inputs_hash);
    h.finalize().into()
}

pub fn generate_stub_proof(statement: &SnarkStatement) -> SnarkProof {
    let proof_hash = compute_proof_hash(&statement.circuit_id, &statement.public_inputs_hash);

    // proof_a: [0xDE, 0xAD, ...rest SHA256(proof_hash)...] — 64 bytes
    let mut proof_a = vec![0u8; 64];
    proof_a[0] = 0xDE;
    proof_a[1] = 0xAD;
    let fill_a: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(proof_hash);
        h.finalize().into()
    };
    proof_a[2..34].copy_from_slice(&fill_a);

    // proof_b: same pattern × 4 — 128 bytes
    let mut proof_b = vec![0u8; 128];
    for chunk in 0..4usize {
        let mut h = Sha256::new();
        h.update(proof_hash);
        h.update([chunk as u8]);
        let seg: [u8; 32] = h.finalize().into();
        let start = chunk * 32;
        proof_b[start..start + 32].copy_from_slice(&seg);
    }
    proof_b[0] = 0xDE;
    proof_b[1] = 0xAD;

    // proof_c: same as proof_a pattern — 64 bytes
    let mut proof_c = vec![0u8; 64];
    proof_c[0] = 0xDE;
    proof_c[1] = 0xAD;
    let fill_c: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"proof-c");
        h.update(proof_hash);
        h.finalize().into()
    };
    proof_c[2..34].copy_from_slice(&fill_c);

    SnarkProof {
        statement: statement.clone(),
        proof_a,
        proof_b,
        proof_c,
        proof_hash,
        is_stub: true,
        mainnet_ready: false,
    }
}

pub fn verify_stub_proof(proof: &SnarkProof) -> bool {
    let recomputed = compute_proof_hash(
        &proof.statement.circuit_id,
        &proof.statement.public_inputs_hash,
    );
    if recomputed != proof.proof_hash {
        return false;
    }
    if !proof.is_stub {
        return false;
    }
    // stub always passes in devnet mode
    true
}

pub fn proof_public_record(proof: &SnarkProof) -> String {
    let ph_hex: String = proof
        .proof_hash
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    let cid_hex: String = proof
        .statement
        .circuit_id
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    serde_json::json!({
        "proof_hash": ph_hex,
        "is_stub": proof.is_stub,
        "circuit_id": cid_hex,
        "mainnet_ready": proof.mainnet_ready,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn circuit_id() -> [u8; 32] {
        let mut id = [0u8; 32];
        id[0] = 0xC1;
        id[1] = 0xC2;
        id
    }

    #[test]
    fn test_create_statement_and_generate_proof() {
        let stmt = create_statement(circuit_id(), &[b"input1", b"input2"]).unwrap();
        let proof = generate_stub_proof(&stmt);
        assert!(proof.is_stub);
        assert!(!proof.mainnet_ready);
        assert!(!stmt.mainnet_ready);
        assert_eq!(proof.proof_a[0], 0xDE);
        assert_eq!(proof.proof_a[1], 0xAD);
    }

    #[test]
    fn test_verify_stub_passes() {
        let stmt = create_statement(circuit_id(), &[b"hello", b"world"]).unwrap();
        let proof = generate_stub_proof(&stmt);
        assert!(verify_stub_proof(&proof));
    }

    #[test]
    fn test_empty_inputs_rejected() {
        let err = create_statement(circuit_id(), &[]).unwrap_err();
        assert_eq!(err, SnarkError::EmptyPublicInputs);
    }

    #[test]
    fn test_zero_circuit_id_rejected() {
        let err = create_statement([0u8; 32], &[b"input"]).unwrap_err();
        assert_eq!(err, SnarkError::CircuitIdZero);
    }

    #[test]
    fn test_proof_hash_deterministic() {
        let stmt1 = create_statement(circuit_id(), &[b"foo", b"bar"]).unwrap();
        let stmt2 = create_statement(circuit_id(), &[b"foo", b"bar"]).unwrap();
        let p1 = generate_stub_proof(&stmt1);
        let p2 = generate_stub_proof(&stmt2);
        assert_eq!(p1.proof_hash, p2.proof_hash);
        assert_eq!(
            p1.statement.public_inputs_hash,
            p2.statement.public_inputs_hash
        );
    }

    #[test]
    fn test_public_record_shape() {
        let stmt = create_statement(circuit_id(), &[b"x"]).unwrap();
        let proof = generate_stub_proof(&stmt);
        let json_str = proof_public_record(&proof);
        let v: serde_json::Value = serde_json::from_str(&json_str).unwrap();
        assert!(v["proof_hash"].is_string());
        assert_eq!(v["is_stub"], true);
        assert!(v["circuit_id"].is_string());
        assert_eq!(v["mainnet_ready"], false);
        assert!(!v["mainnet_ready"].as_bool().unwrap());
    }
}
