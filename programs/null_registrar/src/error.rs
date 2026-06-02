use solana_program::program_error::ProgramError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum RegistrarError {
    /// 0x7001 — domain name is already taken
    NameAlreadyRegistered = 0x7001,
    /// 0x7002 — name exceeds 32 printable characters
    NameTooLong           = 0x7002,
    /// 0x7003 — caller's NULL balance is insufficient
    InsufficientNullBalance = 0x7003,
    /// 0x7004 — caller is not the current domain owner
    NotOwner              = 0x7004,
    /// 0x7005 — name contains characters outside [a-z0-9-]
    InvalidName           = 0x7005,
}

impl From<RegistrarError> for ProgramError {
    fn from(e: RegistrarError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
