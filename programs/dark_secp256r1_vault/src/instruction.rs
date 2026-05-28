use crate::error::VaultError;
use solana_program::program_error::ProgramError;

/// Parsed instructions for the dark-secp256r1-vault program.
pub enum VaultInstruction {
    /// Register a new passkey vault, binding a P-256 credential to an agent pubkey.
    ///
    /// Data: [0x01,
    ///        agent_pubkey[32],
    ///        credential_id_hash[32],
    ///        challenge_hash[32],
    ///        p256_pubkey_x[32],
    ///        p256_pubkey_y[32]]  = 1 + 160 = 161 bytes
    ///
    /// Accounts:
    ///   [0] vault_pda       (writable)
    ///   [1] wallet_owner    (signer + writable)
    ///   [2] system_program
    RegisterPasskeyVault {
        agent_pubkey:       [u8; 32],
        credential_id_hash: [u8; 32],
        challenge_hash:     [u8; 32],
        p256_pubkey_x:      [u8; 32],
        p256_pubkey_y:      [u8; 32],
    },

    /// Verify a passkey signal: consume the current challenge and set a new one.
    /// Prevents replay of the same WebAuthn assertion.
    ///
    /// Data: [0x02, challenge_hash[32], new_challenge_hash[32]] = 65 bytes
    ///
    /// Accounts:
    ///   [0] vault_pda     (writable)
    ///   [1] wallet_owner  (signer)
    VerifyPasskeySignal {
        challenge_hash:     [u8; 32],
        new_challenge_hash: [u8; 32],
    },

    /// Revoke the vault, zeroing the on-chain record.
    ///
    /// Data: [0x03] = 1 byte
    ///
    /// Accounts:
    ///   [0] vault_pda     (writable)
    ///   [1] wallet_owner  (signer)
    RevokePasskeyVault,
}

impl VaultInstruction {
    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        let (&tag, rest) = data.split_first().ok_or(VaultError::InvalidInstruction)?;
        match tag {
            0x01 => {
                if rest.len() < 160 {
                    return Err(VaultError::InvalidInstruction.into());
                }
                let mut agent_pubkey       = [0u8; 32];
                let mut credential_id_hash = [0u8; 32];
                let mut challenge_hash     = [0u8; 32];
                let mut p256_pubkey_x      = [0u8; 32];
                let mut p256_pubkey_y      = [0u8; 32];
                agent_pubkey.copy_from_slice(&rest[0..32]);
                credential_id_hash.copy_from_slice(&rest[32..64]);
                challenge_hash.copy_from_slice(&rest[64..96]);
                p256_pubkey_x.copy_from_slice(&rest[96..128]);
                p256_pubkey_y.copy_from_slice(&rest[128..160]);
                Ok(Self::RegisterPasskeyVault {
                    agent_pubkey,
                    credential_id_hash,
                    challenge_hash,
                    p256_pubkey_x,
                    p256_pubkey_y,
                })
            }
            0x02 => {
                if rest.len() < 64 {
                    return Err(VaultError::InvalidInstruction.into());
                }
                let mut challenge_hash     = [0u8; 32];
                let mut new_challenge_hash = [0u8; 32];
                challenge_hash.copy_from_slice(&rest[0..32]);
                new_challenge_hash.copy_from_slice(&rest[32..64]);
                Ok(Self::VerifyPasskeySignal { challenge_hash, new_challenge_hash })
            }
            0x03 => Ok(Self::RevokePasskeyVault),
            _ => Err(VaultError::InvalidInstruction.into()),
        }
    }
}
