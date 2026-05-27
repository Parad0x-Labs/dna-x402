//! Collision-safe Poseidon-compatible hash stub for Dark Null.
//!
//! Enforces the BN254 Poseidon constraint that all inputs must be exactly
//! 32 bytes (zero-padded field elements). Prevents the March 2026 variable-
//! length collision vulnerability discovered in `sol_poseidon` where inputs
//! like `[0,0,0,1,…]` and `[1,…]` produced identical digests.
//!
//! Backend: SHA-256 with domain separation (stub). Production: `sol_poseidon`
//! syscall with BN254 x^5 Sponge parameters.
//!
//! `IS_STUB = true`, `MAINNET_READY = false`.

use sha2::{Digest, Sha256};

/// Maximum number of field-element inputs BN254 Poseidon t=13 accepts.
pub const MAX_POSEIDON_INPUTS: usize = 12;
/// Size of a Poseidon output (one BN254 field element, big-endian).
pub const POSEIDON_OUTPUT_SIZE: usize = 32;
/// Crate interface version.
pub const POSEIDON_VERSION: u8 = 2;
/// Always true – stub backend, not the real BN254 syscall.
pub const IS_STUB: bool = true;
/// Always false – not audited for production use.
pub const MAINNET_READY: bool = false;

#[derive(Debug, PartialEq)]
pub enum PoseidonError {
    /// All-zero input is ambiguous with the BN254 zero field element –
    /// rejected to prevent the March 2026 aliasing class.
    ZeroInput,
    /// More than `MAX_POSEIDON_INPUTS` inputs supplied.
    TooManyInputs,
    /// Empty input slice supplied.
    NoInputs,
}

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// Hash `inputs` (each exactly 32 bytes) under `domain`.
///
/// Returns `Err(ZeroInput)` if any element is all-zero.
/// Returns `Err(TooManyInputs)` if `inputs.len() > MAX_POSEIDON_INPUTS`.
/// Returns `Err(NoInputs)` if `inputs` is empty.
pub fn poseidon_safe(
    domain: &[u8; 32],
    inputs: &[[u8; 32]],
) -> Result<[u8; 32], PoseidonError> {
    if inputs.is_empty() {
        return Err(PoseidonError::NoInputs);
    }
    if inputs.len() > MAX_POSEIDON_INPUTS {
        return Err(PoseidonError::TooManyInputs);
    }
    for input in inputs {
        if input == &[0u8; 32] {
            return Err(PoseidonError::ZeroInput);
        }
    }
    let mut h = Sha256::new();
    h.update(b"dark-poseidon-safe-v2");
    h.update(domain);
    for input in inputs {
        h.update(input);
    }
    Ok(h.finalize().into())
}

/// Compute an IMT-compatible leaf hash: `H("dark-imt-leaf-v2" || level || left || right)`.
pub fn merkle_node_hash(level: u8, left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"dark-merkle-node-v2", &[level], left, right])
}

/// Nullifier derivation: `H("dark-nullifier-v2" || spending_key || program_id)`.
pub fn nullifier_hash(spending_key: &[u8; 32], program_id: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"dark-nullifier-v2", spending_key, program_id])
}

/// Amount commitment: `H("dark-amount-v2" || amount_le8 || blinding)`.
pub fn amount_commitment(amount: u64, blinding: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"dark-amount-v2", &amount.to_le_bytes(), blinding])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn domain() -> [u8; 32] {
        let mut d = [0u8; 32];
        d[0] = 0x01;
        d
    }

    fn nz() -> [u8; 32] {
        let mut v = [0u8; 32];
        v[0] = 0x42;
        v
    }

    #[test]
    fn test_valid_single_input_accepted() {
        let result = poseidon_safe(&domain(), &[nz()]);
        assert!(result.is_ok());
        assert_ne!(result.unwrap(), [0u8; 32]);
    }

    #[test]
    fn test_zero_input_rejected() {
        let result = poseidon_safe(&domain(), &[[0u8; 32]]);
        assert_eq!(result.err(), Some(PoseidonError::ZeroInput));
    }

    #[test]
    fn test_no_inputs_rejected() {
        let result = poseidon_safe(&domain(), &[]);
        assert_eq!(result.err(), Some(PoseidonError::NoInputs));
    }

    #[test]
    fn test_too_many_inputs_rejected() {
        let inputs = vec![nz(); MAX_POSEIDON_INPUTS + 1];
        let result = poseidon_safe(&domain(), &inputs);
        assert_eq!(result.err(), Some(PoseidonError::TooManyInputs));
    }

    #[test]
    fn test_max_inputs_accepted() {
        let inputs = vec![nz(); MAX_POSEIDON_INPUTS];
        assert!(poseidon_safe(&domain(), &inputs).is_ok());
    }

    #[test]
    fn test_deterministic_output() {
        let a = poseidon_safe(&domain(), &[nz()]).unwrap();
        let b = poseidon_safe(&domain(), &[nz()]).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn test_domain_separation() {
        let mut d2 = domain();
        d2[0] = 0x02;
        let a = poseidon_safe(&domain(), &[nz()]).unwrap();
        let b = poseidon_safe(&d2, &[nz()]).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn test_different_inputs_different_output() {
        let mut i2 = nz();
        i2[1] = 0x99;
        let a = poseidon_safe(&domain(), &[nz()]).unwrap();
        let b = poseidon_safe(&domain(), &[i2]).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn test_merkle_node_hash_nonzero() {
        let h = merkle_node_hash(0, &[0x01u8; 32], &[0x02u8; 32]);
        assert_ne!(h, [0u8; 32]);
    }

    #[test]
    fn test_merkle_node_hash_level_sensitive() {
        let h0 = merkle_node_hash(0, &[0x01u8; 32], &[0x02u8; 32]);
        let h1 = merkle_node_hash(1, &[0x01u8; 32], &[0x02u8; 32]);
        assert_ne!(h0, h1);
    }

    #[test]
    fn test_nullifier_hash_key_sensitive() {
        let n1 = nullifier_hash(&[0x01u8; 32], &[0xaau8; 32]);
        let n2 = nullifier_hash(&[0x02u8; 32], &[0xaau8; 32]);
        assert_ne!(n1, n2);
    }

    #[test]
    fn test_nullifier_hash_program_sensitive() {
        let n1 = nullifier_hash(&[0x01u8; 32], &[0xaau8; 32]);
        let n2 = nullifier_hash(&[0x01u8; 32], &[0xbbu8; 32]);
        assert_ne!(n1, n2);
    }

    #[test]
    fn test_amount_commitment_nonzero() {
        let c = amount_commitment(1_000_000, &[0x01u8; 32]);
        assert_ne!(c, [0u8; 32]);
    }

    #[test]
    fn test_amount_commitment_amount_sensitive() {
        let c1 = amount_commitment(100, &[0x01u8; 32]);
        let c2 = amount_commitment(200, &[0x01u8; 32]);
        assert_ne!(c1, c2);
    }

    #[test]
    fn test_amount_commitment_blinding_sensitive() {
        let c1 = amount_commitment(100, &[0x01u8; 32]);
        let c2 = amount_commitment(100, &[0x02u8; 32]);
        assert_ne!(c1, c2);
    }

    #[test]
    fn test_is_stub_true() {
        assert!(IS_STUB);
    }

    #[test]
    fn test_mainnet_ready_false() {
        assert!(!MAINNET_READY);
    }
}
