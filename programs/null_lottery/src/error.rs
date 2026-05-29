use solana_program::program_error::ProgramError;

#[derive(Debug, Clone, Copy)]
pub enum LotteryError {
    /// Instruction data is malformed or the discriminant is unknown.
    InvalidInstruction,
    /// LotteryConfig has already been initialized.
    AlreadyInitialized,
    /// The requested round was not found.
    RoundNotFound,
    /// SHA-256(seed) does not match the stored commitment.
    InvalidSeed,
    /// This winning ticket has already been claimed.
    AlreadyClaimed,
    /// The supplied nullifier does not match the round winner.
    InvalidWinner,
    /// The round is not in the required status for this instruction.
    WrongStatus,
    /// The caller is not the stored admin.
    NotAdmin,
    /// no_winner_count < fallback_after; fallback not yet available.
    FallbackNotReady,
}

impl From<LotteryError> for ProgramError {
    fn from(e: LotteryError) -> Self {
        ProgramError::Custom(match e {
            LotteryError::InvalidInstruction  => 0x6001,
            LotteryError::AlreadyInitialized  => 0x6002,
            LotteryError::RoundNotFound       => 0x6003,
            LotteryError::InvalidSeed         => 0x6004,
            LotteryError::AlreadyClaimed      => 0x6005,
            LotteryError::InvalidWinner       => 0x6006,
            LotteryError::WrongStatus         => 0x6007,
            LotteryError::NotAdmin            => 0x6008,
            LotteryError::FallbackNotReady    => 0x6009,
        })
    }
}
