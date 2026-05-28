//! dark-semaphore — On-chain Semaphore group registry + nullifier store
//!
//! Implements the on-chain side of the Semaphore anonymous signaling protocol
//! for NULL Miner DePIN task groups.
//!
//! Off-chain (TypeScript SDK):
//!   - Identity commitment = Poseidon2([nullifier, trapdoor])
//!   - Merkle tree maintained by the SDK (IncrementalMerkleTree)
//!   - Nullifier hash = Poseidon2([nullifier, externalNullifier])
//!
//! On-chain (this program):
//!   - GroupRecord PDA: stores Merkle root + depth + member count
//!   - NullifierRecord PDA: marks a nullifier hash as spent (replay prevention)
//!   - Admin can update the Merkle root after off-chain insertion
//!
//! Devnet deployment: externally-verified pattern.
//! Full ZK: replace Signal instruction with a Groth16 proof verification
//! via the dark_bn254_gate program (post-audit, pending circuit compile).
//!
//! Instruction layout:
//!   0x01  InitGroup   [depth: u8, root: [u8; 32]]              → create GroupRecord PDA
//!   0x02  UpdateRoot  [new_root: [u8; 32]]                     → admin updates root
//!   0x03  Signal      [nullifier_hash: [u8; 32],               → consume nullifier,
//!                      ext_nullifier:  [u8; 32],                  record signal
//!                      signal_hash:    [u8; 32]]

use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey,
};

pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    data:       &[u8],
) -> ProgramResult {
    processor::process(program_id, accounts, data)
}
