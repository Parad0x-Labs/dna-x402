use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnarkV2Proof {
    pub proof_id: [u8; 32],
    pub pi_a: [u8; 32],
    pub pi_b: [u8; 32],
    pub pi_c: [u8; 32],
    pub public_inputs_hash: [u8; 32],
    pub vk_hash: [u8; 32],
    pub is_stub: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum SnarkError {
    ZeroProvingKey,
    ZeroVerifyingKey,
    EmptyInputs,
}

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

fn sha256_2(a: &[u8], b: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(a);
    h.update(b);
    h.finalize().into()
}

fn sha256_3(a: &[u8], b: &[u8], c: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(a);
    h.update(b);
    h.update(c);
    h.finalize().into()
}

fn sha256_4(a: &[u8], b: &[u8], c: &[u8], d: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(a);
    h.update(b);
    h.update(c);
    h.update(d);
    h.finalize().into()
}

fn sha256_5(a: &[u8], b: &[u8], c: &[u8], d: &[u8], e: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(a);
    h.update(b);
    h.update(c);
    h.update(d);
    h.update(e);
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

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

/// pk_hash = SHA256("snarkv2-pk-v1" || proving_key)
fn compute_pk_hash(proving_key: &[u8; 32]) -> [u8; 32] {
    sha256_2(b"snarkv2-pk-v1", proving_key)
}

/// vk_hash = SHA256("snarkv2-vk-v1" || verifying_key)
fn compute_vk_hash(verifying_key: &[u8; 32]) -> [u8; 32] {
    sha256_2(b"snarkv2-vk-v1", verifying_key)
}

/// input_hash[i] = SHA256("snarkv2-input-v1" || [i] || input_bytes[i])
fn compute_input_hash(i: u8, input_bytes: &[u8]) -> [u8; 32] {
    sha256_3(b"snarkv2-input-v1", &[i], input_bytes)
}

/// public_inputs_hash = SHA256("snarkv2-inputs-v1" || XOR_fold(input_hashes))
fn compute_public_inputs_hash(public_inputs: &[&[u8]]) -> [u8; 32] {
    let input_hashes: Vec<[u8; 32]> = public_inputs
        .iter()
        .enumerate()
        .map(|(i, inp)| compute_input_hash(i as u8, inp))
        .collect();
    let folded = xor_fold(&input_hashes);
    sha256_2(b"snarkv2-inputs-v1", &folded)
}

/// pi_a = SHA256("snarkv2-a-v1" || pk_hash || public_inputs_hash)
fn compute_pi_a(pk_hash: &[u8; 32], public_inputs_hash: &[u8; 32]) -> [u8; 32] {
    sha256_3(b"snarkv2-a-v1", pk_hash, public_inputs_hash)
}

/// pi_b = SHA256("snarkv2-b-v1" || pk_hash || pi_a)
fn compute_pi_b(pk_hash: &[u8; 32], pi_a: &[u8; 32]) -> [u8; 32] {
    sha256_3(b"snarkv2-b-v1", pk_hash, pi_a)
}

/// pi_c = SHA256("snarkv2-c-v1" || pk_hash || pi_a || pi_b)
fn compute_pi_c(pk_hash: &[u8; 32], pi_a: &[u8; 32], pi_b: &[u8; 32]) -> [u8; 32] {
    sha256_4(b"snarkv2-c-v1", pk_hash, pi_a, pi_b)
}

/// proof_id = SHA256("snarkv2-id-v1" || pi_a || pi_b || pi_c || vk_hash)
fn compute_proof_id(
    pi_a: &[u8; 32],
    pi_b: &[u8; 32],
    pi_c: &[u8; 32],
    vk_hash: &[u8; 32],
) -> [u8; 32] {
    sha256_5(b"snarkv2-id-v1", pi_a, pi_b, pi_c, vk_hash)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Create a SNARK v2 proof stub.
///
/// Errors: ZeroProvingKey, ZeroVerifyingKey, EmptyInputs
pub fn create_snark_v2(
    proving_key: &[u8; 32],
    verifying_key: &[u8; 32],
    public_inputs: &[&[u8]],
) -> Result<SnarkV2Proof, SnarkError> {
    if *proving_key == [0u8; 32] {
        return Err(SnarkError::ZeroProvingKey);
    }
    if *verifying_key == [0u8; 32] {
        return Err(SnarkError::ZeroVerifyingKey);
    }
    if public_inputs.is_empty() {
        return Err(SnarkError::EmptyInputs);
    }

    let pk_hash = compute_pk_hash(proving_key);
    let vk_hash = compute_vk_hash(verifying_key);
    let public_inputs_hash = compute_public_inputs_hash(public_inputs);
    let pi_a = compute_pi_a(&pk_hash, &public_inputs_hash);
    let pi_b = compute_pi_b(&pk_hash, &pi_a);
    let pi_c = compute_pi_c(&pk_hash, &pi_a, &pi_b);
    let proof_id = compute_proof_id(&pi_a, &pi_b, &pi_c, &vk_hash);

    Ok(SnarkV2Proof {
        proof_id,
        pi_a,
        pi_b,
        pi_c,
        public_inputs_hash,
        vk_hash,
        is_stub: true,
        mainnet_ready: false,
    })
}

/// Verify a SNARK v2 proof by recomputing public_inputs_hash and vk_hash.
pub fn verify_snark_v2(
    proof: &SnarkV2Proof,
    verifying_key: &[u8; 32],
    public_inputs: &[&[u8]],
) -> bool {
    if public_inputs.is_empty() {
        return false;
    }
    let vk_hash = compute_vk_hash(verifying_key);
    let public_inputs_hash = compute_public_inputs_hash(public_inputs);
    vk_hash == proof.vk_hash && public_inputs_hash == proof.public_inputs_hash
}

/// Public JSON record: proof_id, public_inputs_hash, vk_hash, is_stub, mainnet_ready.
pub fn snark_v2_public_record(proof: &SnarkV2Proof) -> String {
    let pid_hex: String = proof
        .proof_id
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    let pih_hex: String = proof
        .public_inputs_hash
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    let vkh_hex: String = proof.vk_hash.iter().map(|b| format!("{:02x}", b)).collect();
    serde_json::json!({
        "proof_id": pid_hex,
        "public_inputs_hash": pih_hex,
        "vk_hash": vkh_hex,
        "is_stub": proof.is_stub,
        "mainnet_ready": proof.mainnet_ready,
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn pk() -> [u8; 32] {
        let mut k = [0u8; 32];
        k[0] = 0xAA;
        k
    }

    fn vk() -> [u8; 32] {
        let mut k = [0u8; 32];
        k[0] = 0xBB;
        k
    }

    #[test]
    fn test_create_and_verify() {
        let inputs: &[&[u8]] = &[b"input-0", b"input-1"];
        let proof = create_snark_v2(&pk(), &vk(), inputs).unwrap();
        assert!(proof.is_stub);
        assert!(!proof.mainnet_ready);
        assert!(verify_snark_v2(&proof, &vk(), inputs));
    }

    #[test]
    fn test_deterministic() {
        let inputs: &[&[u8]] = &[b"foo", b"bar"];
        let p1 = create_snark_v2(&pk(), &vk(), inputs).unwrap();
        let p2 = create_snark_v2(&pk(), &vk(), inputs).unwrap();
        assert_eq!(p1.proof_id, p2.proof_id);
        assert_eq!(p1.pi_a, p2.pi_a);
        assert_eq!(p1.public_inputs_hash, p2.public_inputs_hash);
    }

    #[test]
    fn test_input_sensitivity() {
        let inputs_a: &[&[u8]] = &[b"foo"];
        let inputs_b: &[&[u8]] = &[b"bar"];
        let p1 = create_snark_v2(&pk(), &vk(), inputs_a).unwrap();
        let p2 = create_snark_v2(&pk(), &vk(), inputs_b).unwrap();
        assert_ne!(p1.proof_id, p2.proof_id);
        assert_ne!(p1.public_inputs_hash, p2.public_inputs_hash);
    }

    #[test]
    fn test_zero_proving_key_rejected() {
        let inputs: &[&[u8]] = &[b"x"];
        let err = create_snark_v2(&[0u8; 32], &vk(), inputs).unwrap_err();
        assert_eq!(err, SnarkError::ZeroProvingKey);
    }

    #[test]
    fn test_empty_inputs_rejected() {
        let err = create_snark_v2(&pk(), &vk(), &[]).unwrap_err();
        assert_eq!(err, SnarkError::EmptyInputs);
    }

    #[test]
    fn test_is_stub_true_and_mainnet_ready_false() {
        let inputs: &[&[u8]] = &[b"check"];
        let proof = create_snark_v2(&pk(), &vk(), inputs).unwrap();
        assert!(proof.is_stub);
        assert!(!proof.mainnet_ready);

        let record = snark_v2_public_record(&proof);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert_eq!(v["is_stub"], true);
        assert_eq!(v["mainnet_ready"], false);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_zero_verifying_key_rejected() {
        let inputs: &[&[u8]] = &[b"x"];
        let err = create_snark_v2(&pk(), &[0u8; 32], inputs).unwrap_err();
        assert_eq!(err, SnarkError::ZeroVerifyingKey);
    }

    #[test]
    fn test_proof_id_nonzero() {
        let inputs: &[&[u8]] = &[b"data"];
        let proof = create_snark_v2(&pk(), &vk(), inputs).unwrap();
        assert_ne!(proof.proof_id, [0u8; 32]);
    }

    #[test]
    fn test_pi_a_nonzero() {
        let inputs: &[&[u8]] = &[b"alpha"];
        let proof = create_snark_v2(&pk(), &vk(), inputs).unwrap();
        assert_ne!(proof.pi_a, [0u8; 32]);
    }

    #[test]
    fn test_vk_sensitivity() {
        let inputs: &[&[u8]] = &[b"same"];
        let vk2 = {
            let mut k = [0u8; 32];
            k[0] = 0xCC;
            k
        };
        let p1 = create_snark_v2(&pk(), &vk(), inputs).unwrap();
        let p2 = create_snark_v2(&pk(), &vk2, inputs).unwrap();
        assert_ne!(p1.vk_hash, p2.vk_hash);
    }

    #[test]
    fn test_pk_sensitivity() {
        let inputs: &[&[u8]] = &[b"same"];
        let pk2 = {
            let mut k = [0u8; 32];
            k[0] = 0xDD;
            k
        };
        let p1 = create_snark_v2(&pk(), &vk(), inputs).unwrap();
        let p2 = create_snark_v2(&pk2, &vk(), inputs).unwrap();
        assert_ne!(p1.pi_a, p2.pi_a);
    }

    #[test]
    fn test_verify_wrong_vk_fails() {
        let inputs: &[&[u8]] = &[b"verify-me"];
        let proof = create_snark_v2(&pk(), &vk(), inputs).unwrap();
        let wrong_vk = {
            let mut k = [0u8; 32];
            k[0] = 0xEE;
            k
        };
        assert!(!verify_snark_v2(&proof, &wrong_vk, inputs));
    }

    #[test]
    fn test_verify_wrong_inputs_fails() {
        let inputs: &[&[u8]] = &[b"correct"];
        let proof = create_snark_v2(&pk(), &vk(), inputs).unwrap();
        let wrong: &[&[u8]] = &[b"wrong"];
        assert!(!verify_snark_v2(&proof, &vk(), wrong));
    }

    #[test]
    fn test_public_record_fields() {
        let inputs: &[&[u8]] = &[b"rec"];
        let proof = create_snark_v2(&pk(), &vk(), inputs).unwrap();
        let record = snark_v2_public_record(&proof);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["proof_id"].is_string());
        assert_eq!(v["mainnet_ready"], false);
    }

    #[test]
    fn test_multiple_inputs() {
        let inputs: &[&[u8]] = &[b"a", b"b", b"c"];
        let proof = create_snark_v2(&pk(), &vk(), inputs).unwrap();
        assert!(verify_snark_v2(&proof, &vk(), inputs));
    }

    #[test]
    fn test_is_stub_always_true() {
        let inputs: &[&[u8]] = &[b"stub"];
        let proof = create_snark_v2(&pk(), &vk(), inputs).unwrap();
        assert!(proof.is_stub);
    }
}
