use solana_program::program_error::ProgramError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum ShieldedPoolError {
    /// Pool already initialised.
    AlreadyInitialized  = 0,
    /// Pool is paused.
    PoolPaused          = 1,
    /// Commitment is all-zeros.
    ZeroCommitment      = 2,
    /// Nullifier has already been spent.
    NullifierAlreadySpent = 3,
    /// ZK proof verification failed.
    ProofInvalid        = 4,
    /// Denomination is zero.
    ZeroDenomination    = 5,
    /// Pool vault has insufficient lamports.
    InsufficientFunds   = 6,
    /// Pool is not initialised.
    NotInitialized      = 7,
    /// Instruction data is malformed.
    InvalidInstruction  = 8,
    /// Arithmetic overflow.
    ArithmeticOverflow  = 9,
    /// IS_STUB=true: deposits are disabled until ceremony and audit are complete.
    /// dark_shielded_pool: IS_STUB=true — deposits disabled until ceremony + audit complete.
    /// No funds will be accepted. The ZK circuit, hash scheme, and verifying key
    /// are all in draft state and withdrawals will fail closed regardless.
    StubNotReady        = 10,
    /// Deposit amount is below the minimum required to prevent liveness DoS.
    BelowMinimumDeposit = 11,
    /// The Merkle root the proof was generated against is not the current root
    /// nor any of the recent roots the pool tracks.
    UnknownRoot = 12,
    /// The relayer `fee` exceeds the pool denomination (would underflow the
    /// recipient payout). The v3 circuit also rejects this, but we fail closed
    /// before the subtraction.
    FeeExceedsDenomination = 13,
}

impl From<ShieldedPoolError> for ProgramError {
    fn from(e: ShieldedPoolError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

impl core::fmt::Display for ShieldedPoolError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "ShieldedPoolError({})", *self as u32)
    }
}
