use solana_program::program_error::ProgramError;

#[derive(Debug, Clone, Copy)]
pub enum LiveAttestationError {
    /// Session already exists for this session_id.
    SessionAlreadyExists,
    /// Session not found or wrong PDA.
    SessionNotFound,
    /// Session is already ended.
    SessionEnded,
    /// Caller is not the session's streamer.
    NotStreamer,
    /// Invalid attestation level (must be 1, 2, or 3).
    InvalidAttestationLevel,
    /// Instruction data has wrong length.
    InvalidInstructionData,
    /// Batch timestamp range is invalid.
    InvalidBatchTimestamp,
}

impl From<LiveAttestationError> for ProgramError {
    fn from(e: LiveAttestationError) -> Self {
        ProgramError::Custom(match e {
            LiveAttestationError::SessionAlreadyExists    => 0x6001,
            LiveAttestationError::SessionNotFound         => 0x6002,
            LiveAttestationError::SessionEnded            => 0x6003,
            LiveAttestationError::NotStreamer             => 0x6004,
            LiveAttestationError::InvalidAttestationLevel => 0x6005,
            LiveAttestationError::InvalidInstructionData  => 0x6006,
            LiveAttestationError::InvalidBatchTimestamp   => 0x6007,
        })
    }
}
