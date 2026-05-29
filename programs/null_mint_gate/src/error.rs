use solana_program::program_error::ProgramError;

#[derive(Debug, Clone, Copy)]
pub enum MintGateError {
    /// Instruction data is malformed or the discriminant is unknown.
    InvalidInstruction,
    /// EmissionConfig has already been initialized.
    AlreadyInitialized,
    /// This nullifier has already been claimed — double-spend rejected.
    AlreadyClaimed,
    /// Requested emission amount exceeds max_null_per_claim_atomic.
    ExceedsClaimLimit,
    /// Minting this amount would exceed the epoch NULL cap.
    EpochCapExceeded,
    /// The emission gate is currently inactive.
    MintGateNotActive,
    /// The caller is not the stored admin.
    NotAdmin,
    /// new_epoch must be strictly greater than current_epoch.
    EpochAlreadyAdvanced,
}

impl From<MintGateError> for ProgramError {
    fn from(e: MintGateError) -> Self {
        ProgramError::Custom(match e {
            MintGateError::InvalidInstruction   => 0x7001,
            MintGateError::AlreadyInitialized   => 0x7002,
            MintGateError::AlreadyClaimed       => 0x7003,
            MintGateError::ExceedsClaimLimit    => 0x7004,
            MintGateError::EpochCapExceeded     => 0x7005,
            MintGateError::MintGateNotActive    => 0x7006,
            MintGateError::NotAdmin             => 0x7007,
            MintGateError::EpochAlreadyAdvanced => 0x7008,
        })
    }
}
