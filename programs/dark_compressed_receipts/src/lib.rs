pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

pub const ROOT_SEED: &[u8] = b"receipt_root";
pub const NULL_SEED: &[u8] = b"receipt_null";

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
