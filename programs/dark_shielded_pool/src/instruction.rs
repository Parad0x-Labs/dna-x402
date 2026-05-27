use crate::error::ShieldedPoolError;
use solana_program::program_error::ProgramError;
use solana_program::pubkey::Pubkey;

/// Wire format (first byte = discriminator):
///
///   0x00 InitPool   { denomination: u64 }         — 1 + 8 = 9 bytes
///   0x01 Deposit    { commitment: [u8;32] }        — 1 + 32 = 33 bytes
///   0x02 Withdraw   { nullifier: [u8;32], proof: [u8;128], recipient: [u8;32] } — 1+32+128+32 = 193 bytes
///   0x03 PausePool  {}                             — 1 byte
///   0x04 ResumePool {}                             — 1 byte
#[derive(Debug, PartialEq)]
pub enum PoolInstruction {
    /// Initialise a new shielded pool with a fixed denomination (lamports per note).
    ///
    /// Accounts: [pool_config (mut PDA), pool_vault (mut PDA), authority (signer), system_program]
    InitPool { denomination: u64 },

    /// Deposit exactly `denomination` lamports into the pool and record a commitment.
    ///
    /// Accounts: [pool_config (mut), pool_vault (mut), note_leaf (mut PDA), depositor (signer), system_program]
    Deposit { commitment: [u8; 32] },

    /// Withdraw `denomination` lamports by presenting a ZK proof and fresh nullifier.
    ///
    /// Accounts: [pool_config (mut), pool_vault (mut), nullifier_record (mut PDA), recipient (mut), system_program]
    Withdraw {
        nullifier: [u8; 32],
        /// 128-byte Groth16 proof (stub: first 32 bytes must equal expected_hash).
        proof: [u8; 128],
        recipient: Pubkey,
    },

    /// Pause all deposits and withdrawals (authority only).
    ///
    /// Accounts: [pool_config (mut), authority (signer)]
    PausePool,

    /// Resume the pool (authority only).
    ///
    /// Accounts: [pool_config (mut), authority (signer)]
    ResumePool,
}

impl PoolInstruction {
    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        if data.is_empty() {
            return Err(ShieldedPoolError::InvalidInstruction.into());
        }
        match data[0] {
            0x00 => {
                if data.len() < 9 {
                    return Err(ShieldedPoolError::InvalidInstruction.into());
                }
                let denomination = u64::from_le_bytes(data[1..9].try_into().unwrap());
                Ok(Self::InitPool { denomination })
            }
            0x01 => {
                if data.len() < 33 {
                    return Err(ShieldedPoolError::InvalidInstruction.into());
                }
                let commitment: [u8; 32] = data[1..33].try_into().unwrap();
                Ok(Self::Deposit { commitment })
            }
            0x02 => {
                if data.len() < 193 {
                    return Err(ShieldedPoolError::InvalidInstruction.into());
                }
                let nullifier:  [u8; 32]  = data[1..33].try_into().unwrap();
                let proof:      [u8; 128] = data[33..161].try_into().unwrap();
                let recipient_bytes: [u8; 32] = data[161..193].try_into().unwrap();
                let recipient = Pubkey::from(recipient_bytes);
                Ok(Self::Withdraw { nullifier, proof, recipient })
            }
            0x03 => Ok(Self::PausePool),
            0x04 => Ok(Self::ResumePool),
            _ => Err(ShieldedPoolError::InvalidInstruction.into()),
        }
    }

    pub fn pack(&self) -> Vec<u8> {
        match self {
            Self::InitPool { denomination } => {
                let mut v = vec![0x00];
                v.extend_from_slice(&denomination.to_le_bytes());
                v
            }
            Self::Deposit { commitment } => {
                let mut v = vec![0x01];
                v.extend_from_slice(commitment);
                v
            }
            Self::Withdraw { nullifier, proof, recipient } => {
                let mut v = vec![0x02];
                v.extend_from_slice(nullifier);
                v.extend_from_slice(proof);
                v.extend_from_slice(recipient.as_ref());
                v
            }
            Self::PausePool  => vec![0x03],
            Self::ResumePool => vec![0x04],
        }
    }
}
