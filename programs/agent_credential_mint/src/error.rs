//! agent-credential-mint errors

use solana_program::program_error::ProgramError;

#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CredentialError {
    /// Program is not yet mainnet-ready; Token-2022 CPIs are disabled
    NotMainnetReady = 0x9001,
    /// A credential has already been issued for this agent_pubkey
    AlreadyIssued = 0x9002,
    /// No CredentialRecord PDA found for the given agent_pubkey
    CredentialNotFound = 0x9003,
    /// Credential has already been revoked
    AlreadyRevoked = 0x9004,
    /// Instruction data is too short or malformed
    InvalidInstructionData = 0x9005,
    /// binding_type byte is not 0x01 (secp256r1) or 0x02 (secp256k1)
    InvalidBindingType = 0x9006,
    /// Caller does not have the required authority (protocol_authority or agent wallet)
    Unauthorized = 0x9007,
    /// The old_device_pubkey in UpgradeCredential does not match the stored record
    DevicePubkeyMismatch = 0x9008,
    /// x402 receipt hash verification failed (IS_MAINNET_READY = true only)
    InvalidX402Receipt = 0x9009,
    /// Account data length does not match expected CredentialRecord layout
    InvalidAccountSize = 0x900A,
}

impl From<CredentialError> for ProgramError {
    fn from(e: CredentialError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
