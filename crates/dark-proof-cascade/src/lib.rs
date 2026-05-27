use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_CASCADE_DEPTH: u32 = 32;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CascadeProof {
    pub proof_id: [u8; 32],
    pub depth: u32,
    pub root_input: [u8; 32],
    pub final_output: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CascadeLayer {
    pub layer_index: u32,
    pub input_hash: [u8; 32],
    pub output_hash: [u8; 32],
}

#[derive(Debug, Clone, PartialEq)]
pub enum CascadeError {
    ZeroInput,
    DepthZero,
    MaxDepthExceeded,
    VerificationFailed,
}

fn sha256_bytes(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().into()
}

fn compute_root_input(input_bytes: &[u8]) -> [u8; 32] {
    let mut data = b"cascade-root-v1".to_vec();
    data.extend_from_slice(input_bytes);
    sha256_bytes(&data)
}

fn compute_layer_output(layer_index: u32, input_hash: &[u8; 32]) -> [u8; 32] {
    let mut data = b"cascade-layer-v1".to_vec();
    data.extend_from_slice(&layer_index.to_le_bytes());
    data.extend_from_slice(input_hash);
    sha256_bytes(&data)
}

fn compute_proof_id(root_input: &[u8; 32], final_output: &[u8; 32], depth: u32) -> [u8; 32] {
    let mut data = b"cascade-proof-v1".to_vec();
    data.extend_from_slice(root_input);
    data.extend_from_slice(final_output);
    data.extend_from_slice(&depth.to_le_bytes());
    sha256_bytes(&data)
}

pub fn create_cascade(
    input_bytes: &[u8],
    depth: u32,
) -> Result<(CascadeProof, Vec<CascadeLayer>), CascadeError> {
    if input_bytes.is_empty() {
        return Err(CascadeError::ZeroInput);
    }
    if depth == 0 {
        return Err(CascadeError::DepthZero);
    }
    if depth > MAX_CASCADE_DEPTH {
        return Err(CascadeError::MaxDepthExceeded);
    }

    let root_input = compute_root_input(input_bytes);

    let mut layers = Vec::with_capacity(depth as usize);
    let mut current = root_input;

    for i in 0..depth {
        let input_hash = current;
        let output_hash = compute_layer_output(i, &input_hash);
        layers.push(CascadeLayer {
            layer_index: i,
            input_hash,
            output_hash,
        });
        current = output_hash;
    }

    let final_output = current;
    let proof_id = compute_proof_id(&root_input, &final_output, depth);

    let proof = CascadeProof {
        proof_id,
        depth,
        root_input,
        final_output,
        mainnet_ready: false,
    };

    Ok((proof, layers))
}

pub fn verify_cascade(proof: &CascadeProof) -> bool {
    let mut current = proof.root_input;
    for i in 0..proof.depth {
        current = compute_layer_output(i, &current);
    }
    current == proof.final_output
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

pub fn cascade_public_record(proof: &CascadeProof) -> String {
    serde_json::json!({
        "proof_id": bytes_to_hex(&proof.proof_id),
        "depth": proof.depth,
        "root_input": bytes_to_hex(&proof.root_input),
        "final_output": bytes_to_hex(&proof.final_output),
        "mainnet_ready": proof.mainnet_ready,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cascade_create_verify() {
        let (proof, _layers) = create_cascade(b"hello world", 4).unwrap();
        assert!(verify_cascade(&proof));
        assert!(!proof.mainnet_ready);
    }

    #[test]
    fn test_cascade_deterministic() {
        let (proof1, _) = create_cascade(b"deterministic input", 5).unwrap();
        let (proof2, _) = create_cascade(b"deterministic input", 5).unwrap();
        assert_eq!(proof1.final_output, proof2.final_output);
    }

    #[test]
    fn test_depth_sensitivity() {
        let (proof3, _) = create_cascade(b"depth test", 3).unwrap();
        let (proof4, _) = create_cascade(b"depth test", 4).unwrap();
        assert_ne!(proof3.final_output, proof4.final_output);
    }

    #[test]
    fn test_input_sensitivity() {
        let (proof_a, _) = create_cascade(b"input alpha", 4).unwrap();
        let (proof_b, _) = create_cascade(b"input beta", 4).unwrap();
        assert_ne!(proof_a.final_output, proof_b.final_output);
    }

    #[test]
    fn test_depth_zero_rejected() {
        let result = create_cascade(b"some input", 0);
        assert_eq!(result.unwrap_err(), CascadeError::DepthZero);
    }

    #[test]
    fn test_max_depth_exceeded_rejected() {
        let result_over = create_cascade(b"some input", 33);
        assert_eq!(result_over.unwrap_err(), CascadeError::MaxDepthExceeded);

        let result_at_max = create_cascade(b"some input", 32);
        assert!(result_at_max.is_ok());
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_proof_id_nonzero() {
        let (proof, _) = create_cascade(b"nonzero_test", 3).unwrap();
        assert_ne!(proof.proof_id, [0u8; 32]);
    }

    #[test]
    fn test_root_input_nonzero() {
        let (proof, _) = create_cascade(b"root_test", 2).unwrap();
        assert_ne!(proof.root_input, [0u8; 32]);
    }

    #[test]
    fn test_final_output_nonzero() {
        let (proof, _) = create_cascade(b"output_test", 2).unwrap();
        assert_ne!(proof.final_output, [0u8; 32]);
    }

    #[test]
    fn test_mainnet_ready_false() {
        let (proof, _) = create_cascade(b"mainnet_test", 1).unwrap();
        assert!(!proof.mainnet_ready);
    }

    #[test]
    fn test_verify_cascade_true() {
        let (proof, _) = create_cascade(b"verify_test", 5).unwrap();
        assert!(verify_cascade(&proof));
    }

    #[test]
    fn test_layer_count_matches_depth() {
        let (_, layers) = create_cascade(b"layer_count", 7).unwrap();
        assert_eq!(layers.len(), 7);
    }

    #[test]
    fn test_layer_inputs_chain_correctly() {
        let (_, layers) = create_cascade(b"chain_test", 4).unwrap();
        for i in 1..layers.len() {
            assert_eq!(layers[i].input_hash, layers[i - 1].output_hash);
        }
    }

    #[test]
    fn test_cascade_public_record_fields() {
        let (proof, _) = create_cascade(b"record_test", 3).unwrap();
        let record = cascade_public_record(&proof);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["proof_id"].is_string());
        assert_eq!(v["depth"], 3u64);
        assert_eq!(v["mainnet_ready"], false);
    }

    #[test]
    fn test_max_depth_ok() {
        let result = create_cascade(b"max_depth", MAX_CASCADE_DEPTH);
        assert!(result.is_ok());
        let (proof, layers) = result.unwrap();
        assert_eq!(layers.len(), MAX_CASCADE_DEPTH as usize);
        assert!(verify_cascade(&proof));
    }

    #[test]
    fn test_empty_input_rejected() {
        let result = create_cascade(b"", 3);
        assert_eq!(result.unwrap_err(), CascadeError::ZeroInput);
    }
}
