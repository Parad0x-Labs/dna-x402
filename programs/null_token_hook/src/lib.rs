//! null-token-hook — Token-2022 Transfer Hook for NULL token ZK-gating
//!
//! When a NULL token (Token-2022) transfer occurs, this hook checks whether the
//! source owner holds a verified agent passport allowlist entry.  If they do,
//! the transfer proceeds unconditionally.  If not, the hook falls back to a
//! dark-pool limit gate: amounts above `dark_pool_limit_atomic` are rejected
//! (when that limit is non-zero).
//!
//! Instruction layout:
//!   0x9e22_2c78_0a62_3dab  Execute          [amount: u64]                 (16 bytes total)
//!   0x02                   InitConfig       [dark_pool_limit_atomic: u64]  (9 bytes)
//!   0x03                   AddToAllowlist   [flags: u64]                   (9 bytes)
//!   0x04                   RemoveFromAllowlist                              (1 byte)
//!
//! IS_MAINNET_READY = false — devnet only.

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
