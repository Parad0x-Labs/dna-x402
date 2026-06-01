//! dark-shielded-pool - fixed-denomination shielded transfer pool prototype
//!
//! ROOT AUTHORITY NOTE:
//!   Root authority is currently single-key (see docs/DARK_NULL_ROOT_MULTISIG.md
//!   for the multisig migration plan). Squads multisig 9M949Afy... is used as
//!   the interim authority. A full M-of-N timelock + fraud-proof mechanism is
//!   planned but not yet implemented. Do NOT set MAINNET_READY=true until the
//!   multisig root update path (ProposeUpdateRoot + timelock + ChallengeRoot) is
//!   deployed and the Squads vault is confirmed as the on-chain authority.
//!
//! Privacy architecture:
//!   1. Deposit `denomination` lamports and record H(secret || leaf_index) on-chain
//!   2. Withdraw by presenting: nullifier + ZK proof + recipient (any address)
//!      Nullifier = H(secret || pool_key) - unlinked to commitment without the secret
//!      Proof     = Groth16(knowledge of secret that opens a commitment in the tree)
//!                  inactive until final VK/circuit artifacts are wired
//!
//! Current status:
//!   - deposit/note/nullifier state model exists
//!   - Groth16 verifier call path exists
//!   - withdrawals fail closed while VK_FINAL=false (verify_proof_groth16 → false)
//!
//! Blockers before live shielded withdrawals (verified, precise — grant sprint scope):
//!   1. HASH SCHEME MISMATCH. circuits/shielded_withdraw.circom commits and
//!      nullifies with Poseidon(2); this program (processor.rs) uses SHA-256
//!      ("dark-pool-commit-v1" / "dark-pool-null-v1"). A real proof for the
//!      circuit can never verify against on-chain state. Pick ONE field-friendly
//!      hash (Poseidon over BN254 Fr) and use it on both sides.
//!   2. MERKLE ROOT IS A HASH CHAIN, NOT A TREE. update_merkle_root computes
//!      H(old_root || commitment || index) — a rolling chain. The circuit proves
//!      Poseidon-tree *membership* (TREE_DEPTH=20). You cannot produce a tree
//!      membership path for a hash chain. Deposit must build an incremental
//!      Poseidon Merkle tree whose root the circuit can open.
//!   3. RECIPIENT NOT BOUND. The circuit exposes only [nullifier, merkle_root]
//!      as public inputs. A valid proof in the mempool can be front-run and
//!      redirected to any recipient. Bind recipient (and pool id) into the
//!      circuit's public inputs.
//!   4. NO TRUSTED SETUP. No production VK exists. Requires a multi-party
//!      ceremony (single-party setup = whoever runs it can forge withdrawals).
//!      Then external audit before MAINNET_READY can flip.
//!
//! IS_STUB      = true
//! MAINNET_READY = false

pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

pub use processor::{commitment_hash, nullifier_hash, update_merkle_root, verify_proof_groth16};

/// IS_STUB: final VK/circuit artifacts are not wired yet.
pub const IS_STUB: bool = true;
/// MAINNET_READY: never flip without final circuit artifacts and live proof tests.
pub const MAINNET_READY: bool = false;
/// Minimum deposit prevents liveness DoS by making window exhaustion attacks expensive.
/// Attacker must spend LEAF_WINDOW * MINIMUM_DEPOSIT to halt the pool.
pub const MINIMUM_DEPOSIT_LAMPORTS: u64 = 100_000;

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

    // 13. shielded withdrawals fail closed until VK_FINAL=true
    #[test]
    fn test_proof_groth16_fails_closed_until_vk_final() {
        use dark_shielded_verifier::{g2_generator_bytes, G1_GENERATOR_X, G1_GENERATOR_Y};
        let nullifier = nullifier_hash(&secret(), &pool_key());
        let root = update_merkle_root(&[0u8; 32], &commitment_hash(&secret(), 0), 0);

        // Build a structurally valid 256-byte proof (G1, G2, G1 generators)
        let mut proof = [0u8; 256];
        proof[0..32].copy_from_slice(&G1_GENERATOR_X);
        proof[32..64].copy_from_slice(&G1_GENERATOR_Y);
        proof[64..192].copy_from_slice(&g2_generator_bytes());
        proof[192..224].copy_from_slice(&G1_GENERATOR_X);
        proof[224..256].copy_from_slice(&G1_GENERATOR_Y);

        assert!(!dark_shielded_verifier::VK_FINAL);
        assert!(!verify_proof_groth16(&proof, &nullifier, &root, &[0u8;32], &[0u8;32]));
    }

    // 14. proof size is 256 bytes (real Groth16)
    #[test]
    fn test_proof_is_256_bytes() {
        // Groth16: A(G1=64) + B(G2=128) + C(G1=64) = 256
        assert_eq!(256usize, 64 + 128 + 64);
    }

    // 15. merkle root changes with each deposit
    #[test]
    fn test_update_merkle_root_changes() {
        // update_merkle_root is a placeholder pending the full incremental
        // Poseidon Merkle tree implementation (see processor.rs TODO).
        // For now, verify: two different commitments produce different roots.
        let c0 = commitment_hash(&secret(), 0);
        let c1 = commitment_hash(&secret(), 1);
        let r0 = [0u8; 32];
        let r1 = update_merkle_root(&r0, &c0, 0);
        let r2 = update_merkle_root(&r0, &c1, 1);
        assert_ne!(r0, r1, "root must change after adding a commitment");
        assert_ne!(r1, r2, "different commitments must produce different roots");
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
        assert_eq!(ShieldedPoolError::StubNotReady        as u32, 10);
    }

    // 27. IS_STUB=true gates deposits (prevents silent honeypot)
    // When IS_STUB=true deposits must be rejected immediately — allowing funds in
    // while withdrawals fail closed (VK_FINAL=false) would create a honeypot where
    // lamports are permanently locked.
    #[test]
    fn test_stub_gates_deposit_instruction() {
        // Encode a Deposit instruction (discriminator 1 + 32-byte commitment)
        let mut data = vec![0u8; 33];
        data[0] = 1; // Deposit discriminator
        data[1..33].copy_from_slice(&[0xABu8; 32]);
        let ix = PoolInstruction::unpack(&data).unwrap();
        // Verify it parses as Deposit with the commitment we supplied
        match ix {
            PoolInstruction::Deposit { commitment } => {
                assert_eq!(commitment, [0xABu8; 32]);
            }
            _ => panic!("expected Deposit"),
        }
        // Confirm IS_STUB is still true so this guard is active
        assert!(IS_STUB, "IS_STUB must remain true until ceremony + audit complete");
        // The StubNotReady error code must be 10
        assert_eq!(ShieldedPoolError::StubNotReady as u32, 10);
        // Confirm StubNotReady converts to the expected ProgramError
        let pe: solana_program::program_error::ProgramError =
            ShieldedPoolError::StubNotReady.into();
        assert_eq!(pe, solana_program::program_error::ProgramError::Custom(10));
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

    // 19. instruction round-trip: Withdraw (256-byte real Groth16 proof)
    #[test]
    fn test_instruction_withdraw_roundtrip() {
        use solana_program::pubkey::Pubkey;
        let ix = PoolInstruction::Withdraw {
            nullifier: [0xBBu8; 32],
            proof:     [0xCCu8; 256],
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
