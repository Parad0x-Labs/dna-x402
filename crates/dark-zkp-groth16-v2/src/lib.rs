use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct Groth16Circuit {
    pub circuit_id: [u8; 32],
    pub pk_hash: [u8; 32],
    pub vk_hash: [u8; 32],
    pub is_stub: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone)]
pub struct Groth16ProofV2 {
    pub proof_id: [u8; 32],
    pub pi_a: [u8; 32],
    pub pi_b: [u8; 32],
    pub pi_c: [u8; 32],
    pub witness_hash: [u8; 32],
    pub public_inputs_hash: [u8; 32],
    pub is_stub: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Groth16Error {
    ZeroPk,
    EmptyWitness,
    EmptyPublicInputs,
}

fn sha256_tagged(tag: &[u8], data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(tag);
    h.update(data);
    h.finalize().into()
}

fn sha256_tagged2(tag: &[u8], a: &[u8], b: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(tag);
    h.update(a);
    h.update(b);
    h.finalize().into()
}

fn sha256_tagged4(tag: &[u8], a: &[u8], b: &[u8], c: &[u8], d: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(tag);
    h.update(a);
    h.update(b);
    h.update(c);
    h.update(d);
    h.finalize().into()
}

pub fn new_circuit(pk_bytes: &[u8], vk_bytes: &[u8]) -> Result<Groth16Circuit, Groth16Error> {
    if pk_bytes.is_empty() {
        return Err(Groth16Error::ZeroPk);
    }
    let pk_hash = sha256_tagged(b"g16v2-pk-v1", pk_bytes);
    let vk_hash = sha256_tagged(b"g16v2-vk-v1", vk_bytes);
    let circuit_id = sha256_tagged2(b"g16v2-circuit-v1", &pk_hash, &vk_hash);
    Ok(Groth16Circuit {
        circuit_id,
        pk_hash,
        vk_hash,
        is_stub: true,
        mainnet_ready: false,
    })
}

pub fn generate_proof(
    circuit: &Groth16Circuit,
    witness: &[u8],
    public_inputs: &[u8],
) -> Result<Groth16ProofV2, Groth16Error> {
    if witness.is_empty() {
        return Err(Groth16Error::EmptyWitness);
    }
    if public_inputs.is_empty() {
        return Err(Groth16Error::EmptyPublicInputs);
    }
    let witness_hash = sha256_tagged(b"g16v2-witness-v1", witness);
    let public_inputs_hash = sha256_tagged(b"g16v2-pub-v1", public_inputs);
    let pi_a = sha256_tagged2(b"g16v2-pi-a-v1", &circuit.circuit_id, &witness_hash);
    let pi_b = sha256_tagged2(b"g16v2-pi-b-v1", &circuit.pk_hash, &public_inputs_hash);
    let pi_c = sha256_tagged2(b"g16v2-pi-c-v1", &pi_a, &pi_b);
    let proof_id = sha256_tagged4(b"g16v2-proof-v1", &circuit.circuit_id, &pi_a, &pi_b, &pi_c);
    Ok(Groth16ProofV2 {
        proof_id,
        pi_a,
        pi_b,
        pi_c,
        witness_hash,
        public_inputs_hash,
        is_stub: true,
        mainnet_ready: false,
    })
}

pub fn verify_proof(circuit: &Groth16Circuit, proof: &Groth16ProofV2) -> bool {
    let _ = circuit;
    proof.proof_id != [0u8; 32]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_circuit_is_stub_and_not_mainnet_ready() {
        let c = new_circuit(b"pk_bytes_test", b"vk_bytes_test").unwrap();
        assert!(c.is_stub);
        assert!(!c.mainnet_ready);
        assert_ne!(c.circuit_id, [0u8; 32]);
    }

    #[test]
    fn generate_proof_all_fields_non_zero() {
        let c = new_circuit(b"pk_bytes_test", b"vk_bytes_test").unwrap();
        let p = generate_proof(&c, b"witness_data", b"public_inputs_data").unwrap();
        assert_ne!(p.proof_id, [0u8; 32]);
        assert_ne!(p.pi_a, [0u8; 32]);
        assert_ne!(p.pi_b, [0u8; 32]);
        assert_ne!(p.pi_c, [0u8; 32]);
        assert_ne!(p.witness_hash, [0u8; 32]);
        assert_ne!(p.public_inputs_hash, [0u8; 32]);
        assert!(p.is_stub);
        assert!(!p.mainnet_ready);
    }

    #[test]
    fn verify_returns_true() {
        let c = new_circuit(b"pk_bytes_test", b"vk_bytes_test").unwrap();
        let p = generate_proof(&c, b"witness_data", b"public_inputs_data").unwrap();
        assert!(verify_proof(&c, &p));
    }

    #[test]
    fn different_witnesses_produce_different_pi_a() {
        let c = new_circuit(b"pk_bytes_test", b"vk_bytes_test").unwrap();
        let p1 = generate_proof(&c, b"witness_one", b"public_inputs_data").unwrap();
        let p2 = generate_proof(&c, b"witness_two", b"public_inputs_data").unwrap();
        assert_ne!(p1.pi_a, p2.pi_a);
    }

    #[test]
    fn zero_pk_is_rejected() {
        let err = new_circuit(b"", b"vk_bytes_test").unwrap_err();
        assert_eq!(err, Groth16Error::ZeroPk);
    }

    #[test]
    fn empty_witness_is_rejected() {
        let c = new_circuit(b"pk_bytes_test", b"vk_bytes_test").unwrap();
        let err = generate_proof(&c, b"", b"public_inputs_data").unwrap_err();
        assert_eq!(err, Groth16Error::EmptyWitness);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_empty_public_inputs_rejected() {
        let c = new_circuit(b"pk", b"vk").unwrap();
        let err = generate_proof(&c, b"witness", b"").unwrap_err();
        assert_eq!(err, Groth16Error::EmptyPublicInputs);
    }

    #[test]
    fn test_proof_deterministic() {
        let c = new_circuit(b"pk_det", b"vk_det").unwrap();
        let p1 = generate_proof(&c, b"witness", b"inputs").unwrap();
        let p2 = generate_proof(&c, b"witness", b"inputs").unwrap();
        assert_eq!(p1.proof_id, p2.proof_id);
    }

    #[test]
    fn test_different_circuits_different_proof_id() {
        let c1 = new_circuit(b"pk_one", b"vk_same").unwrap();
        let c2 = new_circuit(b"pk_two", b"vk_same").unwrap();
        let p1 = generate_proof(&c1, b"witness", b"inputs").unwrap();
        let p2 = generate_proof(&c2, b"witness", b"inputs").unwrap();
        assert_ne!(p1.proof_id, p2.proof_id);
    }

    #[test]
    fn test_different_public_inputs_different_pi_b() {
        let c = new_circuit(b"pk_bytes", b"vk_bytes").unwrap();
        let p1 = generate_proof(&c, b"witness", b"inputs_a").unwrap();
        let p2 = generate_proof(&c, b"witness", b"inputs_b").unwrap();
        assert_ne!(p1.pi_b, p2.pi_b);
    }

    #[test]
    fn test_circuit_id_deterministic() {
        let c1 = new_circuit(b"pk_same", b"vk_same").unwrap();
        let c2 = new_circuit(b"pk_same", b"vk_same").unwrap();
        assert_eq!(c1.circuit_id, c2.circuit_id);
    }

    #[test]
    fn test_vk_hash_nonzero() {
        let c = new_circuit(b"pk_test", b"vk_test").unwrap();
        assert_ne!(c.vk_hash, [0u8; 32]);
    }

    #[test]
    fn test_verify_nonzero_proof_passes() {
        let c = new_circuit(b"pk_bytes_test", b"vk_bytes_test").unwrap();
        let p = generate_proof(&c, b"witness_data", b"inputs").unwrap();
        assert_ne!(p.proof_id, [0u8; 32]);
        assert!(verify_proof(&c, &p));
    }

    #[test]
    fn test_is_stub_true() {
        let c = new_circuit(b"pk_stub", b"vk_stub").unwrap();
        assert!(c.is_stub);
    }

    #[test]
    fn test_proof_mainnet_ready_false() {
        let c = new_circuit(b"pk_ready", b"vk_ready").unwrap();
        let p = generate_proof(&c, b"witness", b"pub").unwrap();
        assert!(!p.mainnet_ready);
    }

    #[test]
    fn test_different_vk_different_vk_hash() {
        let c1 = new_circuit(b"pk_shared", b"vk_alpha").unwrap();
        let c2 = new_circuit(b"pk_shared", b"vk_beta").unwrap();
        assert_ne!(c1.vk_hash, c2.vk_hash);
    }
}
