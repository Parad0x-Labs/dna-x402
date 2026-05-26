use crate::error::ReceiptError;
use solana_program::program_error::ProgramError;

/// Instructions for the dark_compressed_receipts program.
///
/// Accounts for each variant:
///
/// **InitRoot** – `[0x00]`
///   0: authority (writable, signer)
///   1: root_pda  (writable, PDA)
///   2: system_program
///
/// **UpdateRoot** – `[0x01, root: [u8;32]]`
///   0: authority (signer)
///   1: root_pda  (writable)
///
/// **RedeemReceipt** – `[0x02, nullifier: [u8;32]]`
///   0: payer         (writable, signer)
///   1: root_pda      (readable)
///   2: null_pda      (writable, PDA)
///   3: system_program
#[derive(Debug)]
pub enum ReceiptInstruction {
    InitRoot,
    UpdateRoot { root: [u8; 32] },
    RedeemReceipt { nullifier: [u8; 32] },
}

impl ReceiptInstruction {
    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        if data.is_empty() {
            return Err(ReceiptError::InvalidInstruction.into());
        }
        match data[0] {
            0x00 => Ok(Self::InitRoot),
            0x01 => {
                if data.len() < 33 {
                    return Err(ReceiptError::InvalidInstruction.into());
                }
                let mut root = [0u8; 32];
                root.copy_from_slice(&data[1..33]);
                Ok(Self::UpdateRoot { root })
            }
            0x02 => {
                if data.len() < 33 {
                    return Err(ReceiptError::InvalidInstruction.into());
                }
                let mut nullifier = [0u8; 32];
                nullifier.copy_from_slice(&data[1..33]);
                Ok(Self::RedeemReceipt { nullifier })
            }
            _ => Err(ReceiptError::InvalidInstruction.into()),
        }
    }
}
