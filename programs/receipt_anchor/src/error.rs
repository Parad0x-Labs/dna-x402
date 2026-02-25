use solana_program::program_error::ProgramError;
use thiserror::Error;

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum ReceiptAnchorError {
    #[error("Invalid instruction payload")]
    InvalidInstruction,
    #[error("Invalid instruction version")]
    InvalidVersion,
    #[error("Invalid anchor batch length")]
    InvalidBatchLength,
    #[error("Invalid bucket PDA")]
    InvalidBucketPda,
    #[error("Missing payer signature")]
    MissingPayerSignature,
    #[error("Missing writable bucket account")]
    InvalidBucketAccount,
    #[error("Missing system program account")]
    MissingSystemProgram,
    #[error("Bucket account state mismatch")]
    BucketStateMismatch,
    #[error("Arithmetic overflow")]
    ArithmeticOverflow,
}

impl From<ReceiptAnchorError> for ProgramError {
    fn from(error: ReceiptAnchorError) -> Self {
        ProgramError::Custom(error as u32)
    }
}
