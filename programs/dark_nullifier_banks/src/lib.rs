pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

pub use processor::bank_index;

pub const BANK_SEED: &[u8] = b"null_bank";
pub const NULL_REC_SEED: &[u8] = b"null_rec";
pub const DOMAIN: &[u8] = b"dark_null_v1";

#[cfg(not(feature = "no-entrypoint"))]
mod entrypoint {
    use crate::processor::process;
    use solana_program::{
        account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey,
    };
    entrypoint!(process_instruction);
    fn process_instruction(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        data: &[u8],
    ) -> ProgramResult {
        process(program_id, accounts, data)
    }
}
