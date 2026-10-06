use solana_program::program_error::ProgramError;

#[derive(Debug, Clone, Copy)]
pub enum AuthError {
    /// The precompile-verified signature differs from r/s/recovery_id in the instruction.
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
    /// msg_hash in the instruction is not keccak256 of the precompile-verified message.
    MessageMismatch,
    /// The precompile-verified message is not the canonical binding message for
    /// this program, the agent signer, the ETH address, domain_hash and auth_hash
    /// (e.g. a signature made for another agent replayed to squat the address).
    BindingMessageMismatch,
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
            AuthError::MessageMismatch        => 0x5009,
            AuthError::BindingMessageMismatch => 0x500A,
        })
    }
}
