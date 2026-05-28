//! dark-secp256r1-vault — On-chain P-256 passkey assertion verification + agent vault binding
//!
//! Binds a WebAuthn/passkey credential (secp256r1 / P-256) to a Solana agent public key.
//! Each vault is uniquely identified by the wallet pubkey and the SHA-256 of the credential ID.
//!
//! Production flow (IS_MAINNET_READY = true):
//!   1. The transaction includes a secp256r1 precompile instruction (SIMD-0075).
//!   2. The precompile verifies the P-256 signature and writes its result to the
//!      Secp256r1SigVerify sysvar before this instruction runs.
//!   3. This program trusts the tx-level ordering: if the precompile instruction is
//!      present and successful, the P-256 assertion is valid.
//!
//! Devnet flow (IS_MAINNET_READY = false):
//!   Signature verification is skipped.  The program trusts the client-supplied fields.
//!
//! Instruction layout:
//!   0x01  RegisterPasskeyVault  [agent_pubkey[32], credential_id_hash[32],
//!                                challenge_hash[32], p256_pubkey_x[32], p256_pubkey_y[32]]
//!   0x02  VerifyPasskeySignal   [challenge_hash[32], new_challenge_hash[32]]
//!   0x03  RevokePasskeyVault

use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    pubkey::Pubkey,
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
