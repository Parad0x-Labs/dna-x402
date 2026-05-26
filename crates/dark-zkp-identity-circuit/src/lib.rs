use sha2::{Digest, Sha256};

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct IdentityCircuit {
    /// SHA256("idc-id-v1" || commitment || nullifier)
    pub circuit_id: [u8; 32],
    /// SHA256("idc-commit-v1" || secret || attr_hash)
    pub commitment: [u8; 32],
    /// SHA256("idc-null-v1" || secret || circuit_id_seed)
    pub nullifier: [u8; 32],
    pub is_stub: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone)]
pub struct CircuitProof {
    /// SHA256("idc-proof-v1" || circuit_id || public_inputs_hash)
    pub proof_id: [u8; 32],
    pub circuit_id: [u8; 32],
    /// SHA256("idc-pub-v1" || circuit_id || attr_hash)
    pub public_inputs_hash: [u8; 32],
    pub is_stub: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum CircuitError {
    ZeroSecret,
    EmptyAttributes,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn sha256_parts(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

// ── Hash formulas ─────────────────────────────────────────────────────────────

pub fn attribute_hash(attrs: &[u8]) -> [u8; 32] {
    sha256_parts(&[b"idc-attr-v1", attrs])
}

pub fn commitment_hash(secret: &[u8; 32], attr_hash: &[u8; 32]) -> [u8; 32] {
    sha256_parts(&[b"idc-commit-v1", secret.as_ref(), attr_hash.as_ref()])
}

pub fn nullifier_hash(secret: &[u8; 32], circuit_id_seed: &[u8; 32]) -> [u8; 32] {
    sha256_parts(&[b"idc-null-v1", secret.as_ref(), circuit_id_seed.as_ref()])
}

pub fn circuit_id_hash(commitment: &[u8; 32], nullifier: &[u8; 32]) -> [u8; 32] {
    sha256_parts(&[b"idc-id-v1", commitment.as_ref(), nullifier.as_ref()])
}

pub fn public_inputs_hash(circuit_id: &[u8; 32], attr_hash: &[u8; 32]) -> [u8; 32] {
    sha256_parts(&[b"idc-pub-v1", circuit_id.as_ref(), attr_hash.as_ref()])
}

pub fn proof_id_hash(circuit_id: &[u8; 32], pub_inputs: &[u8; 32]) -> [u8; 32] {
    sha256_parts(&[b"idc-proof-v1", circuit_id.as_ref(), pub_inputs.as_ref()])
}

// ── Public API ────────────────────────────────────────────────────────────────

pub fn new_circuit(
    secret: &[u8; 32],
    attributes: &[u8],
    circuit_id_seed: &[u8; 32],
) -> Result<IdentityCircuit, CircuitError> {
    if secret == &[0u8; 32] {
        return Err(CircuitError::ZeroSecret);
    }
    if attributes.is_empty() {
        return Err(CircuitError::EmptyAttributes);
    }

    let attr_h = attribute_hash(attributes);
    let commit = commitment_hash(secret, &attr_h);
    let null = nullifier_hash(secret, circuit_id_seed);
    let cid = circuit_id_hash(&commit, &null);

    Ok(IdentityCircuit {
        circuit_id: cid,
        commitment: commit,
        nullifier: null,
        is_stub: true,
        mainnet_ready: false,
    })
}

pub fn generate_proof(circuit: &IdentityCircuit, attributes: &[u8]) -> CircuitProof {
    let attr_h = attribute_hash(attributes);
    let pub_inputs = public_inputs_hash(&circuit.circuit_id, &attr_h);
    let pid = proof_id_hash(&circuit.circuit_id, &pub_inputs);

    CircuitProof {
        proof_id: pid,
        circuit_id: circuit.circuit_id,
        public_inputs_hash: pub_inputs,
        is_stub: true,
        mainnet_ready: false,
    }
}

pub fn verify_proof(circuit: &IdentityCircuit, proof: &CircuitProof) -> bool {
    proof.proof_id != [0u8; 32] && proof.circuit_id == circuit.circuit_id
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: [u8; 32] = [0x01u8; 32];
    const SEED: [u8; 32] = [0x02u8; 32];
    const ATTRS: &[u8] = b"name:alice,age:30";

    #[test]
    fn new_circuit_works_is_stub_true_mainnet_ready_false() {
        let circuit = new_circuit(&SECRET, ATTRS, &SEED).unwrap();
        assert!(circuit.is_stub);
        assert!(!circuit.mainnet_ready);
        assert_ne!(circuit.circuit_id, [0u8; 32]);
        assert_ne!(circuit.commitment, [0u8; 32]);
        assert_ne!(circuit.nullifier, [0u8; 32]);
    }

    #[test]
    fn proof_generation_is_deterministic() {
        let circuit = new_circuit(&SECRET, ATTRS, &SEED).unwrap();
        let p1 = generate_proof(&circuit, ATTRS);
        let p2 = generate_proof(&circuit, ATTRS);
        assert_eq!(p1.proof_id, p2.proof_id);
        assert_eq!(p1.public_inputs_hash, p2.public_inputs_hash);
    }

    #[test]
    fn verify_returns_true_for_valid_proof() {
        let circuit = new_circuit(&SECRET, ATTRS, &SEED).unwrap();
        let proof = generate_proof(&circuit, ATTRS);
        assert!(verify_proof(&circuit, &proof));
    }

    #[test]
    fn different_attributes_produce_different_commitment() {
        let circuit1 = new_circuit(&SECRET, ATTRS, &SEED).unwrap();
        let circuit2 = new_circuit(&SECRET, b"name:bob,age:25", &SEED).unwrap();
        assert_ne!(circuit1.commitment, circuit2.commitment);
    }

    #[test]
    fn zero_secret_rejected() {
        let result = new_circuit(&[0u8; 32], ATTRS, &SEED);
        assert_eq!(result.unwrap_err(), CircuitError::ZeroSecret);
    }

    #[test]
    fn empty_attributes_rejected() {
        let result = new_circuit(&SECRET, b"", &SEED);
        assert_eq!(result.unwrap_err(), CircuitError::EmptyAttributes);
    }
}
