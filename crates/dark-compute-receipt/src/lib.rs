// dark-compute-receipt — compute job receipt anchored to the receipt DAG
// WASM module hash + input commitment + output commitment + CU estimate.
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false

use dark_wasm_compute::{ComputeProof, WasmExecutionResult, WasmJobSpec};
use sha2::{Digest, Sha256};

/// An immutable, publicly-verifiable receipt for a completed WASM compute job.
/// Contains only hash fields — no raw inputs, outputs, or owner data.
#[derive(Debug, Clone)]
pub struct ComputeReceipt {
    pub receipt_hash: [u8; 32],
    pub job_id: [u8; 32],
    pub wasm_module_hash: [u8; 32],
    pub input_commitment: [u8; 32],
    pub output_commitment: [u8; 32],
    pub instructions_used: u64,
    pub compute_proof_hash: [u8; 32],
    pub epoch: u64,
    pub mainnet_ready: bool, // always false
}

/// A node in the receipt DAG that links a receipt to its predecessor.
#[derive(Debug, Clone)]
pub struct ReceiptChainNode {
    pub receipt_hash: [u8; 32],
    pub previous_hash: [u8; 32], // links to previous receipt in DAG
    pub chain_root: [u8; 32],    // SHA256("chain-root-v1" || receipt_hash || previous_hash)
}

// ---------------------------------------------------------------------------
// receipt_hash derivation
//
//   SHA256("compute-receipt-v1"
//       || job_id
//       || wasm_module_hash
//       || input_commitment
//       || output_commitment
//       || instructions_used_le
//       || compute_proof_hash
//       || epoch_le)
// ---------------------------------------------------------------------------

fn compute_receipt_hash(
    job_id: &[u8; 32],
    wasm_module_hash: &[u8; 32],
    input_commitment: &[u8; 32],
    output_commitment: &[u8; 32],
    instructions_used: u64,
    compute_proof_hash: &[u8; 32],
    epoch: u64,
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"compute-receipt-v1");
    h.update(job_id);
    h.update(wasm_module_hash);
    h.update(input_commitment);
    h.update(output_commitment);
    h.update(instructions_used.to_le_bytes());
    h.update(compute_proof_hash);
    h.update(epoch.to_le_bytes());
    h.finalize().into()
}

/// Build a ComputeReceipt from a proof + spec + result + epoch.
pub fn build_compute_receipt(
    proof: &ComputeProof,
    spec: &WasmJobSpec,
    result: &WasmExecutionResult,
    epoch: u64,
) -> ComputeReceipt {
    let receipt_hash = compute_receipt_hash(
        &spec.job_id,
        &spec.wasm_module_hash,
        &spec.input_commitment,
        &result.output_commitment,
        result.instructions_used,
        &proof.proof_hash,
        epoch,
    );

    ComputeReceipt {
        receipt_hash,
        job_id: spec.job_id,
        wasm_module_hash: spec.wasm_module_hash,
        input_commitment: spec.input_commitment,
        output_commitment: result.output_commitment,
        instructions_used: result.instructions_used,
        compute_proof_hash: proof.proof_hash,
        epoch,
        mainnet_ready: false,
    }
}

/// Verify a receipt by recomputing receipt_hash from its fields.
pub fn verify_compute_receipt(receipt: &ComputeReceipt) -> bool {
    let expected = compute_receipt_hash(
        &receipt.job_id,
        &receipt.wasm_module_hash,
        &receipt.input_commitment,
        &receipt.output_commitment,
        receipt.instructions_used,
        &receipt.compute_proof_hash,
        receipt.epoch,
    );
    expected == receipt.receipt_hash
}

/// Link a receipt to the DAG via a previous_hash pointer.
/// chain_root = SHA256("chain-root-v1" || receipt_hash || previous_hash)
pub fn chain_receipt(receipt: &ComputeReceipt, previous_hash: &[u8; 32]) -> ReceiptChainNode {
    let mut h = Sha256::new();
    h.update(b"chain-root-v1");
    h.update(receipt.receipt_hash);
    h.update(previous_hash);
    let chain_root: [u8; 32] = h.finalize().into();

    ReceiptChainNode {
        receipt_hash: receipt.receipt_hash,
        previous_hash: *previous_hash,
        chain_root,
    }
}

