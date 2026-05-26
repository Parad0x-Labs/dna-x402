use solana_program::program_error::ProgramError;
use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ScratchError {
    #[error("invalid instruction data")]
    InvalidInstruction,
    #[error("scratch PDA does not match derived address")]
    InvalidPda,
    #[error("owner must sign")]
    MissingOwnerSignature,
    #[error("scratch account not yet expired")]
    NotExpired,
    #[error("system program missing")]
    MissingSystemProgram,
    #[error("arithmetic overflow")]
    ArithmeticOverflow,
}

impl From<ScratchError> for ProgramError {
    fn from(e: ScratchError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
