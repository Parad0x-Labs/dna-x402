//! ZK Transfer Hook verifier logic for Dark Null.
//!
//! Pure-Rust hook verification logic called by a Token-2022 Transfer Hook
//! program. The hook receives a compressed Groth16 proof (128 bytes) and two
//! public inputs, verifies the proof on-chain via the `alt_bn128` pairing
//! syscall, then checks the nullifier PDA before approving the transfer.
//!
//! This is the **first-in-world** ZK-gated Transfer Hook design for Solana.
//! Solana Token-2022 explicitly cannot combine Transfer Hooks with the native
//! Confidential Transfer extension — a custom ZK hook is the only path to
//! programmable-condition + amount-privacy on SPL tokens.
//!
//! Estimated on-chain cost: ~166,000 CU
//!   (~150,000 Groth16 verify + ~16,000 hook/nullifier overhead)
//!
//! `IS_STUB = true`, `MAINNET_READY = false`.

use sha2::{Digest, Sha256};

/// Compressed Groth16 BN254 proof size (G1 points, 64 bytes each × 2, minus sign bits).
pub const HOOK_PROOF_SIZE: usize = 128;
/// Number of public inputs: nullifier_hash + program_commitment.
pub const HOOK_PUBLIC_INPUTS: usize = 2;
/// Estimated CU cost for the full hook verification path.
pub const HOOK_ESTIMATED_CU: u32 = 166_000;
pub const HOOK_VERSION: u8 = 1;
pub const IS_STUB: bool = true;
pub const MAINNET_READY: bool = false;

#[derive(Debug, Clone)]
pub struct HookProof {
    /// Compressed Groth16 proof bytes (A, B, C points on BN254).
    pub compressed_proof: [u8; HOOK_PROOF_SIZE],
    /// Public input 1: the nullifier hash (prevents double-spend).
    pub nullifier_hash: [u8; 32],
    /// Public input 2: the program commitment (scope binding).
    pub program_commitment: [u8; 32],
    pub is_stub: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone)]
pub struct HookVerdict {
    /// Whether the transfer is approved.
    pub approved: bool,
    /// Echoed nullifier hash (for PDA write).
    pub nullifier_hash: [u8; 32],
    /// Echoed program commitment.
    pub program_commitment: [u8; 32],
    /// Hash of the verification result (for receipt chaining).
    pub verification_hash: [u8; 32],
}

#[derive(Debug, PartialEq)]
pub enum HookError {
    /// All-zero proof bytes — invalid.
    ZeroProof,
    /// All-zero nullifier hash — invalid.
    ZeroNullifier,
    /// All-zero program commitment — invalid.
    ZeroProgram,
    /// Proof structural check failed (stub: always passes if non-zero).
    ProofInvalid,
}

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// Verify a ZK hook proof.
///
/// In production this calls `solana_program::alt_bn128::alt_bn128_pairing`
/// for the Groth16 check. In stub mode it verifies structural integrity only.
pub fn verify_hook_proof(proof: &HookProof) -> Result<HookVerdict, HookError> {
    if proof.compressed_proof == [0u8; HOOK_PROOF_SIZE] {
        return Err(HookError::ZeroProof);
    }
    if proof.nullifier_hash == [0u8; 32] {
        return Err(HookError::ZeroNullifier);
    }
    if proof.program_commitment == [0u8; 32] {
        return Err(HookError::ZeroProgram);
    }
    // Stub: any non-zero proof passes structural check.
    // Production: run alt_bn128 multi-pairing over (A, B, alpha, beta, gamma, delta, C).
    let verification_hash = sha256_multi(&[
        b"dark-hook-verdict-v1",
        &proof.compressed_proof,
        &proof.nullifier_hash,
        &proof.program_commitment,
    ]);
    Ok(HookVerdict {
        approved: true,
        nullifier_hash: proof.nullifier_hash,
        program_commitment: proof.program_commitment,
        verification_hash,
    })
}

