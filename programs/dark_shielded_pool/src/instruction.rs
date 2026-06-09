use crate::error::ShieldedPoolError;
use solana_program::program_error::ProgramError;
use solana_program::pubkey::Pubkey;

/// Wire format (first byte = discriminator):
///
///   0x00 InitPool   { denomination: u64 }                         — 1 + 8 = 9 bytes
///   0x01 Deposit    { commitment: [u8;32] }                        — 1 + 32 = 33 bytes
///   0x02 Withdraw   { nullifier:[u8;32], root:[u8;32],
///                     proof:[u8;256], recipient:[u8;32] }          — 1+32+32+256+32 = 353 bytes
///   0x03 PausePool  {}                                             — 1 byte
///   0x04 ResumePool {}                                             — 1 byte
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
    /// `root` is the Merkle root the proof was generated against; it must be the
    /// pool's current root or one of the recent roots. It is also the `merkle_root`
    /// public input fed to the Groth16 verifier.
    ///
    /// Accounts: [pool_config (mut), pool_vault (mut), nullifier_record (mut PDA),
    ///            recipient (mut), fee_payer (signer, mut), system_program]
    Withdraw {
        nullifier: [u8; 32],
        /// Merkle root the proof opens (must be a known recent root).
        root: [u8; 32],
        /// 256-byte Groth16 proof: [A:G1(64B), B:G2(128B), C:G1(64B)].
        proof: [u8; 256],
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

/// Withdraw instruction wire length: 1 + 32 + 32 + 256 + 32.
pub const WITHDRAW_IX_LEN: usize = 1 + 32 + 32 + 256 + 32; // 353

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
                if data.len() < WITHDRAW_IX_LEN {
                    return Err(ShieldedPoolError::InvalidInstruction.into());
                }
                let nullifier: [u8; 32] = data[1..33].try_into().unwrap();
                let root: [u8; 32] = data[33..65].try_into().unwrap();
                let proof: [u8; 256] = data[65..321].try_into().unwrap();
                let recipient_bytes: [u8; 32] = data[321..353].try_into().unwrap();
                let recipient = Pubkey::from(recipient_bytes);
                Ok(Self::Withdraw {
                    nullifier,
                    root,
                    proof,
                    recipient,
                })
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
            Self::Withdraw {
                nullifier,
                root,
                proof,
                recipient,
            } => {
                let mut v = vec![0x02];
                v.extend_from_slice(nullifier);
                v.extend_from_slice(root);
                v.extend_from_slice(proof.as_ref());
                v.extend_from_slice(recipient.as_ref());
                v
            }
            Self::PausePool => vec![0x03],
            Self::ResumePool => vec![0x04],
        }
    }
}
