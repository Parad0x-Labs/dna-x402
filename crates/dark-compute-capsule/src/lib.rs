// dark-compute-capsule — capability-gated WASM execution
// Agent must hold a valid SwarmCapsule-equivalent credential to submit a compute job.
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false

use sha2::{Digest, Sha256};

/// A capability credential authorising an agent to submit WASM compute jobs.
/// quota is enforced at submission time; expiry is enforced against the current slot.
#[derive(Debug, Clone)]
pub struct ComputeCredential {
    pub credential_hash: [u8; 32], // SHA256("compute-cred-v1" || owner_hash || scope_hash || nonce)
    pub owner_hash: [u8; 32],
    pub scope_hash: [u8; 32], // what WASM modules this credential covers
    pub expiry_slot: u64,
    pub max_jobs: u32,
    pub jobs_used: u32,
}

/// A job submission gated by a ComputeCredential.
/// result and receipt are populated by finalize_job after execution.
#[derive(Debug, Clone)]
pub struct GatedJobSubmission {
    pub job_spec: dark_wasm_compute::WasmJobSpec,
    pub credential_hash: [u8; 32],
    pub submission_slot: u64,
    pub result: Option<dark_wasm_compute::WasmExecutionResult>,
    pub receipt: Option<dark_compute_receipt::ComputeReceipt>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CapsuleGateError {
    CredentialExpired,
    JobQuotaExhausted,
    ScopeMismatch,
    MissingResult,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Build a ComputeCredential for an owner + scope combination.
/// credential_hash = SHA256("compute-cred-v1" || owner_hash || scope_hash || nonce)
pub fn create_compute_credential(
    owner: &[u8],
    scope: &[u8],
    expiry_slot: u64,
    max_jobs: u32,
    nonce: &[u8; 32],
) -> ComputeCredential {
    let owner_hash: [u8; 32] = Sha256::digest(owner).into();
    let scope_hash: [u8; 32] = Sha256::digest(scope).into();

    let mut h = Sha256::new();
    h.update(b"compute-cred-v1");
    h.update(owner_hash);
    h.update(scope_hash);
    h.update(nonce);
    let credential_hash: [u8; 32] = h.finalize().into();

    ComputeCredential {
        credential_hash,
        owner_hash,
        scope_hash,
        expiry_slot,
        max_jobs,
        jobs_used: 0,
    }
}

/// Gate a job submission behind a credential.
///
/// Checks (in order):
///   1. slot <= credential.expiry_slot  — else CredentialExpired
///   2. credential.jobs_used < credential.max_jobs — else JobQuotaExhausted
///
/// On success, increments jobs_used and returns a GatedJobSubmission.
pub fn submit_gated_job(
    cred: &mut ComputeCredential,
    spec: dark_wasm_compute::WasmJobSpec,
    slot: u64,
) -> Result<GatedJobSubmission, CapsuleGateError> {
    if slot > cred.expiry_slot {
        return Err(CapsuleGateError::CredentialExpired);
    }
    if cred.jobs_used >= cred.max_jobs {
        return Err(CapsuleGateError::JobQuotaExhausted);
    }

    cred.jobs_used += 1;

    Ok(GatedJobSubmission {
        credential_hash: cred.credential_hash,
        submission_slot: slot,
        job_spec: spec,
        result: None,
        receipt: None,
    })
}

/// Attach a result and receipt to a pending submission (called after execution).
pub fn finalize_job(
    submission: &mut GatedJobSubmission,
    result: dark_wasm_compute::WasmExecutionResult,
    receipt: dark_compute_receipt::ComputeReceipt,
) {
    submission.result = Some(result);
    submission.receipt = Some(receipt);
}

/// Build a full evidence JSON for a submission — all hashes, no raw data.
pub fn submission_evidence_json(submission: &GatedJobSubmission) -> serde_json::Value {
    let spec = &submission.job_spec;

    let result_obj = match &submission.result {
        Some(r) => serde_json::json!({
            "output_commitment":  hex(r.output_commitment),
            "output_hash":        hex(r.output_hash),
            "instructions_used":  r.instructions_used,
            "succeeded":          r.succeeded,
            "job_id":             hex(r.job_id),
        }),
        None => serde_json::Value::Null,
    };

    let receipt_obj = match &submission.receipt {
        Some(r) => serde_json::json!({
            "receipt_hash":       hex(r.receipt_hash),
            "compute_proof_hash": hex(r.compute_proof_hash),
            "epoch":              r.epoch,
            "mainnet_ready":      r.mainnet_ready,
        }),
        None => serde_json::Value::Null,
    };

    serde_json::json!({
        "job_id":           hex(spec.job_id),
        "wasm_module_hash": hex(spec.wasm_module_hash),
        "input_commitment": hex(spec.input_commitment),
        "credential_hash":  hex(submission.credential_hash),
        "submission_slot":  submission.submission_slot,
        "result":           result_obj,
        "receipt":          receipt_obj,
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
    use dark_compute_receipt::{build_compute_receipt, verify_compute_receipt};
    use dark_wasm_compute::{build_compute_proof, create_job_spec, simulate_execution};

    fn make_cred(max_jobs: u32, expiry_slot: u64) -> ComputeCredential {
        create_compute_credential(
            b"agent-owner",
            b"wasm-scope-all",
            expiry_slot,
            max_jobs,
            &[0x77u8; 32],
        )
    }

    fn make_spec() -> dark_wasm_compute::WasmJobSpec {
        create_job_spec(
            b"wasm binary",
            b"input data",
            b"agent-owner",
            9999,
            &[0x55u8; 32],
        )
    }

    #[test]
    fn test_gated_job_happy_path() {
        let mut cred = make_cred(5, 1000);
        assert_eq!(cred.jobs_used, 0);

        let spec = make_spec();
        let submission = submit_gated_job(&mut cred, spec, 500).unwrap();

        assert_eq!(cred.jobs_used, 1);
        assert_eq!(submission.submission_slot, 500);
        assert_eq!(submission.credential_hash, cred.credential_hash);
        assert!(submission.result.is_none());
        assert!(submission.receipt.is_none());
    }

    #[test]
    fn test_expired_credential_rejected() {
        let mut cred = make_cred(10, 100); // expires at slot 100
        let spec = make_spec();
        let err = submit_gated_job(&mut cred, spec, 101).unwrap_err(); // slot 101 > 100
        assert_eq!(err, CapsuleGateError::CredentialExpired);
        // quota must NOT have been decremented
        assert_eq!(cred.jobs_used, 0);
    }

    #[test]
    fn test_quota_exhausted_rejected() {
        let mut cred = make_cred(2, 9999); // only 2 jobs allowed

        let submit = |cred: &mut ComputeCredential| {
            submit_gated_job(cred, make_spec(), 1)
        };

        submit(&mut cred).unwrap(); // job 1
        submit(&mut cred).unwrap(); // job 2
        assert_eq!(cred.jobs_used, 2);

        let err = submit(&mut cred).unwrap_err(); // job 3 — should fail
        assert_eq!(err, CapsuleGateError::JobQuotaExhausted);
        assert_eq!(cred.jobs_used, 2); // unchanged
    }

    #[test]
    fn test_finalize_adds_receipt() {
        let mut cred = make_cred(5, 9999);
        let spec = make_spec();
        let mut submission = submit_gated_job(&mut cred, spec, 10).unwrap();

        assert!(submission.result.is_none());
        assert!(submission.receipt.is_none());

        // Execute + build proof + receipt
        let result = simulate_execution(&submission.job_spec).unwrap();
        let proof = build_compute_proof(&submission.job_spec, &result).unwrap();
        let receipt = build_compute_receipt(&proof, &submission.job_spec, &result, 7);

        assert!(verify_compute_receipt(&receipt));

        finalize_job(&mut submission, result.clone(), receipt.clone());

        assert!(submission.result.is_some());
        assert!(submission.receipt.is_some());

        let r = submission.result.as_ref().unwrap();
        assert_eq!(r.output_commitment, result.output_commitment);

        let rec = submission.receipt.as_ref().unwrap();
        assert_eq!(rec.receipt_hash, receipt.receipt_hash);
    }
}