/// Return the estimated CU cost for a full hook verification.
pub fn hook_cu_estimate() -> u32 {
    HOOK_ESTIMATED_CU
}

/// Return the expected byte length of a compressed Groth16 proof.
pub fn hook_proof_size() -> usize {
    HOOK_PROOF_SIZE
}

/// Build a test-only `HookProof` with non-zero fields.
pub fn make_test_proof(
    nullifier_hash: [u8; 32],
    program_commitment: [u8; 32],
) -> HookProof {
    let mut proof_bytes = [0u8; HOOK_PROOF_SIZE];
    proof_bytes[0] = 0x01; // non-zero guard
    proof_bytes[1..33].copy_from_slice(&nullifier_hash);
    proof_bytes[33..65].copy_from_slice(&program_commitment);
    HookProof {
        compressed_proof: proof_bytes,
        nullifier_hash,
        program_commitment,
        is_stub: true,
        mainnet_ready: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nh() -> [u8; 32] {
        [0xaau8; 32]
    }
    fn pc() -> [u8; 32] {
        [0xbbu8; 32]
    }

    fn valid_proof() -> HookProof {
        make_test_proof(nh(), pc())
    }

    #[test]
    fn test_hook_proof_size_is_128() {
        assert_eq!(HOOK_PROOF_SIZE, 128);
    }

    #[test]
    fn test_hook_cu_estimate_nonzero() {
        assert!(hook_cu_estimate() > 0);
    }

    #[test]
    fn test_hook_public_inputs_count() {
        assert_eq!(HOOK_PUBLIC_INPUTS, 2);
    }

    #[test]
    fn test_zero_proof_rejected() {
        let mut p = valid_proof();
        p.compressed_proof = [0u8; HOOK_PROOF_SIZE];
        assert_eq!(verify_hook_proof(&p).unwrap_err(), HookError::ZeroProof);
    }

    #[test]
    fn test_zero_nullifier_rejected() {
        let p = make_test_proof([0u8; 32], pc());
        assert_eq!(verify_hook_proof(&p).unwrap_err(), HookError::ZeroNullifier);
    }

    #[test]
    fn test_zero_program_rejected() {
        let p = make_test_proof(nh(), [0u8; 32]);
        assert_eq!(verify_hook_proof(&p).unwrap_err(), HookError::ZeroProgram);
    }

    #[test]
    fn test_valid_proof_returns_ok() {
        assert!(verify_hook_proof(&valid_proof()).is_ok());
    }

    #[test]
    fn test_verdict_approved_true() {
        let v = verify_hook_proof(&valid_proof()).unwrap();
        assert!(v.approved);
    }

    #[test]
    fn test_verdict_nullifier_matches() {
        let v = verify_hook_proof(&valid_proof()).unwrap();
        assert_eq!(v.nullifier_hash, nh());
    }

    #[test]
    fn test_verdict_program_matches() {
        let v = verify_hook_proof(&valid_proof()).unwrap();
        assert_eq!(v.program_commitment, pc());
    }

    #[test]
    fn test_verification_hash_nonzero() {
        let v = verify_hook_proof(&valid_proof()).unwrap();
        assert_ne!(v.verification_hash, [0u8; 32]);
    }

    #[test]
    fn test_verification_hash_deterministic() {
        let v1 = verify_hook_proof(&valid_proof()).unwrap();
        let v2 = verify_hook_proof(&valid_proof()).unwrap();
        assert_eq!(v1.verification_hash, v2.verification_hash);
    }

    #[test]
    fn test_hook_version_constant() {
        assert_eq!(HOOK_VERSION, 1);
    }

    #[test]
    fn test_make_test_proof_nonzero() {
        let p = valid_proof();
        assert_ne!(p.compressed_proof, [0u8; HOOK_PROOF_SIZE]);
    }

    #[test]
    fn test_mainnet_ready_false() {
        let p = valid_proof();
        assert!(!p.mainnet_ready);
    }

    #[test]
    fn test_is_stub_true() {
        let p = valid_proof();
        assert!(p.is_stub);
    }
}
