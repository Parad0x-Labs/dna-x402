//! dark-secp256k1-auth — On-chain ETH identity binding via secp256k1 precompile
//!
//! Binds an Ethereum address (20-byte secp256k1 public key hash) to a Solana agent
//! public key, enabling cross-chain identity proofs for the NULL agent network.
//!
//! Flow (every build; the precompile binding is not feature-gated):
//!   1. The transaction includes a secp256k1 precompile instruction
//!      (program `KeccakSecp256k11111111111111111111111111111`) at index 0.
//!   2. The precompile verifies the ETH signature over its message and the
//!      ETH address it carries before this program runs.
//!   3. RegisterEthAgent reads that instruction through the instructions sysvar
//!      and requires: verified ETH address == pda_seed[12..32], verified
//!      signature == r || s || recovery_id, msg_hash == keccak256(verified
//!      message), and verified message == the canonical EIP-191 binding message
//!      (`binding::binding_message`) for this program id, the agent signer, the
//!      ETH address, domain_hash and auth_hash.
//!
//! The binding message commits to the Solana agent key, so a public ETH
//! signature cannot be replayed to bind that ETH address to a different agent.
//!
//! Accounts: RegisterEthAgent [record_pda, agent_signer, system_program,
//! instructions_sysvar]; RevokeEthAgent [record_pda, agent_signer].
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

pub mod binding;
pub mod error;
pub mod instruction;
pub mod processor;
pub mod secp256k1;
pub mod state;

entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    data:       &[u8],
) -> ProgramResult {
    processor::process(program_id, accounts, data)
}
