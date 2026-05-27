//! dark-shielded-pool — first Solana-native fixed-denomination shielded transfer pool
//!
//! Privacy architecture:
//!   1. Deposit `denomination` lamports  →  record H(secret || leaf_index) on-chain
//!   2. Withdraw by presenting: nullifier + ZK proof + recipient (any address)
//!      Nullifier = H(secret || pool_key)  — unlinked to commitment without the secret
//!      Proof     = Groth16(knowledge of secret that opens a commitment in the tree)
//!                  IS_STUB: SHA-256 gate until circuit is compiled
//!
//! Privacy guarantees (v1 — note scheme, Groth16 stub):
//!   ✓ Sender-receiver address unlinkability
//!   ✓ Uniform amounts (fixed denomination eliminates amount fingerprinting)
//!   ✓ Nullifier prevents double-spend
//!   ✗ Full ZK (secret not revealed on-chain, but proof is a stub, not a real circuit)
//!
//! Phase 2: swap verify_proof_stub for real alt_bn128 Groth16 verification.
//!
//! IS_STUB      = true
//! MAINNET_READY = false

pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

pub use processor::{commitment_hash, nullifier_hash, update_merkle_root, verify_proof_stub};

/// IS_STUB: proof verification is SHA-256 gate, not real Groth16.
pub const IS_STUB: bool = true;
/// MAINNET_READY: never flip without real circuit + trusted setup + audit.
pub const MAINNET_READY: bool = false;

#[cfg(not(feature = "no-entrypoint"))]
use solana_program::{account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey};

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

