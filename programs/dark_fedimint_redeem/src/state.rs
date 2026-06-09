//! Account layouts for the redeem program.
//!
//! Two account types, both tiny and fixed-size:
//!   * `MintConfig`     — one per federation mint: the group key `K`, the
//!     denomination, the authority, the reserve-vault bump.
//!   * `NullifierRecord`— one per spent token (existence = spent). Same pattern
//!     as `dark_shielded_pool`.

use solana_program::program_error::ProgramError;
use solana_program::program_pack::{IsInitialized, Pack, Sealed};

pub const MINT_CONFIG_VERSION: u8 = 1;

// ─── MintConfig ───────────────────────────────────────────────────────────────
// Seeds: [b"mint_config", authority_pubkey]
//   version       u8     1
//   bump          u8     1
//   is_init       u8     1
//   _pad          u8     1
//   authority    [u8;32] 32
//   group_pub    [u8;32] 32   ← K = k·G, the federation's group mint key
//   denomination  u64    8    ← fixed lamports paid per redeemed token
//   vault_bump    u8     1
//   redeemed_ct   u64    8    ← number of tokens redeemed (telemetry)
// total = 85
pub const MINT_CONFIG_LEN: usize = 85;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MintConfig {
    pub version: u8,
    pub bump: u8,
    pub is_initialized: bool,
    pub authority: [u8; 32],
    pub group_pub: [u8; 32],
    pub denomination: u64,
    pub vault_bump: u8,
    pub redeemed_count: u64,
}

impl Default for MintConfig {
    fn default() -> Self {
        MintConfig {
            version: 0,
            bump: 0,
            is_initialized: false,
            authority: [0u8; 32],
            group_pub: [0u8; 32],
            denomination: 0,
            vault_bump: 0,
            redeemed_count: 0,
        }
    }
}

impl Sealed for MintConfig {}
impl IsInitialized for MintConfig {
    fn is_initialized(&self) -> bool {
        self.is_initialized && self.version == MINT_CONFIG_VERSION
    }
}

impl Pack for MintConfig {
    const LEN: usize = MINT_CONFIG_LEN;

    fn pack_into_slice(&self, dst: &mut [u8]) {
        dst[0] = self.version;
        dst[1] = self.bump;
        dst[2] = self.is_initialized as u8;
        dst[3] = 0; // pad
        dst[4..36].copy_from_slice(&self.authority);
        dst[36..68].copy_from_slice(&self.group_pub);
        dst[68..76].copy_from_slice(&self.denomination.to_le_bytes());
        dst[76] = self.vault_bump;
        dst[77..85].copy_from_slice(&self.redeemed_count.to_le_bytes());
    }

    fn unpack_from_slice(src: &[u8]) -> Result<Self, ProgramError> {
        if src.len() < MINT_CONFIG_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(MintConfig {
            version: src[0],
            bump: src[1],
            is_initialized: src[2] != 0,
            authority: src[4..36].try_into().unwrap(),
            group_pub: src[36..68].try_into().unwrap(),
            denomination: u64::from_le_bytes(src[68..76].try_into().unwrap()),
            vault_bump: src[76],
            redeemed_count: u64::from_le_bytes(src[77..85].try_into().unwrap()),
        })
    }
}

// ─── NullifierRecord ──────────────────────────────────────────────────────────
// Seeds: [b"nullifier", mint_config_key, &nullifier]
// One account per spent token. Existence = spent.
pub const NULLIFIER_RECORD_LEN: usize = 41;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NullifierRecord {
    pub bump: u8,
    pub nullifier: [u8; 32],
    pub spent_at: i64,
}

impl Sealed for NullifierRecord {}
impl IsInitialized for NullifierRecord {
    fn is_initialized(&self) -> bool {
        self.nullifier != [0u8; 32]
    }
}

impl Pack for NullifierRecord {
    const LEN: usize = NULLIFIER_RECORD_LEN;

    fn pack_into_slice(&self, dst: &mut [u8]) {
        dst[0] = self.bump;
        dst[1..33].copy_from_slice(&self.nullifier);
        dst[33..41].copy_from_slice(&self.spent_at.to_le_bytes());
    }

    fn unpack_from_slice(src: &[u8]) -> Result<Self, ProgramError> {
        if src.len() < NULLIFIER_RECORD_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(NullifierRecord {
            bump: src[0],
            nullifier: src[1..33].try_into().unwrap(),
            spent_at: i64::from_le_bytes(src[33..41].try_into().unwrap()),
        })
    }
}
