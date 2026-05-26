pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

pub const BATCH_SEED: &[u8] = b"chaff_batch";
pub const INTENT_SEED: &[u8] = b"chaff_intent";

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
