//! dark-secp256k1-auth — On-chain ETH identity binding via secp256k1 precompile
//!
//! Binds an Ethereum address (20-byte secp256k1 public key hash) to a Solana agent
//! public key, enabling cross-chain identity proofs for the NULL agent network.
//!
//! Production flow (IS_MAINNET_READY = true):
//!   1. The transaction includes a secp256k1 precompile instruction
//!      (program `KeccakSecp256k11111111111111111111111111111`).
//!   2. The precompile verifies the ETH signature over `msg_hash` and recovers
//!      the ETH address from the provided `r`, `s`, `recovery_id`.
//!   3. This program derives the EthAgentRecord PDA using the client-supplied
//!      `pda_seed` and verifies the precompile ran successfully (tx ordering).
//!
//! Devnet flow (IS_MAINNET_READY = false):
//!   Signature verification is skipped.  The `pda_seed` supplied by the client
//!   is trusted as encoding the ETH address (last 20 bytes of pda_seed).
//!
//! Instruction layout:
//!   0x01  RegisterEthAgent   [r[32], s[32], recovery_id[1], msg_hash[32],
//!                             pda_seed[32], auth_hash[32], domain_hash[32]]
//!   0x02  RevokeEthAgent     [eth_address[20]]

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
