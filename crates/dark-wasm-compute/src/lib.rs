// dark-wasm-compute — private WASM compute job with Poseidon-committed inputs/outputs
// Input committed before execution. Output commitment is the public proof of result.
// No validators required — local execution, public receipt.
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false

use sha2::{Digest, Sha256};

/// Specification for a private WASM compute job.
/// The raw input and owner are never stored — only their commitments.
#[derive(Debug, Clone)]
pub struct WasmJobSpec {
    pub wasm_module_hash: [u8; 32], // SHA256 of the WASM binary
    pub input_commitment: [u8; 32], // commitment to encrypted input
    pub owner_hash: [u8; 32],       // SHA256 of job owner — never raw
    pub max_instructions: u64,      // compute budget
    pub job_id: [u8; 32],
}

/// Result of executing (or simulating) a WASM compute job.
#[derive(Debug, Clone)]
pub struct WasmExecutionResult {
    pub output_commitment: [u8; 32], // commitment to output bytes
    pub output_hash: [u8; 32],       // SHA256(output_bytes) — verifiable without revealing output
    pub instructions_used: u64,
    pub succeeded: bool,
    pub job_id: [u8; 32],
}

/// Public proof that a WASM job ran with a given spec and produced a given result.
/// Contains only hashes — no raw inputs, outputs, or owner data.
#[derive(Debug, Clone)]
pub struct ComputeProof {
    pub job_spec_hash: [u8; 32], // SHA256 of entire WasmJobSpec
    pub result_hash: [u8; 32],   // SHA256 of entire WasmExecutionResult
    pub proof_hash: [u8; 32],    // SHA256("wasm-compute-proof-v1" || job_spec_hash || result_hash)
    pub mainnet_ready: bool,     // always false
}

#[derive(Debug, Clone, PartialEq)]
pub enum ComputeError {
    BudgetExceeded,
    InvalidJobSpec,
    OutputCommitmentMismatch,
    JobIdMismatch,
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/// Commit to input bytes with a nonce.
/// commit_input = SHA256("wasm-input-commit-v1" || SHA256(input_bytes) || nonce)
pub fn commit_input(input_bytes: &[u8], nonce: &[u8; 32]) -> [u8; 32] {
    let input_hash: [u8; 32] = Sha256::digest(input_bytes).into();
    let mut h = Sha256::new();
    h.update(b"wasm-input-commit-v1");
    h.update(input_hash);
    h.update(nonce);
    h.finalize().into()
}

/// Build a WasmJobSpec from raw materials.
/// The job_id is derived deterministically so the same inputs always yield the same spec.
pub fn create_job_spec(
    wasm_bytes: &[u8],
    input_bytes: &[u8],
    owner: &[u8],
    max_instructions: u64,
    nonce: &[u8; 32],
) -> WasmJobSpec {
    let wasm_module_hash: [u8; 32] = Sha256::digest(wasm_bytes).into();
    let input_commitment = commit_input(input_bytes, nonce);
    let owner_hash: [u8; 32] = Sha256::digest(owner).into();

    // job_id = SHA256("wasm-job-id-v1" || wasm_module_hash || input_commitment || owner_hash || max_instructions_le || nonce)
    let mut h = Sha256::new();
    h.update(b"wasm-job-id-v1");
    h.update(wasm_module_hash);
    h.update(input_commitment);
    h.update(owner_hash);
    h.update(max_instructions.to_le_bytes());
    h.update(nonce);
    let job_id: [u8; 32] = h.finalize().into();

    WasmJobSpec {
        wasm_module_hash,
        input_commitment,
        owner_hash,
        max_instructions,
        job_id,
    }
}

/// Deterministic mock execution (real wasmtime in production).
///
/// instructions_used = min(max_instructions, (wasm_module_hash[0] as u64) + 1000)
/// output_hash       = SHA256("wasm-output-v1" || wasm_module_hash || input_commitment || instructions_used_le)
/// output_commitment = SHA256("wasm-output-commit-v1" || output_hash)
pub fn simulate_execution(spec: &WasmJobSpec) -> Result<WasmExecutionResult, ComputeError> {
    if spec.max_instructions == 0 {
        return Err(ComputeError::InvalidJobSpec);
    }

    let raw_instructions = spec.wasm_module_hash[0] as u64 + 1000;
    let instructions_used = raw_instructions.min(spec.max_instructions);

    // output_hash
    let mut h = Sha256::new();
    h.update(b"wasm-output-v1");
    h.update(spec.wasm_module_hash);
    h.update(spec.input_commitment);
    h.update(instructions_used.to_le_bytes());
    let output_hash: [u8; 32] = h.finalize().into();

    // output_commitment = SHA256("wasm-output-commit-v1" || output_hash)
    let mut h2 = Sha256::new();
    h2.update(b"wasm-output-commit-v1");
    h2.update(output_hash);
    let output_commitment: [u8; 32] = h2.finalize().into();

    Ok(WasmExecutionResult {
        output_commitment,
        output_hash,
        instructions_used,
        succeeded: true,
        job_id: spec.job_id,
    })
}

/// Hash a WasmJobSpec to a single 32-byte digest.
fn hash_job_spec(spec: &WasmJobSpec) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"wasm-job-spec-v1");
    h.update(spec.wasm_module_hash);
    h.update(spec.input_commitment);
    h.update(spec.owner_hash);
    h.update(spec.max_instructions.to_le_bytes());
    h.update(spec.job_id);
    h.finalize().into()
}

