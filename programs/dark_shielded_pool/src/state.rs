use solana_program::program_error::ProgramError;
use solana_program::program_pack::{IsInitialized, Pack, Sealed};

// ─── PoolConfig ───────────────────────────────────────────────────────────────
// Seeds: [b"pool_config", authority_pubkey]
// Stores global pool state and the rolling Merkle root.

pub const POOL_CONFIG_VERSION: u8 = 1;

/// Layout (116 bytes):
///   version      u8          1
///   bump         u8          1
///   is_init      u8          1
///   is_paused    u8          1
///   authority   [u8;32]     32
///   denomination u64         8
///   merkle_root [u8;32]     32
///   note_count   u64         8
///   _pad        [u8;32]     32   ← reserved for future fields
pub const POOL_CONFIG_LEN: usize = 116;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PoolConfig {
    pub version: u8,
    pub bump: u8,
    pub is_initialized: bool,
    pub is_paused: bool,
    pub authority: [u8; 32],
    /// Fixed note size in lamports (SOL) per deposit.
    pub denomination: u64,
    /// Rolling commitment-chain root (updated on every deposit).
    pub merkle_root: [u8; 32],
    /// Total notes deposited (also the next leaf_index).
    pub note_count: u64,
}

impl Sealed for PoolConfig {}

impl IsInitialized for PoolConfig {
    fn is_initialized(&self) -> bool {
        self.is_initialized && self.version == POOL_CONFIG_VERSION
    }
}

impl Pack for PoolConfig {
    const LEN: usize = POOL_CONFIG_LEN;

    fn pack_into_slice(&self, dst: &mut [u8]) {
        dst[0]  = self.version;
        dst[1]  = self.bump;
        dst[2]  = self.is_initialized as u8;
        dst[3]  = self.is_paused as u8;
        dst[4..36].copy_from_slice(&self.authority);
        dst[36..44].copy_from_slice(&self.denomination.to_le_bytes());
        dst[44..76].copy_from_slice(&self.merkle_root);
        dst[76..84].copy_from_slice(&self.note_count.to_le_bytes());
        // dst[84..116] reserved / zero
    }

    fn unpack_from_slice(src: &[u8]) -> Result<Self, ProgramError> {
        if src.len() < POOL_CONFIG_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(Self {
            version:        src[0],
            bump:           src[1],
            is_initialized: src[2] != 0,
            is_paused:      src[3] != 0,
            authority:      src[4..36].try_into().unwrap(),
            denomination:   u64::from_le_bytes(src[36..44].try_into().unwrap()),
            merkle_root:    src[44..76].try_into().unwrap(),
            note_count:     u64::from_le_bytes(src[76..84].try_into().unwrap()),
        })
    }
}

// ─── NoteLeaf ────────────────────────────────────────────────────────────────
// Seeds: [b"note_leaf", pool_config_key, &leaf_index.to_le_bytes()]
// One account per deposit. Stores the commitment hash (hides the secret).

pub const NOTE_LEAF_LEN: usize = 49;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct NoteLeaf {
    pub bump:         u8,
    pub commitment:   [u8; 32],
    pub leaf_index:   u64,
    pub deposited_at: i64,
}

impl Sealed for NoteLeaf {}

impl IsInitialized for NoteLeaf {
    fn is_initialized(&self) -> bool { self.commitment != [0u8; 32] }
}

impl Pack for NoteLeaf {
    const LEN: usize = NOTE_LEAF_LEN;

    fn pack_into_slice(&self, dst: &mut [u8]) {
        dst[0]     = self.bump;
        dst[1..33].copy_from_slice(&self.commitment);
        dst[33..41].copy_from_slice(&self.leaf_index.to_le_bytes());
        dst[41..49].copy_from_slice(&self.deposited_at.to_le_bytes());
    }

    fn unpack_from_slice(src: &[u8]) -> Result<Self, ProgramError> {
        if src.len() < NOTE_LEAF_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(Self {
            bump:         src[0],
            commitment:   src[1..33].try_into().unwrap(),
            leaf_index:   u64::from_le_bytes(src[33..41].try_into().unwrap()),
            deposited_at: i64::from_le_bytes(src[41..49].try_into().unwrap()),
        })
    }
}

// ─── NullifierRecord ─────────────────────────────────────────────────────────
// Seeds: [b"nullifier", pool_config_key, &nullifier]
// One account per spent note. Existence = spent.

pub const NULLIFIER_RECORD_LEN: usize = 41;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct NullifierRecord {
    pub bump:     u8,
    pub nullifier: [u8; 32],
    pub spent_at:  i64,
}

impl Sealed for NullifierRecord {}
impl IsInitialized for NullifierRecord {
    fn is_initialized(&self) -> bool { self.nullifier != [0u8; 32] }
}

impl Pack for NullifierRecord {
    const LEN: usize = NULLIFIER_RECORD_LEN;

    fn pack_into_slice(&self, dst: &mut [u8]) {
        dst[0]     = self.bump;
        dst[1..33].copy_from_slice(&self.nullifier);
        dst[33..41].copy_from_slice(&self.spent_at.to_le_bytes());
    }

    fn unpack_from_slice(src: &[u8]) -> Result<Self, ProgramError> {
        if src.len() < NULLIFIER_RECORD_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(Self {
            bump:      src[0],
            nullifier: src[1..33].try_into().unwrap(),
            spent_at:  i64::from_le_bytes(src[33..41].try_into().unwrap()),
        })
    }
}
