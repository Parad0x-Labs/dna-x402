//! agent-credential-mint instruction unpacking

use solana_program::program_error::ProgramError;
use crate::{error::CredentialError, state::BindingType};

// Instruction byte lengths (excluding 1-byte discriminant)
//   IssueCredential:   32 + 33 + 1 + 32 = 98
//   RevokeCredential:  32
//   UpgradeCredential: 33 + 33 + 32 = 98

const ISSUE_PAYLOAD_LEN:   usize = 98;
const REVOKE_PAYLOAD_LEN:  usize = 32;
const UPGRADE_PAYLOAD_LEN: usize = 98;

#[derive(Debug, PartialEq)]
pub enum CredentialInstruction {
    /// 0x01 — Mint 1 NonTransferable credential token to agent_wallet
    IssueCredential {
        agent_pubkey:      [u8; 32],
        /// Compressed pubkey (33 bytes: secp256r1 or secp256k1)
        device_pubkey:     [u8; 33],
        binding_type:      BindingType,
        /// SHA-256 of the x402 payment receipt (verified on-chain when IS_MAINNET_READY)
        x402_receipt_hash: [u8; 32],
    },

    /// 0x02 — Protocol burns credential token via PermanentDelegate
    RevokeCredential {
        agent_pubkey: [u8; 32],
    },

    /// 0x03 — Burn old credential token, mint new one with updated device_pubkey
    UpgradeCredential {
        old_device_pubkey: [u8; 33],
        new_device_pubkey: [u8; 33],
        /// SHA-256 of the x402 re-issuance payment receipt
        x402_receipt_hash: [u8; 32],
    },
}

impl CredentialInstruction {
    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        let (&tag, rest) = data
            .split_first()
            .ok_or(ProgramError::InvalidInstructionData)?;

        match tag {
            0x01 => {
                if rest.len() < ISSUE_PAYLOAD_LEN {
                    return Err(CredentialError::InvalidInstructionData.into());
                }
                let agent_pubkey: [u8; 32] = rest[0..32]
                    .try_into().map_err(|_| ProgramError::InvalidInstructionData)?;
                let device_pubkey: [u8; 33] = rest[32..65]
                    .try_into().map_err(|_| ProgramError::InvalidInstructionData)?;
                let binding_type = BindingType::from_byte(rest[65])?;
                let x402_receipt_hash: [u8; 32] = rest[66..98]
                    .try_into().map_err(|_| ProgramError::InvalidInstructionData)?;

                Ok(CredentialInstruction::IssueCredential {
                    agent_pubkey,
                    device_pubkey,
                    binding_type,
                    x402_receipt_hash,
                })
            }

            0x02 => {
                if rest.len() < REVOKE_PAYLOAD_LEN {
                    return Err(CredentialError::InvalidInstructionData.into());
                }
                let agent_pubkey: [u8; 32] = rest[0..32]
                    .try_into().map_err(|_| ProgramError::InvalidInstructionData)?;

                Ok(CredentialInstruction::RevokeCredential { agent_pubkey })
            }

            0x03 => {
                if rest.len() < UPGRADE_PAYLOAD_LEN {
                    return Err(CredentialError::InvalidInstructionData.into());
                }
                let old_device_pubkey: [u8; 33] = rest[0..33]
                    .try_into().map_err(|_| ProgramError::InvalidInstructionData)?;
                let new_device_pubkey: [u8; 33] = rest[33..66]
                    .try_into().map_err(|_| ProgramError::InvalidInstructionData)?;
                let x402_receipt_hash: [u8; 32] = rest[66..98]
                    .try_into().map_err(|_| ProgramError::InvalidInstructionData)?;

                Ok(CredentialInstruction::UpgradeCredential {
                    old_device_pubkey,
                    new_device_pubkey,
                    x402_receipt_hash,
                })
            }

            _ => Err(CredentialError::InvalidInstructionData.into()),
        }
    }
}