#[cfg(not(feature = "no-entrypoint"))]
fn process_instruction(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    data:       &[u8],
) -> ProgramResult {
    processor::process_instruction(program_id, accounts, data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        error::ShieldedPoolError,
        instruction::PoolInstruction,
        state::{
            NoteLeaf, NullifierRecord, PoolConfig, NOTE_LEAF_LEN, NULLIFIER_RECORD_LEN,
            POOL_CONFIG_LEN, POOL_CONFIG_VERSION,
        },
    };
    use solana_program::program_error::ProgramError;
    use solana_program::program_pack::{IsInitialized, Pack};

    // ── helpers ───────────────────────────────────────────────────────────────
    fn secret() -> [u8; 32] { let mut s = [0u8; 32]; s[0] = 0xDE; s[31] = 0xAD; s }
    fn pool_key() -> [u8; 32] { let mut p = [0u8; 32]; p[0] = 0xCA; p[15] = 0xFE; p }

    // 1. IS_STUB and MAINNET_READY constants
    #[test]
    fn test_constants() {
        assert!(IS_STUB, "must be stub");
        assert!(!MAINNET_READY, "must never be mainnet ready");
    }

    // 2. POOL_CONFIG_LEN
    #[test]
    fn test_pool_config_len() {
        assert_eq!(POOL_CONFIG_LEN, 116);
        assert_eq!(PoolConfig::LEN, POOL_CONFIG_LEN);
    }

    // 3. NOTE_LEAF_LEN
    #[test]
    fn test_note_leaf_len() {
        assert_eq!(NOTE_LEAF_LEN, 49);
        assert_eq!(NoteLeaf::LEN, NOTE_LEAF_LEN);
    }

    // 4. NULLIFIER_RECORD_LEN
    #[test]
    fn test_nullifier_record_len() {
        assert_eq!(NULLIFIER_RECORD_LEN, 41);
        assert_eq!(NullifierRecord::LEN, NULLIFIER_RECORD_LEN);
    }

    // 5. PoolConfig pack/unpack roundtrip
    #[test]
    fn test_pool_config_pack_unpack() {
        let cfg = PoolConfig {
            version:        POOL_CONFIG_VERSION,
            bump:           251,
            is_initialized: true,
            is_paused:      false,
            authority:      [0xABu8; 32],
            denomination:   100_000_000,
            merkle_root:    [0x11u8; 32],
            note_count:     42,
        };
        let mut buf = [0u8; POOL_CONFIG_LEN];
        PoolConfig::pack(cfg.clone(), &mut buf).unwrap();
        let unpacked = PoolConfig::unpack(&buf).unwrap();
        assert_eq!(cfg, unpacked);
        assert!(unpacked.is_initialized());
    }

    // 6. NoteLeaf pack/unpack roundtrip
    #[test]
    fn test_note_leaf_pack_unpack() {
        let leaf = NoteLeaf {
            bump:         250,
            commitment:   [0x22u8; 32],
            leaf_index:   7,
            deposited_at: 1_700_000_000,
        };
        let mut buf = [0u8; NOTE_LEAF_LEN];
        NoteLeaf::pack(leaf.clone(), &mut buf).unwrap();
        let unpacked = NoteLeaf::unpack(&buf).unwrap();
        assert_eq!(leaf, unpacked);
        assert!(unpacked.is_initialized());
    }

    // 7. NullifierRecord pack/unpack roundtrip
    #[test]
    fn test_nullifier_record_pack_unpack() {
        let rec = NullifierRecord {
            bump:      249,
            nullifier: [0x33u8; 32],
            spent_at:  1_700_086_400,
        };
        let mut buf = [0u8; NULLIFIER_RECORD_LEN];
        NullifierRecord::pack(rec.clone(), &mut buf).unwrap();
        let unpacked = NullifierRecord::unpack(&buf).unwrap();
        assert_eq!(rec, unpacked);
    }

    // 8. commitment_hash is non-zero
    #[test]
    fn test_commitment_hash_not_zero() {
        let c = commitment_hash(&secret(), 0);
        assert_ne!(c, [0u8; 32]);
    }

    // 9. commitment_hash is deterministic
    #[test]
    fn test_commitment_hash_deterministic() {
        assert_eq!(commitment_hash(&secret(), 0), commitment_hash(&secret(), 0));
    }

    // 10. commitment_hash is sensitive to secret
    #[test]
    fn test_commitment_hash_secret_sensitivity() {
        let mut s2 = secret();
        s2[7] ^= 0xFF;
        assert_ne!(commitment_hash(&secret(), 0), commitment_hash(&s2, 0));
    }

    // 11. nullifier_hash is non-zero and deterministic
    #[test]
    fn test_nullifier_hash_deterministic() {
        let n1 = nullifier_hash(&secret(), &pool_key());
        let n2 = nullifier_hash(&secret(), &pool_key());
        assert_eq!(n1, n2);
        assert_ne!(n1, [0u8; 32]);
    }

    // 12. nullifier differs from commitment (no trivial link)
    #[test]
    fn test_nullifier_differs_from_commitment() {
        let c = commitment_hash(&secret(), 0);
        let n = nullifier_hash(&secret(), &pool_key());
        assert_ne!(c, n, "nullifier must not equal commitment");
    }

    // 13. stub proof: correct inputs accepted
    #[test]
    fn test_proof_stub_correct_inputs() {
        let nullifier = nullifier_hash(&secret(), &pool_key());
        let root = update_merkle_root(&[0u8; 32], &commitment_hash(&secret(), 0), 0);
        let recipient = [0xFFu8; 32];

        // Build the valid proof
        let mut proof = [0u8; 128];
        let expected = {
            use sha2::{Digest, Sha256};
            let mut h = Sha256::new();
            h.update(b"dark-pool-proof-v1");
            h.update(&nullifier);
            h.update(&root);
            h.update(&recipient);
            let out: [u8; 32] = h.finalize().into();
            out
        };
        proof[..32].copy_from_slice(&expected);

        assert!(verify_proof_stub(&proof, &nullifier, &root, &recipient));
    }

    // 14. stub proof: wrong nullifier rejected
    #[test]
    fn test_proof_stub_wrong_nullifier_rejected() {
        let nullifier = nullifier_hash(&secret(), &pool_key());
        let root = [0u8; 32];
        let recipient = [0xFFu8; 32];

        let mut proof = [0u8; 128];
        // Build proof for correct nullifier but verify with wrong one
        let expected = {
            use sha2::{Digest, Sha256};
            let mut h = Sha256::new();
            h.update(b"dark-pool-proof-v1");
            h.update(&nullifier);
            h.update(&root);
            h.update(&recipient);
            let out: [u8; 32] = h.finalize().into();
            out
        };
        proof[..32].copy_from_slice(&expected);

        let mut bad_null = nullifier;
        bad_null[0] ^= 0xFF;
        assert!(!verify_proof_stub(&proof, &bad_null, &root, &recipient));
    }

    // 15. merkle root changes with each deposit
    #[test]
    fn test_update_merkle_root_changes() {
        let c0 = commitment_hash(&secret(), 0);
        let r0 = [0u8; 32];
        let r1 = update_merkle_root(&r0, &c0, 0);
        let r2 = update_merkle_root(&r1, &c0, 1);
        assert_ne!(r0, r1);
        assert_ne!(r1, r2);
    }

    // 16. error code values are stable
    #[test]
    fn test_error_codes() {
        assert_eq!(ShieldedPoolError::AlreadyInitialized  as u32, 0);
        assert_eq!(ShieldedPoolError::PoolPaused          as u32, 1);
        assert_eq!(ShieldedPoolError::ZeroCommitment      as u32, 2);
        assert_eq!(ShieldedPoolError::NullifierAlreadySpent as u32, 3);
        assert_eq!(ShieldedPoolError::ProofInvalid        as u32, 4);
        assert_eq!(ShieldedPoolError::ZeroDenomination    as u32, 5);
        assert_eq!(ShieldedPoolError::InsufficientFunds   as u32, 6);
        assert_eq!(ShieldedPoolError::NotInitialized      as u32, 7);
        assert_eq!(ShieldedPoolError::InvalidInstruction  as u32, 8);
        assert_eq!(ShieldedPoolError::ArithmeticOverflow  as u32, 9);
    }

    // ── Extended tests ────────────────────────────────────────────────────────

    // 17. instruction round-trip: InitPool
    #[test]
    fn test_instruction_init_pool_roundtrip() {
        let ix = PoolInstruction::InitPool { denomination: 1_000_000_000 };
        let packed = ix.pack();
        let unpacked = PoolInstruction::unpack(&packed).unwrap();
        assert_eq!(ix, unpacked);
    }

    // 18. instruction round-trip: Deposit
    #[test]
    fn test_instruction_deposit_roundtrip() {
        let ix = PoolInstruction::Deposit { commitment: [0xAAu8; 32] };
        let bytes = ix.pack();
        let back  = PoolInstruction::unpack(&bytes).unwrap();
        assert_eq!(ix, back);
    }

    // 19. instruction round-trip: Withdraw
    #[test]
    fn test_instruction_withdraw_roundtrip() {
        use solana_program::pubkey::Pubkey;
        let ix = PoolInstruction::Withdraw {
            nullifier: [0xBBu8; 32],
            proof:     [0xCCu8; 128],
            recipient: Pubkey::from([0xDDu8; 32]),
        };
        let bytes = ix.pack();
        let back  = PoolInstruction::unpack(&bytes).unwrap();
        assert_eq!(ix, back);
    }

    // 20. empty instruction data → InvalidInstruction error
    #[test]
    fn test_instruction_empty_data_error() {
        let err = PoolInstruction::unpack(&[]).unwrap_err();
        assert_eq!(err, ProgramError::Custom(ShieldedPoolError::InvalidInstruction as u32));
    }

    // 21. unknown discriminator → error
    #[test]
    fn test_instruction_bad_discriminator() {
        let err = PoolInstruction::unpack(&[0xFFu8]).unwrap_err();
        assert_eq!(err, ProgramError::Custom(ShieldedPoolError::InvalidInstruction as u32));
    }

    // 22. PoolConfig default is not initialized
    #[test]
    fn test_pool_config_default_not_initialized() {
        let cfg = PoolConfig::default();
        assert!(!cfg.is_initialized());
    }

    // 23. NoteLeaf with zero commitment is not initialized
    #[test]
    fn test_note_leaf_zero_not_initialized() {
        let leaf = NoteLeaf::default();
        assert!(!leaf.is_initialized());
    }

    // 24. commitment changes with leaf_index (same secret, different index)
    #[test]
    fn test_commitment_leaf_index_sensitivity() {
        let c0 = commitment_hash(&secret(), 0);
        let c1 = commitment_hash(&secret(), 1);
        assert_ne!(c0, c1, "different leaf indices must give different commitments");
    }

    // 25. nullifier changes with pool_key (same secret, different pool)
    #[test]
    fn test_nullifier_pool_sensitivity() {
        let mut p2 = pool_key();
        p2[0] ^= 0x01;
        let n1 = nullifier_hash(&secret(), &pool_key());
        let n2 = nullifier_hash(&secret(), &p2);
        assert_ne!(n1, n2, "different pool keys must give different nullifiers");
    }

    // 26. error converts to ProgramError::Custom
    #[test]
    fn test_error_to_program_error() {
        let pe: ProgramError = ShieldedPoolError::ProofInvalid.into();
        assert_eq!(pe, ProgramError::Custom(4));
    }
}
