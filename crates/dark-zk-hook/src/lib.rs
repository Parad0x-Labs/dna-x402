//! ZK Transfer Hook verifier logic for Dark Null.
//!
//! Pure-Rust hook verification logic intended to be called by a Token-2022
//! Transfer Hook program. In the finished design the hook receives a compressed
//! Groth16 proof (128 bytes) and two public inputs, verifies the proof on-chain
//! via the `alt_bn128` pairing syscall, then checks the nullifier PDA before
//! approving the transfer.
//!
//! ⚠️  STATUS: STUB — NOT A WORKING ZK GATE.
//!   `IS_STUB = true`, `MAINNET_READY = false`.
//!   The Groth16 pairing check is NOT implemented. Because a security gate with
//!   no verifier must never approve anything, `verify_hook_proof` FAILS CLOSED:
//!   in stub mode it returns `HookError::StubVerifierDisabled` and can NEVER emit
//!   an `approved` verdict. (A previous version returned `approved: true` for any
//!   non-zero proof — a forgeable gate. That has been removed.)
//!   Do not describe this as a working/"first-in-world" ZK hook until the real
//!   alt_bn128 verifier lands and is audited.
//!
//! Estimated on-chain cost once implemented: ~166,000 CU
//!   (~150,000 Groth16 verify + ~16,000 hook/nullifier overhead).

use sha2::{Digest, Sha256};

/// Compressed Groth16 BN254 proof size (G1 points, 64 bytes each × 2, minus sign bits).
pub const HOOK_PROOF_SIZE: usize = 128;
/// Number of public inputs: nullifier_hash + program_commitment.
pub const HOOK_PUBLIC_INPUTS: usize = 2;
/// Estimated CU cost for the full hook verification path (once implemented).
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
    /// Whether the transfer is approved. Only ever `true` once a real proof
    /// has actually been verified (never in stub mode).
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
    /// Proof structural check failed.
    ProofInvalid,
    /// The verifier is a stub (no Groth16 pairing wired). Fails closed: the gate
    /// refuses to approve until a real verifier is implemented and audited.
    StubVerifierDisabled,
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
/// Production behaviour (when `IS_STUB == false`): run
/// `solana_program::alt_bn128::alt_bn128_pairing` over (A, B, alpha, beta, gamma,
/// delta, C) for the Groth16 check, and only on success construct an approved
/// `HookVerdict`.
///
/// Stub behaviour (current): structural (non-zero) checks run, then the verifier
/// FAILS CLOSED with `StubVerifierDisabled`. It cannot return an approval, so a
/// forged or garbage proof can never pass.
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

    // SECURITY — FAIL CLOSED.
    // No real Groth16 verification is wired (IS_STUB). A security gate with no
    // verifier must never approve. Deny via error so no integration can mistake
    // this stub for a working ZK gate. When the real alt_bn128 verifier is added
    // (IS_STUB -> false), replace this with the pairing check + an approved verdict.
    if IS_STUB || !MAINNET_READY {
        return Err(HookError::StubVerifierDisabled);
    }

    // ── real verification path (reached only once IS_STUB == false) ───────────
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

    // ── FAIL-CLOSED guarantees ────────────────────────────────────────────────

    #[test]
    fn test_stub_fails_closed_on_structurally_valid_proof() {
        // The whole point: a structurally valid (non-zero) proof must NOT be
        // approved while the verifier is a stub. It must deny via error.
        assert_eq!(
            verify_hook_proof(&valid_proof()).unwrap_err(),
            HookError::StubVerifierDisabled
        );
    }

    #[test]
    fn test_stub_never_returns_an_approved_verdict() {
        // There is no input that yields an approved verdict in stub mode.
        let p = valid_proof();
        assert!(verify_hook_proof(&p).is_err());
    }

    #[test]
    fn test_is_stub_true() {
        assert!(IS_STUB);
    }

    #[test]
    fn test_mainnet_ready_false() {
        assert!(!MAINNET_READY);
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
}
