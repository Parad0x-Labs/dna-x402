use solana_program::program_error::ProgramError;
use thiserror::Error;

/// Errors for the x402 refund-on-failure escrow.
///
/// Numeric codes are stable and asserted in unit tests — clients decode them.
#[derive(Error, Debug, Copy, Clone, PartialEq, Eq)]
pub enum EscrowError {
    #[error("invalid instruction")]
    InvalidInstruction = 0,
    #[error("invalid escrow account")]
    InvalidEscrowAccount = 1,
    #[error("escrow state version mismatch")]
    StateVersionMismatch = 2,
    #[error("invalid escrow PDA")]
    InvalidEscrowPda = 3,
    #[error("missing required signature")]
    MissingSignature = 4,
    #[error("missing system program")]
    MissingSystemProgram = 5,
    #[error("escrow is not in the Open state")]
    NotOpen = 6,
    #[error("escrow is not in the SettledSuccess state")]
    NotSettled = 7,
    #[error("caller is not the buyer")]
    NotBuyer = 8,
    #[error("caller is not the seller")]
    NotSeller = 9,
    #[error("settlement deadline has passed")]
    DeadlinePassed = 10,
    #[error("settlement deadline has not passed yet")]
    DeadlineNotReached = 11,
    #[error("dispute window has not passed yet")]
    DisputeWindowOpen = 12,
    /// The ed25519 precompile instruction was missing, malformed, or verified
    /// the wrong key/message — the seller's on-chain vouch does not check out.
    #[error("settlement receipt signature is invalid")]
    InvalidReceiptSignature = 13,
    /// The signed receipt's fields do not bind to this escrow.
    #[error("settlement receipt does not match this escrow")]
    ReceiptMismatch = 14,
    /// The two receipts submitted as an equivocation proof do not actually
    /// conflict (same payment_commitment, contradictory content).
    #[error("equivocation proof is not a genuine conflict")]
    NotEquivocation = 15,
    #[error("arithmetic overflow")]
    ArithmeticOverflow = 16,
    #[error("amount must be non-zero")]
    ZeroAmount = 17,
    #[error("insufficient escrow balance")]
    InsufficientBalance = 18,
}

impl From<EscrowError> for ProgramError {
    fn from(e: EscrowError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
