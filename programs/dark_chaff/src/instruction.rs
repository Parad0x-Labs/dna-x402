use crate::error::DarkChaffError;
use solana_program::program_error::ProgramError;

/// CreateChaffBatch – `[0x00, count: u8, epoch: u64 LE]` = 10 bytes
///
/// Accounts: payer, batch_pda, system_program, intent_pda_0 .. intent_pda_{count-1}
///
/// CloseChaffBatch – `[0x01, epoch: u64 LE]` = 9 bytes
///
/// Accounts: payer, batch_pda, intent_pda_0 .. intent_pda_{count-1}
/// (count is read from batch_pda state, not from instruction data)
#[derive(Debug)]
pub enum ChaffInstruction {
    CreateChaffBatch { count: u8, epoch: u64 },
    CloseChaffBatch { epoch: u64 },
}

impl ChaffInstruction {
    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        if data.is_empty() {
            return Err(DarkChaffError::InvalidInstruction.into());
        }
        match data[0] {
            0x00 => {
                if data.len() < 10 {
                    return Err(DarkChaffError::InvalidInstruction.into());
                }
                let count = data[1];
                let mut epoch_raw = [0u8; 8];
                epoch_raw.copy_from_slice(&data[2..10]);
                Ok(Self::CreateChaffBatch {
                    count,
                    epoch: u64::from_le_bytes(epoch_raw),
                })
            }
            0x01 => {
                if data.len() < 9 {
                    return Err(DarkChaffError::InvalidInstruction.into());
                }
                let mut epoch_raw = [0u8; 8];
                epoch_raw.copy_from_slice(&data[1..9]);
                Ok(Self::CloseChaffBatch {
                    epoch: u64::from_le_bytes(epoch_raw),
                })
            }
            _ => Err(DarkChaffError::InvalidInstruction.into()),
        }
    }
}