/// Produce a public JSON view of a receipt — hashes only, no raw data.
pub fn receipt_to_public_json(receipt: &ComputeReceipt) -> serde_json::Value {
    serde_json::json!({
        "receipt_hash":       hex(receipt.receipt_hash),
        "job_id":             hex(receipt.job_id),
        "wasm_module_hash":   hex(receipt.wasm_module_hash),
        "input_commitment":   hex(receipt.input_commitment),
        "output_commitment":  hex(receipt.output_commitment),
        "instructions_used":  receipt.instructions_used,
        "compute_proof_hash": hex(receipt.compute_proof_hash),
        "epoch":              receipt.epoch,
        "mainnet_ready":      receipt.mainnet_ready,
    })
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn hex(bytes: [u8; 32]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use dark_wasm_compute::{build_compute_proof, create_job_spec, simulate_execution};

    fn make_receipt() -> (
        ComputeReceipt,
        ComputeProof,
        WasmJobSpec,
        WasmExecutionResult,
    ) {
        let spec = create_job_spec(
            b"wasm binary bytes",
            b"input payload",
            b"owner-pubkey",
            8000,
            &[0xABu8; 32],
        );
        let result = simulate_execution(&spec).unwrap();
        let proof = build_compute_proof(&spec, &result).unwrap();
        let receipt = build_compute_receipt(&proof, &spec, &result, 42);
        (receipt, proof, spec, result)
    }

    #[test]
    fn test_receipt_hash_deterministic() {
        let (r1, proof, spec, result) = make_receipt();
        let r2 = build_compute_receipt(&proof, &spec, &result, 42);
        assert_eq!(r1.receipt_hash, r2.receipt_hash);
    }

    #[test]
    fn test_receipt_mainnet_ready_false() {
        let (receipt, _, _, _) = make_receipt();
        assert!(!receipt.mainnet_ready);
    }

    #[test]
    fn test_verify_receipt_roundtrip() {
        let (receipt, _, _, _) = make_receipt();
        assert!(verify_compute_receipt(&receipt));
    }

    #[test]
    fn test_chain_node_links_correctly() {
        let (receipt, _, _, _) = make_receipt();
        let prev = [0x11u8; 32];
        let node = chain_receipt(&receipt, &prev);

        assert_eq!(node.receipt_hash, receipt.receipt_hash);
        assert_eq!(node.previous_hash, prev);

        // Verify chain_root by recomputing
        let mut h = sha2::Sha256::new();
        h.update(b"chain-root-v1");
        h.update(receipt.receipt_hash);
        h.update(prev);
        let expected_root: [u8; 32] = sha2::Digest::finalize(h).into();
        assert_eq!(node.chain_root, expected_root);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_receipt_hash_nonzero() {
        let (receipt, _, _, _) = make_receipt();
        assert_ne!(receipt.receipt_hash, [0u8; 32]);
    }

    #[test]
    fn test_receipt_hash_epoch_sensitive() {
        let (_, proof, spec, result) = make_receipt();
        let r1 = build_compute_receipt(&proof, &spec, &result, 42);
        let r2 = build_compute_receipt(&proof, &spec, &result, 99);
        assert_ne!(r1.receipt_hash, r2.receipt_hash);
    }

    #[test]
    fn test_verify_tampered_receipt_fails() {
        let (mut receipt, _, _, _) = make_receipt();
        receipt.epoch = 9999;
        assert!(!verify_compute_receipt(&receipt));
    }

    #[test]
    fn test_chain_root_nonzero() {
        let (receipt, _, _, _) = make_receipt();
        let node = chain_receipt(&receipt, &[0x11u8; 32]);
        assert_ne!(node.chain_root, [0u8; 32]);
    }

    #[test]
    fn test_chain_root_prev_sensitive() {
        let (receipt, _, _, _) = make_receipt();
        let node1 = chain_receipt(&receipt, &[0x11u8; 32]);
        let node2 = chain_receipt(&receipt, &[0x22u8; 32]);
        assert_ne!(node1.chain_root, node2.chain_root);
    }

    #[test]
    fn test_receipt_to_public_json_mainnet_ready_false() {
        let (receipt, _, _, _) = make_receipt();
        let json = receipt_to_public_json(&receipt);
        assert_eq!(json["mainnet_ready"], false);
    }

    #[test]
    fn test_receipt_to_public_json_has_epoch() {
        let (receipt, _, _, _) = make_receipt();
        let json = receipt_to_public_json(&receipt);
        assert!(json["epoch"].is_number());
        assert_eq!(json["epoch"], 42u64);
    }

    #[test]
    fn test_epoch_stored() {
        let (_, proof, spec, result) = make_receipt();
        let r = build_compute_receipt(&proof, &spec, &result, 77);
        assert_eq!(r.epoch, 77);
    }

    #[test]
    fn test_job_id_stored() {
        let (receipt, _, spec, _) = make_receipt();
        assert_eq!(receipt.job_id, spec.job_id);
    }

    #[test]
    fn test_instructions_used_stored() {
        let (receipt, _, _, result) = make_receipt();
        assert_eq!(receipt.instructions_used, result.instructions_used);
    }

    #[test]
    fn test_different_epochs_different_receipt_hash() {
        let (_, proof, spec, result) = make_receipt();
        let r1 = build_compute_receipt(&proof, &spec, &result, 1);
        let r2 = build_compute_receipt(&proof, &spec, &result, 2);
        assert_ne!(r1.receipt_hash, r2.receipt_hash);
    }

    #[test]
    fn test_chain_different_prev_different_root() {
        let (receipt, _, _, _) = make_receipt();
        let n1 = chain_receipt(&receipt, &[0xAAu8; 32]);
        let n2 = chain_receipt(&receipt, &[0xBBu8; 32]);
        assert_ne!(n1.chain_root, n2.chain_root);
    }
}
