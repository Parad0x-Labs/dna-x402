use solana_program::program_error::ProgramError;

#[derive(Debug, Clone, Copy)]
pub enum AuthError {
    /// secp256k1 precompile reported a verification failure or was absent.
    InvalidSignature,
    /// An EthAgentRecord already exists for this ETH address.
    AgentAlreadyRegistered,
    /// The signature's recovered address does not match the supplied pda_seed.
    AddressMismatch,
    /// Instruction data is malformed or the discriminant is unknown.
    InvalidInstruction,
    /// No EthAgentRecord found for the given ETH address.
    AgentNotFound,
    /// The caller is not the agent_pubkey stored in the record.
    NotOwner,
    /// The secp256k1 precompile instruction data is malformed.
    MalformedPrecompile,
    /// The precompile-verified ETH address doesn't match the supplied pda_seed.
    EthAddressMismatch,
}

impl From<AuthError> for ProgramError {
    fn from(e: AuthError) -> Self {
        ProgramError::Custom(match e {
            AuthError::InvalidSignature       => 0x5001,
            AuthError::AgentAlreadyRegistered => 0x5002,
            AuthError::AddressMismatch        => 0x5003,
            AuthError::InvalidInstruction     => 0x5004,
            AuthError::AgentNotFound          => 0x5005,
            AuthError::NotOwner               => 0x5006,
            AuthError::MalformedPrecompile    => 0x5007,
            AuthError::EthAddressMismatch     => 0x5008,
        })
    }
}
