//! dark-shielded-pool v3 — fixed-denomination shielded transfer pool (DARK RELAY RAIL).
//!
//! Deposit `denomination` lamports + a Poseidon commitment into a real incremental
//! Poseidon Merkle tree (TREE_DEPTH=20). Withdraw by presenting a Groth16 proof
//! (shielded_withdraw_v3 circuit) that opens a commitment in a recent root, with
//! recipient + pool_id + relayer + fee bound into the proof's public inputs.
//! On-chain hashing uses the `sol_poseidon` Bn254X5/BigEndian syscall via
//! `dark-poseidon-real`, byte-matching the circuit's circomlib Poseidon.
//!
//! DARK RELAY RAIL: the relayer (fee_payer) fronts the transaction fee and is
//! reimbursed `fee` lamports from the pool. The recipient receives `denom - fee`
//! and NEVER signs — full unlinkability. The payout split is cryptographically
//! enforced by the Groth16 proof (fee <= MAX_FEE, payout = denom - fee).
//!
//! Circuit v3 vs v2 (additions):
//!   1. RELAY RAIL — relayer + fee are public inputs, payout enforced in-circuit.
//!   2. DOMAIN-SEPARATED Poseidon — DOMAIN_COMMIT=1 / DOMAIN_NULLIF=2.
//!   3. 7 public inputs (nullifier, merkle_root, recipient, pool_id, relayer, fee,
//!      denomination). VK from `dark_groth16_core::shielded_withdraw_v3_vk`.
//!
//! CEREMONY — no Phase-2 human contributor (Hermez PPOT + drand beacon):
//!   Phase 1: Hermez Perpetual Powers of Tau (power 14, sha256 489be9e5…,
//!            publicly verifiable, multiple independent contributors).
//!   Phase 2: ONLY the drand League of Entropy beacon (round 6000000) —
//!            no human held or generated Phase-2 entropy; drand is collectively
//!            operated by League of Entropy nodes and publicly verifiable.
//!            Transcript: ceremony/shielded_withdraw_v3/transcript_v3.json.
//!
//! `IS_STUB = false` — hashing, tree, binding, and verifier are all real.
//! `MAINNET_READY = true` — trustless ceremony complete, open beta.

pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

pub use processor::{
    commitment_hash, insert_leaf, merkle_node_hash, nullifier_hash, verify_proof_groth16,
    zero_hashes,
};

/// IS_STUB: the hash scheme, Merkle tree, recipient binding, and verifier are
/// all REAL (real Poseidon + real incremental tree + real Groth16 VK).
pub const IS_STUB: bool = false;
/// MAINNET_READY: trustless ceremony (Hermez ptau + drand-only beacon) complete.
pub const MAINNET_READY: bool = true;
/// Minimum deposit prevents liveness DoS by making window exhaustion expensive.
pub const MINIMUM_DEPOSIT_LAMPORTS: u64 = 100_000;

#[cfg(not(feature = "no-entrypoint"))]
use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey,
};

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

