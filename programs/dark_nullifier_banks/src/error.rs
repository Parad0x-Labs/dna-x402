use solana_program::program_error::ProgramError;
use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum DarkNullError {
    #[error("payer must sign and be writable")]
    MissingPayerSignature,
    #[error("bank account must be writable")]
    InvalidBankAccount,
    #[error("bank PDA does not match derived address")]
    InvalidBankPda,
    #[error("nullifier record PDA does not match derived address")]
    InvalidNullifierRecordPda,
    #[error("system program account missing or incorrect")]
    MissingSystemProgram,
    #[error("nullifier hashes to a different shard than submitted bank")]
    WrongShard,
    #[error("nullifier already inserted (duplicate spend attempt)")]
    DuplicateNullifier,
    #[error("arithmetic overflow in bank count")]
    ArithmeticOverflow,
    #[error("invalid instruction data")]
    InvalidInstructionData,
}

impl From<DarkNullError> for ProgramError {
    fn from(e: DarkNullError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
