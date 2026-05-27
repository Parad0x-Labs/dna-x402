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
