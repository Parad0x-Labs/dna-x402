use solana_program::program_error::ProgramError;

use crate::error::DarkNullError;

#[derive(Debug)]
pub enum DarkNullifierInstruction {
    /// Allocate a nullifier bank PDA for (shard, epoch).
    ///
    /// Data layout: `[0x00, shard: u8, epoch: u64 LE]` = 10 bytes
    ///
    /// Accounts:
    ///   0: payer         (writable, signer)
    ///   1: bank_pda      (writable, PDA)
    ///   2: system_program
    InitBank { shard: u8, epoch: u64 },

    /// Insert a nullifier into the correct shard bank.
    ///
    /// Data layout: `[0x01, nullifier: [u8; 32], epoch: u64 LE]` = 41 bytes
    ///
    /// Accounts:
    ///   0: payer            (writable, signer)
    ///   1: bank_pda         (writable, PDA — must match H(nullifier, epoch) % 256)
    ///   2: null_rec_pda     (writable, PDA — unique per nullifier)
    ///   3: system_program
    InsertNullifier { nullifier: [u8; 32], epoch: u64 },
}

impl DarkNullifierInstruction {
    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        if data.is_empty() {
            return Err(DarkNullError::InvalidInstructionData.into());
        }
        match data[0] {
            0x00 => {
                if data.len() < 10 {
                    return Err(DarkNullError::InvalidInstructionData.into());
                }
                let shard = data[1];
                let mut epoch_raw = [0u8; 8];
                epoch_raw.copy_from_slice(&data[2..10]);
                Ok(Self::InitBank {
                    shard,
                    epoch: u64::from_le_bytes(epoch_raw),
                })
            }
            0x01 => {
                if data.len() < 41 {
                    return Err(DarkNullError::InvalidInstructionData.into());
                }
                let mut nullifier = [0u8; 32];
                nullifier.copy_from_slice(&data[1..33]);
                let mut epoch_raw = [0u8; 8];
                epoch_raw.copy_from_slice(&data[33..41]);
                Ok(Self::InsertNullifier {
                    nullifier,
                    epoch: u64::from_le_bytes(epoch_raw),
                })
            }
            _ => Err(DarkNullError::InvalidInstructionData.into()),
        }
    }
}