/// Hash a WasmExecutionResult to a single 32-byte digest.
fn hash_execution_result(result: &WasmExecutionResult) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"wasm-exec-result-v1");
    h.update(result.output_commitment);
    h.update(result.output_hash);
    h.update(result.instructions_used.to_le_bytes());
    h.update([result.succeeded as u8]);
    h.update(result.job_id);
    h.finalize().into()
}

/// Build a ComputeProof from a spec + result pair.
/// Returns JobIdMismatch if spec.job_id != result.job_id.
pub fn build_compute_proof(
    spec: &WasmJobSpec,
    result: &WasmExecutionResult,
) -> Result<ComputeProof, ComputeError> {
    if spec.job_id != result.job_id {
        return Err(ComputeError::JobIdMismatch);
    }

    let job_spec_hash = hash_job_spec(spec);
    let result_hash = hash_execution_result(result);

    // proof_hash = SHA256("wasm-compute-proof-v1" || job_spec_hash || result_hash)
    let mut h = Sha256::new();
    h.update(b"wasm-compute-proof-v1");
    h.update(job_spec_hash);
    h.update(result_hash);
    let proof_hash: [u8; 32] = h.finalize().into();

    Ok(ComputeProof {
        job_spec_hash,
        result_hash,
        proof_hash,
        mainnet_ready: false,
    })
}

/// Verify a ComputeProof by recomputing from spec + result.
/// Returns false on any mismatch (including job_id mismatch or hash mismatch).
pub fn verify_compute_proof(
    spec: &WasmJobSpec,
    result: &WasmExecutionResult,
    proof: &ComputeProof,
) -> bool {
    if spec.job_id != result.job_id {
        return false;
    }

    let expected_job_spec_hash = hash_job_spec(spec);
    let expected_result_hash = hash_execution_result(result);

    if expected_job_spec_hash != proof.job_spec_hash {
        return false;
    }
    if expected_result_hash != proof.result_hash {
        return false;
    }

    // Recompute proof_hash
    let mut h = Sha256::new();
    h.update(b"wasm-compute-proof-v1");
    h.update(proof.job_spec_hash);
    h.update(proof.result_hash);
    let expected_proof_hash: [u8; 32] = h.finalize().into();

    expected_proof_hash == proof.proof_hash
}

/// Build a public evidence JSON for a job.  Raw owner, input, and output bytes are
/// never included — only hashes that are already public in the proof.
pub fn job_evidence_json(spec: &WasmJobSpec, proof: &ComputeProof) -> serde_json::Value {
    serde_json::json!({
        "job_id":            hex(spec.job_id),
        "wasm_module_hash":  hex(spec.wasm_module_hash),
        "input_commitment":  hex(spec.input_commitment),
        "max_instructions":  spec.max_instructions,
        "job_spec_hash":     hex(proof.job_spec_hash),
        "result_hash":       hex(proof.result_hash),
        "proof_hash":        hex(proof.proof_hash),
        "mainnet_ready":     proof.mainnet_ready,
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

    fn make_spec() -> WasmJobSpec {
        let wasm = b"fake wasm binary for testing";
        let input = b"secret input data";
        let owner = b"agent-owner-pubkey";
        let nonce = [0x42u8; 32];
        create_job_spec(wasm, input, owner, 5000, &nonce)
    }

    #[test]
    fn test_compute_proof_mainnet_ready_false() {
        let spec = make_spec();
        let result = simulate_execution(&spec).unwrap();
        let proof = build_compute_proof(&spec, &result).unwrap();
        assert!(!proof.mainnet_ready);
    }

    #[test]
    fn test_simulate_execution_deterministic() {
        let spec = make_spec();
        let r1 = simulate_execution(&spec).unwrap();
        let r2 = simulate_execution(&spec).unwrap();
        assert_eq!(r1.output_commitment, r2.output_commitment);
        assert_eq!(r1.output_hash, r2.output_hash);
        assert_eq!(r1.instructions_used, r2.instructions_used);
    }

    #[test]
    fn test_compute_proof_verifies() {
        let spec = make_spec();
        let result = simulate_execution(&spec).unwrap();
        let proof = build_compute_proof(&spec, &result).unwrap();
        assert!(verify_compute_proof(&spec, &result, &proof));
    }

    #[test]
    fn test_tampered_result_fails_verify() {
        let spec = make_spec();
        let result = simulate_execution(&spec).unwrap();
        let proof = build_compute_proof(&spec, &result).unwrap();

        let mut tampered = result.clone();
        tampered.output_commitment[0] ^= 0xFF;

        assert!(!verify_compute_proof(&spec, &tampered, &proof));
    }

    #[test]
    fn test_input_commitment_nonce_dependent() {
        let input = b"same input bytes";
        let nonce_a = [0x01u8; 32];
        let nonce_b = [0x02u8; 32];
        let c_a = commit_input(input, &nonce_a);
        let c_b = commit_input(input, &nonce_b);
        assert_ne!(c_a, c_b);
    }

    #[test]
    fn test_owner_absent_from_evidence() {
        let owner_bytes = b"agent-owner-pubkey";
        let wasm = b"fake wasm binary for testing";
        let input = b"secret input data";
        let nonce = [0x42u8; 32];
        let spec = create_job_spec(wasm, input, owner_bytes, 5000, &nonce);
        let result = simulate_execution(&spec).unwrap();
        let proof = build_compute_proof(&spec, &result).unwrap();

        let evidence = job_evidence_json(&spec, &proof);
        let evidence_str = evidence.to_string();

        // The raw owner bytes must not appear in the serialised evidence
        let raw_owner_str = String::from_utf8_lossy(owner_bytes);
        assert!(
            !evidence_str.contains(raw_owner_str.as_ref()),
            "raw owner bytes found in evidence JSON"
        );
    }
}
