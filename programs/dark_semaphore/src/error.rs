use solana_program::program_error::ProgramError;

#[derive(Debug, Clone, Copy)]
pub enum SemaphoreError {
    /// Instruction data too short or malformed.
    InvalidInstruction,
    /// The group has not been initialized.
    GroupNotFound,
    /// Nullifier has already been used in this group.
    NullifierAlreadyUsed,
    /// Caller is not the group admin.
    NotAdmin,
    /// Merkle tree depth out of supported range [1, 32].
    InvalidDepth,
    /// Account is too small for the expected state.
    AccountTooSmall,
    /// Signal called in mainnet mode but the ZK circuit (dark_bn254_gate) is not wired.
    ZkNotWired,
}

impl From<SemaphoreError> for ProgramError {
    fn from(e: SemaphoreError) -> Self {
        ProgramError::Custom(e as u32 + 1)
    }
}
