use crate::error::HookError;
use solana_program::program_error::ProgramError;

/// Token-2022 transfer-hook interface discriminant for the `Execute` instruction.
///
/// = sha256("spl-transfer-hook-interface:execute")[..8]
pub const EXECUTE_DISC: [u8; 8] = [0x9e, 0x22, 0x2c, 0x78, 0x0a, 0x62, 0x3d, 0xab];

/// Parsed instructions for the null-token-hook program.
pub enum HookInstruction {
    /// Token-2022 calls this on every NULL transfer.
    ///
    /// Instruction data: EXECUTE_DISC (8 bytes) + amount (8 bytes LE) = 16 bytes.
    ///
    /// Accounts (Token-2022 mandated order):
    ///   [0] source_account       (readonly)
    ///   [1] mint                 (readonly)
    ///   [2] destination_account  (readonly)
    ///   [3] source_owner         (readonly)
    ///   [4] validation_state_pda (readonly) — extra-account-metas account
    Execute { amount: u64 },

    /// Admin initialises the hook configuration PDA.
    ///
    /// Instruction data: [0x02, dark_pool_limit_atomic: u64 LE] = 9 bytes.
    ///
    /// Accounts:
    ///   [0] config_pda   (writable)
    ///   [1] admin        (signer + writable)
    ///   [2] system_program
    InitConfig { dark_pool_limit_atomic: u64 },

    /// Admin adds a wallet to the approved-transfer allowlist.
    ///
    /// Instruction data: [0x03, flags: u64 LE] = 9 bytes.
    ///
    /// Accounts:
    ///   [0] allowlist_pda  (writable)
    ///   [1] target_wallet  (readonly) — the wallet being allowlisted
    ///   [2] admin          (signer + writable)
    ///   [3] system_program
    AddToAllowlist { flags: u64 },

    /// Admin removes a wallet from the allowlist (zeros out the entry).
    ///
    /// Instruction data: [0x04] = 1 byte.
    ///
    /// Accounts:
    ///   [0] allowlist_pda  (writable)
    ///   [1] admin          (signer)
    RemoveFromAllowlist,
}

impl HookInstruction {
    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        if data.is_empty() {
            return Err(HookError::InvalidInstruction.into());
        }

        // Check for the Token-2022 Execute discriminant first (8-byte prefix).
        if data.len() >= 16 && data[0..8] == EXECUTE_DISC {
            let mut amt = [0u8; 8];
            amt.copy_from_slice(&data[8..16]);
            return Ok(Self::Execute { amount: u64::from_le_bytes(amt) });
        }

        // Fall through to single-byte discriminants for admin instructions.
        let (&tag, rest) = data.split_first().ok_or(HookError::InvalidInstruction)?;
        match tag {
            0x02 => {
                if rest.len() < 8 {
                    return Err(HookError::InvalidInstruction.into());
                }
                let mut b = [0u8; 8];
                b.copy_from_slice(&rest[..8]);
                Ok(Self::InitConfig { dark_pool_limit_atomic: u64::from_le_bytes(b) })
            }
            0x03 => {
                if rest.len() < 8 {
                    return Err(HookError::InvalidInstruction.into());
                }
                let mut b = [0u8; 8];
                b.copy_from_slice(&rest[..8]);
                Ok(Self::AddToAllowlist { flags: u64::from_le_bytes(b) })
            }
            0x04 => Ok(Self::RemoveFromAllowlist),
            _ => Err(HookError::InvalidInstruction.into()),
        }
    }
}
