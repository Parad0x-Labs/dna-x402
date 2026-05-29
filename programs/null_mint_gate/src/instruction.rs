use crate::error::MintGateError;
use solana_program::program_error::ProgramError;

/// Parsed instructions for the dark-null-mint-gate program.
#[derive(Debug)]
pub enum MintGateInstruction {
    /// 0x01 InitEmission
    /// Data: [0x01, null_mint[32], max_null_per_claim[8], epoch_duration[8],
    ///        epoch_null_cap[8]] = 57 bytes total
    InitEmission {
        null_mint:           [u8; 32],
        max_null_per_claim:  u64,
        epoch_duration:      u64,
        epoch_null_cap:      u64,
    },

    /// 0x02 ClaimEmission
    /// Data: [0x02, nullifier_hash[32], receipt_commitment[32],
    ///        null_amount_atomic[8]] = 73 bytes total
    ClaimEmission {
        nullifier_hash:     [u8; 32],
        receipt_commitment: [u8; 32],
        null_amount_atomic: u64,
    },

    /// 0x03 AdvanceEpoch
    /// Data: [0x03, new_epoch[8]] = 9 bytes total
    AdvanceEpoch {
        new_epoch: u64,
    },
}

impl MintGateInstruction {
    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        let (&tag, rest) = data
            .split_first()
            .ok_or::<ProgramError>(MintGateError::InvalidInstruction.into())?;

        match tag {
            // ── 0x01 InitEmission ─────────────────────────────────────────
            0x01 => {
                // 32 + 8 + 8 + 8 = 56 bytes after discriminant
                if rest.len() < 56 {
                    return Err(MintGateError::InvalidInstruction.into());
                }
                let mut null_mint          = [0u8; 32];
                let mut max_bytes          = [0u8; 8];
                let mut dur_bytes          = [0u8; 8];
                let mut cap_bytes          = [0u8; 8];
                null_mint.copy_from_slice(&rest[0..32]);
                max_bytes.copy_from_slice(&rest[32..40]);
                dur_bytes.copy_from_slice(&rest[40..48]);
                cap_bytes.copy_from_slice(&rest[48..56]);
                Ok(Self::InitEmission {
                    null_mint,
                    max_null_per_claim: u64::from_le_bytes(max_bytes),
                    epoch_duration:     u64::from_le_bytes(dur_bytes),
                    epoch_null_cap:     u64::from_le_bytes(cap_bytes),
                })
            }

            // ── 0x02 ClaimEmission ────────────────────────────────────────
            0x02 => {
                // 32 + 32 + 8 = 72 bytes after discriminant
                if rest.len() < 72 {
                    return Err(MintGateError::InvalidInstruction.into());
                }
                let mut nullifier_hash     = [0u8; 32];
                let mut receipt_commitment = [0u8; 32];
                let mut amount_bytes       = [0u8; 8];
                nullifier_hash.copy_from_slice(&rest[0..32]);
                receipt_commitment.copy_from_slice(&rest[32..64]);
                amount_bytes.copy_from_slice(&rest[64..72]);
                Ok(Self::ClaimEmission {
                    nullifier_hash,
                    receipt_commitment,
                    null_amount_atomic: u64::from_le_bytes(amount_bytes),
                })
            }

            // ── 0x03 AdvanceEpoch ─────────────────────────────────────────
            0x03 => {
                // 8 bytes after discriminant
                if rest.len() < 8 {
                    return Err(MintGateError::InvalidInstruction.into());
                }
                let mut epoch_bytes = [0u8; 8];
                epoch_bytes.copy_from_slice(&rest[0..8]);
                Ok(Self::AdvanceEpoch {
                    new_epoch: u64::from_le_bytes(epoch_bytes),
                })
            }

            _ => Err(MintGateError::InvalidInstruction.into()),
        }
    }
}
