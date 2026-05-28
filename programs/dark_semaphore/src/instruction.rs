use crate::error::SemaphoreError;
use solana_program::program_error::ProgramError;

/// Parsed instruction variants for the dark-semaphore program.
pub enum SemaphoreInstruction {
    /// Create a new anonymity group.
    ///
    /// Data: [0x01, depth: u8, root: [u8; 32]]  (34 bytes)
    /// Accounts: [group_pda(writable), admin(signer+writable), system_program]
    ///
    /// PDA seeds: [b"group", admin.key]  — one group per admin (devnet simplification)
    InitGroup { depth: u8, root: [u8; 32] },

    /// Admin updates the Merkle root after an off-chain member insertion.
    ///
    /// Data: [0x02, new_root: [u8; 32]]  (33 bytes)
    /// Accounts: [group_pda(writable), admin(signer)]
    UpdateRoot { new_root: [u8; 32] },

    /// Consume a nullifier to post an anonymous signal.
    /// Replay-prevented: creating NullifierRecord PDA fails if already exists.
    ///
    /// Data: [0x03, nullifier_hash: [u8; 32], ext_nullifier: [u8; 32], signal_hash: [u8; 32]]
    ///       (97 bytes)
    /// Accounts: [group_pda(readonly), nullifier_pda(writable), signer(writable+signer), system_program]
    Signal {
        nullifier_hash: [u8; 32],
        ext_nullifier:  [u8; 32],
        signal_hash:    [u8; 32],
    },
}

impl SemaphoreInstruction {
    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        let (&tag, rest) = data.split_first().ok_or(SemaphoreError::InvalidInstruction)?;
        match tag {
            0x01 => {
                if rest.len() < 33 { return Err(SemaphoreError::InvalidInstruction.into()); }
                if rest[0] == 0 || rest[0] > 32 { return Err(SemaphoreError::InvalidDepth.into()); }
                let mut root = [0u8; 32];
                root.copy_from_slice(&rest[1..33]);
                Ok(Self::InitGroup { depth: rest[0], root })
            }
            0x02 => {
                if rest.len() < 32 { return Err(SemaphoreError::InvalidInstruction.into()); }
                let mut new_root = [0u8; 32];
                new_root.copy_from_slice(&rest[..32]);
                Ok(Self::UpdateRoot { new_root })
            }
            0x03 => {
                if rest.len() < 96 { return Err(SemaphoreError::InvalidInstruction.into()); }
                let mut nullifier_hash = [0u8; 32];
                let mut ext_nullifier  = [0u8; 32];
                let mut signal_hash    = [0u8; 32];
                nullifier_hash.copy_from_slice(&rest[0..32]);
                ext_nullifier.copy_from_slice(&rest[32..64]);
                signal_hash.copy_from_slice(&rest[64..96]);
                Ok(Self::Signal { nullifier_hash, ext_nullifier, signal_hash })
            }
            _ => Err(SemaphoreError::InvalidInstruction.into()),
        }
    }
}
