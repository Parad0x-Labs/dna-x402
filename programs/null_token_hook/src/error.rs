use solana_program::program_error::ProgramError;

#[derive(Debug, Clone, Copy)]
pub enum HookError {
    /// Caller did not pass the agent passport check and no fallback applies.
    NotAuthorized,
    /// Expected allowlist account was not passed or could not be read.
    AllowlistNotFound,
    /// Transfer amount exceeds the dark pool limit for unapproved addresses.
    ExceedsDarkPoolLimit,
    /// Instruction data is too short or the discriminant is unrecognised.
    InvalidInstruction,
    /// The config PDA has already been initialised.
    ConfigAlreadyExists,
    /// The caller is not the hook admin.
    NotAdmin,
}

impl From<HookError> for ProgramError {
    fn from(e: HookError) -> Self {
        ProgramError::Custom(match e {
            HookError::NotAuthorized        => 0x3001,
            HookError::AllowlistNotFound    => 0x3002,
            HookError::ExceedsDarkPoolLimit => 0x3003,
            HookError::InvalidInstruction   => 0x3004,
            HookError::ConfigAlreadyExists  => 0x3005,
            HookError::NotAdmin             => 0x3006,
        })
    }
}
