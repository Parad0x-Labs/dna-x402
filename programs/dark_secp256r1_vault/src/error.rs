use solana_program::program_error::ProgramError;

#[derive(Debug, Clone, Copy)]
pub enum VaultError {
    /// secp256r1 precompile reported a verification failure.
    InvalidAssertion,
    /// A vault PDA for this wallet + credential already exists.
    VaultAlreadyRegistered,
    /// The provided signature is from a different passkey credential.
    WrongCredentialId,
    /// The challenge hash has already been consumed (replay prevention).
    ReplayedChallenge,
    /// No vault PDA exists for the given wallet + credential.
    VaultNotFound,
    /// Instruction data is malformed or the discriminant is unknown.
    InvalidInstruction,
    /// The caller is not the wallet owner recorded in the vault.
    NotOwner,
}

impl From<VaultError> for ProgramError {
    fn from(e: VaultError) -> Self {
        ProgramError::Custom(match e {
            VaultError::InvalidAssertion      => 0x4001,
            VaultError::VaultAlreadyRegistered => 0x4002,
            VaultError::WrongCredentialId     => 0x4003,
            VaultError::ReplayedChallenge     => 0x4004,
            VaultError::VaultNotFound         => 0x4005,
            VaultError::InvalidInstruction    => 0x4006,
            VaultError::NotOwner              => 0x4007,
        })
    }
}
