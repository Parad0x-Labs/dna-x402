use solana_program::program_error::ProgramError;
use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum DarkChaffError {
    #[error("payer must sign and be writable")]
    MissingPayerSignature,
    #[error("batch PDA does not match derived address")]
    InvalidBatchPda,
    #[error("intent PDA does not match derived address")]
    InvalidIntentPda,
    #[error("system program missing or incorrect")]
    MissingSystemProgram,
    #[error("count must be between 3 and 7")]
    InvalidCount,
    #[error("cannot close a batch from a future epoch")]
    FutureEpoch,
    #[error("batch not yet initialized")]
    UninitializedBatch,
    #[error("arithmetic overflow")]
    ArithmeticOverflow,
    #[error("invalid instruction data")]
    InvalidInstruction,
}

impl From<DarkChaffError> for ProgramError {
    fn from(e: DarkChaffError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
