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
    /// FallbackDraw: the config asks for a no-winner streak longer than the
    /// three consecutive rounds FallbackDraw takes (fallback_after > 3).
    FallbackNotReady,
    /// The claimed ticket's numbers are not the round's drawn numbers.
    TicketNotWinning,
    /// The claimed ticket (claimant key, numbers, nullifier) is not at
    /// leaf_index < ticket_count under the anchored tickets_root, or no ticket
    /// proof was supplied for a Drawn round.
    InvalidTicketProof,
    /// FallbackDraw: fallback_tickets_root / fallback_pool_size are not the
    /// third round's anchored tickets_root / ticket_count, or that set is empty.
    FallbackPoolMismatch,
    /// ClaimJackpot on a FallbackDrawn round: leaf_index is not the ticket the
    /// fallback selected.
    NotFallbackWinner,
    /// FallbackDraw: the three rounds are not consecutive round ids.
    FallbackRoundsNotConsecutive,
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
            LotteryError::TicketNotWinning    => 0x600A,
            LotteryError::InvalidTicketProof  => 0x600B,
            LotteryError::FallbackPoolMismatch => 0x600C,
            LotteryError::NotFallbackWinner   => 0x600D,
            LotteryError::FallbackRoundsNotConsecutive => 0x600E,
        })
    }
}
