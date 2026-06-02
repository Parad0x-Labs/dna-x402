use solana_program::program_error::ProgramError;
use crate::error::RegistrarError;

/// Instruction discriminants
pub const IX_INIT_REGISTRY:   u8 = 0x01;
pub const IX_REGISTER:        u8 = 0x02;
pub const IX_UPDATE_CONTENT:  u8 = 0x03;
pub const IX_TRANSFER:        u8 = 0x04;
pub const IX_RESOLVE:         u8 = 0x05;

#[derive(Debug, PartialEq)]
pub enum RegistrarInstruction {
    /// 0x01 — one-time registry bootstrap
    /// data: [u8; 8] registration_fee LE | [u8; 32] null_mint | [u8; 32] treasury
    InitRegistry {
        registration_fee: u64,
        null_mint:        [u8; 32],
        treasury:         [u8; 32],
    },

    /// 0x02 — register a new .null domain
    /// data: [u8; 64] name | [u8; 32] content_hash
    Register {
        name:         [u8; 64],
        content_hash: [u8; 32],
    },

    /// 0x03 — update where the domain resolves (owner only)
    /// data: [u8; 64] name | [u8; 32] new_content_hash
    UpdateContent {
        name:             [u8; 64],
        new_content_hash: [u8; 32],
    },

    /// 0x04 — transfer domain to a new owner
    /// data: [u8; 64] name | [u8; 32] new_owner
    Transfer {
        name:      [u8; 64],
        new_owner: [u8; 32],
    },

    /// 0x05 — read-only resolve (returns content_hash via log/CPI)
    /// data: [u8; 64] name
    Resolve {
        name: [u8; 64],
    },
}

impl RegistrarInstruction {
    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        let (&tag, rest) = data.split_first()
            .ok_or(ProgramError::InvalidInstructionData)?;

        match tag {
            IX_INIT_REGISTRY => {
                // 8 (fee) + 32 (mint) + 32 (treasury) = 72 bytes
                if rest.len() < 72 {
                    return Err(ProgramError::Custom(RegistrarError::NameTooLong as u32));
                }
                let mut fee_bytes = [0u8; 8];
                let mut null_mint = [0u8; 32];
                let mut treasury  = [0u8; 32];
                fee_bytes.copy_from_slice(&rest[0..8]);
                null_mint.copy_from_slice(&rest[8..40]);
                treasury.copy_from_slice(&rest[40..72]);
                Ok(Self::InitRegistry {
                    registration_fee: u64::from_le_bytes(fee_bytes),
                    null_mint,
                    treasury,
                })
            }

            IX_REGISTER => {
                // 64 (name) + 32 (content_hash) = 96 bytes
                if rest.len() < 96 {
                    return Err(ProgramError::InvalidInstructionData);
                }
                let mut name         = [0u8; 64];
                let mut content_hash = [0u8; 32];
                name.copy_from_slice(&rest[0..64]);
                content_hash.copy_from_slice(&rest[64..96]);
                Ok(Self::Register { name, content_hash })
            }

            IX_UPDATE_CONTENT => {
                // 64 (name) + 32 (new_content_hash) = 96 bytes
                if rest.len() < 96 {
                    return Err(ProgramError::InvalidInstructionData);
                }
                let mut name             = [0u8; 64];
                let mut new_content_hash = [0u8; 32];
                name.copy_from_slice(&rest[0..64]);
                new_content_hash.copy_from_slice(&rest[64..96]);
                Ok(Self::UpdateContent { name, new_content_hash })
            }

            IX_TRANSFER => {
                // 64 (name) + 32 (new_owner) = 96 bytes
                if rest.len() < 96 {
                    return Err(ProgramError::InvalidInstructionData);
                }
                let mut name      = [0u8; 64];
                let mut new_owner = [0u8; 32];
                name.copy_from_slice(&rest[0..64]);
                new_owner.copy_from_slice(&rest[64..96]);
                Ok(Self::Transfer { name, new_owner })
            }

            IX_RESOLVE => {
                // 64 (name) = 64 bytes
                if rest.len() < 64 {
                    return Err(ProgramError::InvalidInstructionData);
                }
                let mut name = [0u8; 64];
                name.copy_from_slice(&rest[0..64]);
                Ok(Self::Resolve { name })
            }

            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}

// ─── name validation helpers ─────────────────────────────────────────────────

/// Maximum printable chars in a .null name (not counting null-padding).
pub const MAX_NAME_LEN: usize = 32;

/// Validate a packed name buffer.
/// Returns the printable length (bytes before the first 0x00).
/// Errors: NameTooLong (>32 chars) or InvalidName (disallowed byte).
pub fn validate_name(name: &[u8; 64]) -> Result<usize, ProgramError> {
    let mut printable_len = 0usize;
    let mut in_padding    = false;

    for &b in name.iter() {
        if b == 0x00 {
            in_padding = true;
            continue;
        }
        if in_padding {
            // Non-zero byte after null padding — malformed
            return Err(ProgramError::Custom(RegistrarError::InvalidName as u32));
        }
        // Allow: a-z (0x61-0x7A), 0-9 (0x30-0x39), hyphen (0x2D)
        let valid = matches!(b, 0x61..=0x7A | 0x30..=0x39 | 0x2D);
        if !valid {
            return Err(ProgramError::Custom(RegistrarError::InvalidName as u32));
        }
        printable_len += 1;
    }

    if printable_len == 0 {
        return Err(ProgramError::Custom(RegistrarError::InvalidName as u32));
    }
    if printable_len > MAX_NAME_LEN {
        return Err(ProgramError::Custom(RegistrarError::NameTooLong as u32));
    }

    Ok(printable_len)
}
