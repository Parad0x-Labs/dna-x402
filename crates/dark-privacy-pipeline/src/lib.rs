use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

/// A single step in the privacy pipeline.
/// step_id: 1=commit, 2=mix, 3=transfer, 4=nullify
#[derive(Debug, Clone, PartialEq)]
pub struct PipelineStep {
    pub step_id: u8,
    pub hash: [u8; 32],
    pub mainnet_ready: bool,
}

/// Full privacy pipeline: commit → mix → transfer → nullify.
/// pipeline_id = SHA256("pipeline-v1" || secret || nonce)
#[derive(Debug, Clone)]
pub struct PrivacyPipeline {
    pub pipeline_id: [u8; 32],
    pub steps: Vec<PipelineStep>,
    pub complete: bool,
    pub mainnet_ready: bool,
}

/// Errors produced by the pipeline API.
#[derive(Debug, PartialEq)]
pub enum PipelineError {
    SecretZero,
    NonceZero,
    PipelineAlreadyComplete,
    StepOutOfOrder,
}

// ── Internal helpers ───────────────────────────────────────────────────────

fn is_zero(b: &[u8; 32]) -> bool {
    b.iter().all(|&x| x == 0)
}

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
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

fn hex_encode(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

// ── Public API ─────────────────────────────────────────────────────────────

/// Create a new pipeline. Errors if secret or nonce is all-zero.
pub fn new_pipeline(secret: &[u8; 32], nonce: &[u8; 32]) -> Result<PrivacyPipeline, PipelineError> {
    if is_zero(secret) {
        return Err(PipelineError::SecretZero);
    }
    if is_zero(nonce) {
        return Err(PipelineError::NonceZero);
    }
    let pipeline_id = sha256_multi(&[b"pipeline-v1", secret.as_slice(), nonce.as_slice()]);
    Ok(PrivacyPipeline {
        pipeline_id,
        steps: Vec::new(),
        complete: false,
        mainnet_ready: false,
    })
}

/// Add the next step to the pipeline.
/// step_id must be exactly pipeline.steps.len() + 1 (i.e., steps are added in order 1,2,3,4).
/// hash = SHA256("pipeline-step-v1" || pipeline_id || [step_id] || SHA256(data))
pub fn add_step(
    pipeline: &mut PrivacyPipeline,
    step_id: u8,
    data: &[u8],
) -> Result<PipelineStep, PipelineError> {
    if pipeline.complete {
        return Err(PipelineError::PipelineAlreadyComplete);
    }
    let expected_step_id = pipeline.steps.len() as u8 + 1;
    if step_id != expected_step_id {
        return Err(PipelineError::StepOutOfOrder);
    }
    // SHA256(data) plain per spec:
    let data_hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(data);
        h.finalize().into()
    };
    let hash = sha256_multi(&[
        b"pipeline-step-v1",
        pipeline.pipeline_id.as_slice(),
        &[step_id],
        data_hash.as_slice(),
    ]);
    let step = PipelineStep {
        step_id,
        hash,
        mainnet_ready: false,
    };
    pipeline.steps.push(step.clone());
    Ok(step)
}

/// Finalize the pipeline. Errors if already complete.
/// final_hash = SHA256("pipeline-final-v1" || XOR-fold of all step hashes)
/// Sets complete = true and returns final_hash.
pub fn finalize_pipeline(pipeline: &mut PrivacyPipeline) -> Result<[u8; 32], PipelineError> {
    if pipeline.complete {
        return Err(PipelineError::PipelineAlreadyComplete);
    }
    let step_hashes: Vec<[u8; 32]> = pipeline.steps.iter().map(|s| s.hash).collect();
    let xor = xor_fold(&step_hashes);
    let final_hash = sha256_multi(&[b"pipeline-final-v1", xor.as_slice()]);
    pipeline.complete = true;
    Ok(final_hash)
}

