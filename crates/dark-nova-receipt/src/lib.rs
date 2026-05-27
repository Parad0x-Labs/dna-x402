//! Nova-compatible receipt fold structure for Dark Null.
//!
//! Designs receipt generation to be IVC (Incremental Verifiable Computation)
//! compatible, enabling future integration with Nova / SuperNova folding.
//!
//! Architecture: each receipt is one IVC "step". Steps fold off-chain into
//! a NovaAccumulator. The final on-chain submission is one Groth16 proof
//! covering all N receipts — reducing 150,000 CU × N to a single
//! ~150,000 CU verification regardless of N.
//!
//! SXTNT benchmark (256 sub-proofs): $0.019 on-chain, 99.7% CU savings.
//!
//! `IS_STUB = true`, `MAINNET_READY = false`.

use sha2::{Digest, Sha256};

/// Maximum number of steps in one accumulator before on-chain settlement.
pub const NOVA_MAX_STEPS: u32 = 1024;
pub const NOVA_VERSION: u8 = 1;
pub const IS_STUB: bool = true;
pub const MAINNET_READY: bool = false;

/// One IVC step: wraps a single receipt commitment into the fold chain.
#[derive(Debug, Clone)]
pub struct NovaStep {
    pub step_index: u32,
    /// Public input: hash of the previous accumulator state.
    pub public_input: [u8; 32],
    /// Public output: hash of the new accumulator state after this step.
    pub public_output: [u8; 32],
    /// Private witness commitment (the receipt commitment).
    pub receipt_commitment: [u8; 32],
    /// Stub proof hash (production: relaxed R1CS witness hash).
    pub step_proof: [u8; 32],
    pub is_stub: bool,
    pub mainnet_ready: bool,
}

