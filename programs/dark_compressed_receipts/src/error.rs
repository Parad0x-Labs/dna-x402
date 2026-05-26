use solana_program::program_error::ProgramError;
use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ReceiptError {
    #[error("authority must sign")]
    MissingAuthority,
    #[error("root PDA does not match derived address")]
    InvalidRootPda,
    #[error("nullifier PDA does not match derived address")]
    InvalidNullifierPda,
    #[error("system program missing or incorrect")]
    MissingSystemProgram,
    #[error("receipt already redeemed")]
    AlreadyRedeemed,
    #[error("arithmetic overflow")]
    ArithmeticOverflow,
    #[error("invalid instruction data")]
    InvalidInstruction,
    #[error("root account not yet initialized")]
    UninitializedRoot,
    #[error("signer is not the root authority")]
    WrongAuthority,
}

impl From<ReceiptError> for ProgramError {
    fn from(e: ReceiptError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
