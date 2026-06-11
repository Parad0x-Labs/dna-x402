use solana_program::program_error::ProgramError;

#[derive(Debug, Clone, PartialEq)]
#[repr(u32)]
pub enum RitualHookError {
    MissingRitualGate = 0, // no VerifyRitualShape instruction in tx
    WrongRitualType = 1,   // ritual type != AgentSpendNoCustodyV1
    WrongRitualHash = 2,   // ritual hash mismatch
    MissingMemo = 3,       // no SPL Memo instruction
    ForbiddenProgram = 4,  // forbidden program in tx instructions
    NotProduction = 5,     // always — devnet only
    InvalidInstructionData = 6,
    InvalidAccountData = 7,
    MissingRequiredAccount = 8,
    NotTransferring = 9, // Execute invoked outside a genuine Token-2022 transfer
}

impl From<RitualHookError> for ProgramError {
    fn from(e: RitualHookError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