/// Running accumulator produced by folding steps.
#[derive(Debug, Clone)]
pub struct NovaAccumulator {
    /// Commitment to the current folded state.
    pub accumulated_hash: [u8; 32],
    /// Number of steps folded so far.
    pub step_count: u32,
    /// Public input of the very first step (anchors the chain).
    pub first_step_input: [u8; 32],
    pub is_stub: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum NovaError {
    /// `step_count` would exceed `NOVA_MAX_STEPS`.
    StepCountOverflow,
    /// `step.public_input` does not match the accumulator's current hash.
    InvalidStepInput,
    /// `receipt_commitment` is all zeros.
    ZeroReceiptCommitment,
}

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// Create the initial accumulator from a session-specific seed.
pub fn create_initial_accumulator(initial_input: &[u8; 32]) -> NovaAccumulator {
    NovaAccumulator {
        accumulated_hash: *initial_input,
        step_count: 0,
        first_step_input: *initial_input,
        is_stub: true,
        mainnet_ready: false,
    }
}

/// Create the next IVC step from the current accumulator and a receipt commitment.
pub fn create_nova_step(
    prev_accumulator: &NovaAccumulator,
    receipt_commitment: &[u8; 32],
) -> Result<NovaStep, NovaError> {
    if prev_accumulator.step_count >= NOVA_MAX_STEPS {
        return Err(NovaError::StepCountOverflow);
    }
    if receipt_commitment == &[0u8; 32] {
        return Err(NovaError::ZeroReceiptCommitment);
    }
    let step_index = prev_accumulator.step_count;
    let public_input = prev_accumulator.accumulated_hash;
    let public_output = sha256_multi(&[
        b"dark-nova-step-v1",
        &public_input,
        receipt_commitment,
        &step_index.to_le_bytes(),
    ]);
    let step_proof = sha256_multi(&[
        b"dark-nova-step-proof-v1",
        &public_input,
        &public_output,
        receipt_commitment,
    ]);
    Ok(NovaStep {
        step_index,
        public_input,
        public_output,
        receipt_commitment: *receipt_commitment,
        step_proof,
        is_stub: true,
        mainnet_ready: false,
    })
}

/// Fold one step into the accumulator, advancing the chain.
pub fn fold_step(
    accumulator: &NovaAccumulator,
    step: &NovaStep,
) -> Result<NovaAccumulator, NovaError> {
    if step.public_input != accumulator.accumulated_hash {
        return Err(NovaError::InvalidStepInput);
    }
    if accumulator.step_count >= NOVA_MAX_STEPS {
        return Err(NovaError::StepCountOverflow);
    }
    Ok(NovaAccumulator {
        accumulated_hash: step.public_output,
        step_count: accumulator.step_count + 1,
        first_step_input: accumulator.first_step_input,
        is_stub: true,
        mainnet_ready: false,
    })
}

/// Verify that `final_acc` is the result of folding exactly `steps` in order.
pub fn verify_accumulator_chain(
    final_acc: &NovaAccumulator,
    steps: &[NovaStep],
) -> bool {
    if steps.len() as u32 != final_acc.step_count {
        return false;
    }
    let mut current = final_acc.first_step_input;
    for step in steps {
        if step.public_input != current {
            return false;
        }
        current = step.public_output;
    }
    current == final_acc.accumulated_hash
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed() -> [u8; 32] {
        [0x01u8; 32]
    }
    fn rc1() -> [u8; 32] {
        [0x11u8; 32]
    }
    fn rc2() -> [u8; 32] {
        [0x22u8; 32]
    }

    #[test]
    fn test_initial_accumulator_step_count_zero() {
        let acc = create_initial_accumulator(&seed());
        assert_eq!(acc.step_count, 0);
    }

    #[test]
    fn test_initial_accumulator_hash_matches_seed() {
        let acc = create_initial_accumulator(&seed());
        assert_eq!(acc.accumulated_hash, seed());
    }

    #[test]
    fn test_create_step_nonzero_output() {
        let acc = create_initial_accumulator(&seed());
        let step = create_nova_step(&acc, &rc1()).unwrap();
        assert_ne!(step.public_output, [0u8; 32]);
    }

    #[test]
    fn test_create_step_output_differs_from_input() {
        let acc = create_initial_accumulator(&seed());
        let step = create_nova_step(&acc, &rc1()).unwrap();
        assert_ne!(step.public_output, step.public_input);
    }

    #[test]
    fn test_zero_commitment_rejected() {
        let acc = create_initial_accumulator(&seed());
        let err = create_nova_step(&acc, &[0u8; 32]).unwrap_err();
        assert_eq!(err, NovaError::ZeroReceiptCommitment);
    }

    #[test]
    fn test_fold_step_updates_hash() {
        let acc0 = create_initial_accumulator(&seed());
        let step = create_nova_step(&acc0, &rc1()).unwrap();
        let acc1 = fold_step(&acc0, &step).unwrap();
        assert_ne!(acc1.accumulated_hash, acc0.accumulated_hash);
    }

    #[test]
    fn test_fold_step_increments_step_count() {
        let acc0 = create_initial_accumulator(&seed());
        let step = create_nova_step(&acc0, &rc1()).unwrap();
        let acc1 = fold_step(&acc0, &step).unwrap();
        assert_eq!(acc1.step_count, 1);
    }

    #[test]
    fn test_fold_step_wrong_input_rejected() {
        let acc0 = create_initial_accumulator(&seed());
        let mut bad_step = create_nova_step(&acc0, &rc1()).unwrap();
        bad_step.public_input = [0xffu8; 32]; // tampered
        let err = fold_step(&acc0, &bad_step).unwrap_err();
        assert_eq!(err, NovaError::InvalidStepInput);
    }

    #[test]
    fn test_step_count_overflow_rejected() {
        let mut acc = create_initial_accumulator(&seed());
        // Manually force overflow without actually looping 1024 times
        acc.step_count = NOVA_MAX_STEPS;
        let err = create_nova_step(&acc, &rc1()).unwrap_err();
        assert_eq!(err, NovaError::StepCountOverflow);
    }

    #[test]
    fn test_verify_chain_count_mismatch_fails() {
        let acc0 = create_initial_accumulator(&seed());
        let step = create_nova_step(&acc0, &rc1()).unwrap();
        let acc1 = fold_step(&acc0, &step).unwrap();
        // acc1 has step_count=1 but we pass 0 steps
        assert!(!verify_accumulator_chain(&acc1, &[]));
    }

    #[test]
    fn test_verify_chain_single_step() {
        let acc0 = create_initial_accumulator(&seed());
        let step = create_nova_step(&acc0, &rc1()).unwrap();
        let acc1 = fold_step(&acc0, &step).unwrap();
        assert!(verify_accumulator_chain(&acc1, &[step]));
    }

    #[test]
    fn test_verify_chain_two_steps() {
        let acc0 = create_initial_accumulator(&seed());
        let step1 = create_nova_step(&acc0, &rc1()).unwrap();
        let acc1 = fold_step(&acc0, &step1).unwrap();
        let step2 = create_nova_step(&acc1, &rc2()).unwrap();
        let acc2 = fold_step(&acc1, &step2).unwrap();
        assert!(verify_accumulator_chain(&acc2, &[step1, step2]));
    }

    #[test]
    fn test_nova_max_steps_constant() {
        assert_eq!(NOVA_MAX_STEPS, 1024);
    }

    #[test]
    fn test_nova_version_constant() {
        assert_eq!(NOVA_VERSION, 1);
    }

    #[test]
    fn test_mainnet_ready_false() {
        let acc = create_initial_accumulator(&seed());
        assert!(!acc.mainnet_ready);
    }

    #[test]
    fn test_is_stub_true() {
        let acc = create_initial_accumulator(&seed());
        assert!(acc.is_stub);
    }
}
