use crate::error::ScratchError;
use solana_program::program_error::ProgramError;

/// CreateScratch – [0x00, expires_at_slot: u64 LE, tag: [u8; 8]] = 17 bytes
/// Accounts: owner (writable, signer), scratch_pda (writable), system_program
///
/// CloseScratch – [0x01] = 1 byte
/// Accounts: owner (signer, writable), scratch_pda (writable)
///
/// CleanupExpired – [0x02] = 1 byte
/// Accounts: keeper (writable, signer), scratch_pda (writable)
/// (permissionless after expiry — anyone may close and receive reclaimed rent)
#[derive(Debug)]
pub enum ScratchInstruction {
    CreateScratch { expires_at_slot: u64, tag: [u8; 8] },
    CloseScratch,
    CleanupExpired,
}

impl ScratchInstruction {
    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        if data.is_empty() {
            return Err(ScratchError::InvalidInstruction.into());
        }
        match data[0] {
            0x00 => {
                if data.len() < 17 {
                    return Err(ScratchError::InvalidInstruction.into());
                }
                let mut exp = [0u8; 8];
                exp.copy_from_slice(&data[1..9]);
                let mut tag = [0u8; 8];
                tag.copy_from_slice(&data[9..17]);
                Ok(Self::CreateScratch {
                    expires_at_slot: u64::from_le_bytes(exp),
                    tag,
                })
            }
            0x01 => Ok(Self::CloseScratch),
            0x02 => Ok(Self::CleanupExpired),
            _ => Err(ScratchError::InvalidInstruction.into()),
        }
    }
}