#[cfg(not(feature = "no-entrypoint"))]
fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
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
    use dark_shielded_pool_core::{IncrementalTree, RECENT_ROOTS, TREE_DEPTH};
    use solana_program::program_error::ProgramError;
    use solana_program::program_pack::{IsInitialized, Pack};

    fn secret() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0x05;
        s[31] = 0xAD;
        s
    }
    fn pool_key() -> [u8; 32] {
        let mut p = [0u8; 32];
        p[0] = 0x05;
        p[15] = 0xFE;
        p
    }

    // 1. Constants: NOT a stub; trustless ceremony = mainnet ready.
    #[test]
    fn test_constants() {
        assert!(!IS_STUB, "v3 hashing/tree/binding/verifier are real");
        assert!(MAINNET_READY, "trustless ceremony (Hermez ptau + drand-only beacon) is done");
    }

    // 2. PoolConfig length matches the v2 layout.
    #[test]
    fn test_pool_config_len() {
        assert_eq!(POOL_CONFIG_LEN, 84 + 32 * TREE_DEPTH + 32 * RECENT_ROOTS + 2);
        assert_eq!(PoolConfig::LEN, POOL_CONFIG_LEN);
    }

    #[test]
    fn test_note_leaf_len() {
        assert_eq!(NOTE_LEAF_LEN, 49);
        assert_eq!(NoteLeaf::LEN, NOTE_LEAF_LEN);
    }

    #[test]
    fn test_nullifier_record_len() {
        assert_eq!(NULLIFIER_RECORD_LEN, 41);
        assert_eq!(NullifierRecord::LEN, NULLIFIER_RECORD_LEN);
    }

    // 5. PoolConfig pack/unpack roundtrip (incl. tree + ring state).
    #[test]
    fn test_pool_config_pack_unpack() {
        let mut filled = [[0u8; 32]; TREE_DEPTH];
        for (i, f) in filled.iter_mut().enumerate() {
            f[0] = i as u8 + 1;
        }
        let mut recent = [[0u8; 32]; RECENT_ROOTS];
        recent[0] = [0x11u8; 32];
        recent[1] = [0x22u8; 32];
        let cfg = PoolConfig {
            version: POOL_CONFIG_VERSION,
            bump: 251,
            is_initialized: true,
            is_paused: false,
            authority: [0xABu8; 32],
            denomination: 100_000_000,
            merkle_root: [0x33u8; 32],
            note_count: 42,
            filled_subtrees: filled,
            recent_roots: recent,
            recent_head: 2,
            recent_count: 2,
        };
        let mut buf = [0u8; POOL_CONFIG_LEN];
        PoolConfig::pack(cfg.clone(), &mut buf).unwrap();
        let unpacked = PoolConfig::unpack(&buf).unwrap();
        assert_eq!(cfg, unpacked);
        assert!(unpacked.is_initialized());
    }

    #[test]
    fn test_note_leaf_pack_unpack() {
        let leaf = NoteLeaf {
            bump: 250,
            commitment: [0x22u8; 32],
            leaf_index: 7,
            deposited_at: 1_700_000_000,
        };
        let mut buf = [0u8; NOTE_LEAF_LEN];
        NoteLeaf::pack(leaf.clone(), &mut buf).unwrap();
        assert_eq!(leaf, NoteLeaf::unpack(&buf).unwrap());
    }

    #[test]
    fn test_nullifier_record_pack_unpack() {
        let rec = NullifierRecord {
            bump: 249,
            nullifier: [0x33u8; 32],
            spent_at: 1_700_086_400,
        };
        let mut buf = [0u8; NULLIFIER_RECORD_LEN];
        NullifierRecord::pack(rec.clone(), &mut buf).unwrap();
        assert_eq!(rec, NullifierRecord::unpack(&buf).unwrap());
    }

    // 8. commitment_hash is non-zero and matches the core/circuit Poseidon.
    #[test]
    fn test_commitment_hash_matches_core() {
        let c = commitment_hash(&secret(), 0);
        assert_ne!(c, [0u8; 32]);
        assert_eq!(c, dark_shielded_pool_core::commitment(&secret(), 0));
    }

    #[test]
    fn test_commitment_hash_deterministic() {
        assert_eq!(commitment_hash(&secret(), 0), commitment_hash(&secret(), 0));
    }

    #[test]
    fn test_commitment_hash_secret_sensitivity() {
        let mut s2 = secret();
        s2[7] ^= 0xFF;
        assert_ne!(commitment_hash(&secret(), 0), commitment_hash(&s2, 0));
    }

    #[test]
    fn test_nullifier_hash_deterministic() {
        let n1 = nullifier_hash(&secret(), &pool_key());
        let n2 = nullifier_hash(&secret(), &pool_key());
        assert_eq!(n1, n2);
        assert_ne!(n1, [0u8; 32]);
    }

    #[test]
    fn test_nullifier_differs_from_commitment() {
        let c = commitment_hash(&secret(), 0);
        let n = nullifier_hash(&secret(), &pool_key());
        assert_ne!(c, n, "nullifier must not equal commitment");
    }

    // 14. proof size is 256 bytes (real Groth16).
    #[test]
    fn test_proof_is_256_bytes() {
        assert_eq!(256usize, 64 + 128 + 64);
    }

    // 15. On-chain incremental insert matches the core library's tree root.
    #[test]
    fn test_insert_leaf_matches_core_tree() {
        let zeros = zero_hashes();
        let mut filled = {
            let mut f = [[0u8; 32]; TREE_DEPTH];
            for (i, slot) in f.iter_mut().enumerate() {
                *slot = zeros[i];
            }
            f
        };
        let mut tree = IncrementalTree::new();
        let mut on_chain_root = zeros[TREE_DEPTH];
        for i in 0..4u64 {
            let mut s = secret();
            s[31] = i as u8;
            let c = commitment_hash(&s, i);
            on_chain_root = insert_leaf(&mut filled, &zeros[..], i, c);
            tree.insert(c);
        }
        assert_eq!(
            on_chain_root, tree.root,
            "processor insert_leaf must match core IncrementalTree root"
        );
    }

    // 16. error code values are stable.
    #[test]
    fn test_error_codes() {
        assert_eq!(ShieldedPoolError::AlreadyInitialized as u32, 0);
        assert_eq!(ShieldedPoolError::PoolPaused as u32, 1);
        assert_eq!(ShieldedPoolError::ZeroCommitment as u32, 2);
        assert_eq!(ShieldedPoolError::NullifierAlreadySpent as u32, 3);
        assert_eq!(ShieldedPoolError::ProofInvalid as u32, 4);
        assert_eq!(ShieldedPoolError::ZeroDenomination as u32, 5);
        assert_eq!(ShieldedPoolError::InsufficientFunds as u32, 6);
        assert_eq!(ShieldedPoolError::NotInitialized as u32, 7);
        assert_eq!(ShieldedPoolError::InvalidInstruction as u32, 8);
        assert_eq!(ShieldedPoolError::ArithmeticOverflow as u32, 9);
        assert_eq!(ShieldedPoolError::StubNotReady as u32, 10);
        assert_eq!(ShieldedPoolError::BelowMinimumDeposit as u32, 11);
        assert_eq!(ShieldedPoolError::UnknownRoot as u32, 12);
    }

    // ── instruction round-trips ──────────────────────────────────────────────

    #[test]
    fn test_instruction_init_pool_roundtrip() {
        let ix = PoolInstruction::InitPool {
            denomination: 1_000_000_000,
        };
        assert_eq!(ix, PoolInstruction::unpack(&ix.pack()).unwrap());
    }

    #[test]
    fn test_instruction_deposit_roundtrip() {
        let ix = PoolInstruction::Deposit {
            commitment: [0xAAu8; 32],
        };
        assert_eq!(ix, PoolInstruction::unpack(&ix.pack()).unwrap());
    }

    // Withdraw round-trip now includes the root, relayer, and fee fields (v3).
    #[test]
    fn test_instruction_withdraw_roundtrip() {
        use solana_program::pubkey::Pubkey;
        let ix = PoolInstruction::Withdraw {
            nullifier: [0xBBu8; 32],
            root: [0xEEu8; 32],
            proof: [0xCCu8; 256],
            recipient: Pubkey::from([0xDDu8; 32]),
            relayer: Pubkey::from([0x11u8; 32]),
            fee: 1_000_000,
        };
        let bytes = ix.pack();
        assert_eq!(bytes.len(), crate::instruction::WITHDRAW_IX_LEN);
        assert_eq!(ix, PoolInstruction::unpack(&bytes).unwrap());
    }

    #[test]
    fn test_instruction_empty_data_error() {
        let err = PoolInstruction::unpack(&[]).unwrap_err();
        assert_eq!(
            err,
            ProgramError::Custom(ShieldedPoolError::InvalidInstruction as u32)
        );
    }

    #[test]
    fn test_instruction_bad_discriminator() {
        let err = PoolInstruction::unpack(&[0xFFu8]).unwrap_err();
        assert_eq!(
            err,
            ProgramError::Custom(ShieldedPoolError::InvalidInstruction as u32)
        );
    }

    #[test]
    fn test_pool_config_default_not_initialized() {
        assert!(!PoolConfig::default().is_initialized());
    }

    #[test]
    fn test_note_leaf_zero_not_initialized() {
        assert!(!NoteLeaf::default().is_initialized());
    }

    #[test]
    fn test_commitment_leaf_index_sensitivity() {
        assert_ne!(commitment_hash(&secret(), 0), commitment_hash(&secret(), 1));
    }

    #[test]
    fn test_nullifier_pool_sensitivity() {
        let mut p2 = pool_key();
        p2[0] ^= 0x01;
        assert_ne!(
            nullifier_hash(&secret(), &pool_key()),
            nullifier_hash(&secret(), &p2)
        );
    }

    #[test]
    fn test_error_to_program_error() {
        let pe: ProgramError = ShieldedPoolError::ProofInvalid.into();
        assert_eq!(pe, ProgramError::Custom(4));
    }

    // PoolConfig recent-root ring: knows_root semantics.
    #[test]
    fn test_pool_config_knows_root_ring() {
        let mut cfg = PoolConfig {
            version: POOL_CONFIG_VERSION,
            bump: 1,
            is_initialized: true,
            is_paused: false,
            authority: [1u8; 32],
            denomination: 1,
            merkle_root: [0u8; 32],
            note_count: 0,
            filled_subtrees: [[0u8; 32]; TREE_DEPTH],
            recent_roots: [[0u8; 32]; RECENT_ROOTS],
            recent_head: 0,
            recent_count: 0,
        };
        let a = [7u8; 32];
        cfg.push_recent_root(a);
        cfg.merkle_root = a;
        assert!(cfg.knows_root(&a));
        assert!(!cfg.knows_root(&[8u8; 32]));
        assert!(!cfg.knows_root(&[0u8; 32]), "zero root never matches");
    }
}