/// Return a JSON public record. Does NOT expose step hashes.
pub fn pipeline_public_record(pipeline: &PrivacyPipeline) -> String {
    serde_json::json!({
        "pipeline_id": hex_encode(&pipeline.pipeline_id),
        "step_count": pipeline.steps.len(),
        "complete": pipeline.complete,
        "mainnet_ready": pipeline.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn secret() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xAA;
        s
    }

    fn nonce() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xBB;
        s
    }

    // 1. Full 4-step pipeline completes successfully.
    #[test]
    fn test_full_pipeline_completes() {
        let mut p = new_pipeline(&secret(), &nonce()).unwrap();
        add_step(&mut p, 1, b"note-commitment-data").unwrap();
        add_step(&mut p, 2, b"shielded-deposit-data").unwrap();
        add_step(&mut p, 3, b"shielded-transfer-data").unwrap();
        add_step(&mut p, 4, b"nullifier-record-data").unwrap();
        assert_eq!(p.steps.len(), 4);
        let fh = finalize_pipeline(&mut p).unwrap();
        assert!(p.complete);
        assert_ne!(fh, [0u8; 32]);
        assert!(!p.mainnet_ready);
    }

    // 2. Out-of-order step (e.g., skipping step 1 and submitting step 2) is rejected.
    #[test]
    fn test_out_of_order_step_rejected() {
        let mut p = new_pipeline(&secret(), &nonce()).unwrap();
        let result = add_step(&mut p, 2, b"bad-order");
        assert_eq!(result, Err(PipelineError::StepOutOfOrder));
    }

    // 3. Adding a step to an already-complete pipeline is rejected.
    #[test]
    fn test_already_complete_rejected() {
        let mut p = new_pipeline(&secret(), &nonce()).unwrap();
        add_step(&mut p, 1, b"step1").unwrap();
        finalize_pipeline(&mut p).unwrap();
        let result = add_step(&mut p, 2, b"step2");
        assert_eq!(result, Err(PipelineError::PipelineAlreadyComplete));
    }

    // 4. Step hashes are unique (different data → different hashes).
    #[test]
    fn test_step_hashes_are_unique() {
        let mut p = new_pipeline(&secret(), &nonce()).unwrap();
        let s1 = add_step(&mut p, 1, b"commit-data").unwrap();
        let s2 = add_step(&mut p, 2, b"mix-data").unwrap();
        let s3 = add_step(&mut p, 3, b"transfer-data").unwrap();
        let s4 = add_step(&mut p, 4, b"nullify-data").unwrap();
        assert_ne!(s1.hash, s2.hash);
        assert_ne!(s2.hash, s3.hash);
        assert_ne!(s3.hash, s4.hash);
    }

    // 5. Final hash depends on all steps (changing one step changes the final hash).
    #[test]
    fn test_final_hash_depends_on_all_steps() {
        let mut p1 = new_pipeline(&secret(), &nonce()).unwrap();
        add_step(&mut p1, 1, b"step-a").unwrap();
        add_step(&mut p1, 2, b"step-b").unwrap();
        add_step(&mut p1, 3, b"step-c").unwrap();
        add_step(&mut p1, 4, b"step-d").unwrap();
        let fh1 = finalize_pipeline(&mut p1).unwrap();

        let mut p2 = new_pipeline(&secret(), &nonce()).unwrap();
        add_step(&mut p2, 1, b"step-a").unwrap();
        add_step(&mut p2, 2, b"step-DIFFERENT").unwrap();
        add_step(&mut p2, 3, b"step-c").unwrap();
        add_step(&mut p2, 4, b"step-d").unwrap();
        let fh2 = finalize_pipeline(&mut p2).unwrap();

        assert_ne!(fh1, fh2, "final hash should change when a step changes");
    }

    // 6. Public record hides individual step hashes.
    #[test]
    fn test_public_record_hides_step_hashes() {
        let mut p = new_pipeline(&secret(), &nonce()).unwrap();
        let s1 = add_step(&mut p, 1, b"hidden-step").unwrap();
        finalize_pipeline(&mut p).unwrap();
        let record = pipeline_public_record(&p);
        let step_hash_hex = hex_encode(&s1.hash);
        assert!(
            !record.contains(&step_hash_hex),
            "public record must not contain step hashes"
        );
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v.get("pipeline_id").is_some());
        assert!(v.get("step_count").is_some());
        assert!(v.get("complete").is_some());
        assert!(v.get("mainnet_ready").is_some());
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_pipeline_id_nonzero() {
        let p = new_pipeline(&secret(), &nonce()).unwrap();
        assert_ne!(p.pipeline_id, [0u8; 32]);
    }

    #[test]
    fn test_mainnet_ready_false() {
        let p = new_pipeline(&secret(), &nonce()).unwrap();
        assert!(!p.mainnet_ready);
    }

    #[test]
    fn test_zero_secret_rejected() {
        let err = new_pipeline(&[0u8; 32], &nonce()).unwrap_err();
        assert_eq!(err, PipelineError::SecretZero);
    }

    #[test]
    fn test_zero_nonce_rejected() {
        let err = new_pipeline(&secret(), &[0u8; 32]).unwrap_err();
        assert_eq!(err, PipelineError::NonceZero);
    }

    #[test]
    fn test_step_mainnet_ready_false() {
        let mut p = new_pipeline(&secret(), &nonce()).unwrap();
        let step = add_step(&mut p, 1, b"data").unwrap();
        assert!(!step.mainnet_ready);
    }

    #[test]
    fn test_finalize_empty_pipeline_ok() {
        let mut p = new_pipeline(&secret(), &nonce()).unwrap();
        let fh = finalize_pipeline(&mut p).unwrap();
        assert!(p.complete);
        assert_ne!(fh, [0u8; 32]);
    }

    #[test]
    fn test_double_finalize_rejected() {
        let mut p = new_pipeline(&secret(), &nonce()).unwrap();
        finalize_pipeline(&mut p).unwrap();
        let err = finalize_pipeline(&mut p).unwrap_err();
        assert_eq!(err, PipelineError::PipelineAlreadyComplete);
    }

    #[test]
    fn test_step_count_in_public_record() {
        let mut p = new_pipeline(&secret(), &nonce()).unwrap();
        add_step(&mut p, 1, b"a").unwrap();
        add_step(&mut p, 2, b"b").unwrap();
        let v: serde_json::Value = serde_json::from_str(&pipeline_public_record(&p)).unwrap();
        assert_eq!(v["step_count"], 2u64);
    }

    #[test]
    fn test_pipeline_id_deterministic() {
        let p1 = new_pipeline(&secret(), &nonce()).unwrap();
        let p2 = new_pipeline(&secret(), &nonce()).unwrap();
        assert_eq!(p1.pipeline_id, p2.pipeline_id);
    }

    #[test]
    fn test_different_secrets_different_pipeline_id() {
        let mut s2 = secret();
        s2[1] = 0xFF;
        let p1 = new_pipeline(&secret(), &nonce()).unwrap();
        let p2 = new_pipeline(&s2, &nonce()).unwrap();
        assert_ne!(p1.pipeline_id, p2.pipeline_id);
    }
}
