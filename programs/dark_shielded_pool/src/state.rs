use solana_program::program_error::ProgramError;
use solana_program::program_pack::{IsInitialized, Pack, Sealed};

use dark_shielded_pool_core::{RECENT_ROOTS, TREE_DEPTH};

// ─── PoolConfig (v2) ──────────────────────────────────────────────────────────
// Seeds: [b"pool_config", authority_pubkey]
//
// v2 stores the FULL state needed for a real incremental Poseidon Merkle tree
// (matching shielded_withdraw_v2.circom, TREE_DEPTH = 20) plus a ring of recent
// roots. The previous version (v1) kept only a single rolling-chain "root", which
// no circuit could ever open. The on-chain tree update is O(TREE_DEPTH) Poseidon
// syscalls per deposit — no need to read back any leaf PDAs.

pub const POOL_CONFIG_VERSION: u8 = 2;

/// Fixed-size layout. See `pack_into_slice` for exact offsets.
///   version       u8                       1
///   bump          u8                       1
///   is_init       u8                       1
///   is_paused     u8                       1
///   authority    [u8;32]                  32
///   denomination  u64                      8
///   merkle_root  [u8;32]                  32   ← current tree root
///   note_count    u64                      8   ← leaves inserted = next index
///   filled_subtrees [u8; 32*TREE_DEPTH]  640   ← incremental tree state
///   recent_roots    [u8; 32*RECENT_ROOTS]1024  ← ring of recent roots
///   recent_head   u8                       1   ← ring write cursor
///   recent_count  u8                       1   ← number of valid ring entries
/// total = 84 + 640 + 1024 + 2 = 1750
pub const FILLED_SUBTREES_BYTES: usize = 32 * TREE_DEPTH; // 640
pub const RECENT_ROOTS_BYTES: usize = 32 * RECENT_ROOTS; // 1024
pub const POOL_CONFIG_LEN: usize = 84 + FILLED_SUBTREES_BYTES + RECENT_ROOTS_BYTES + 2; // 1750

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolConfig {
    pub version: u8,
    pub bump: u8,
    pub is_initialized: bool,
    pub is_paused: bool,
    pub authority: [u8; 32],
    /// Fixed note size in lamports (SOL) per deposit.
    pub denomination: u64,
    /// Current incremental Poseidon Merkle tree root.
    pub merkle_root: [u8; 32],
    /// Total notes deposited (also the next leaf_index).
    pub note_count: u64,
    /// Rightmost filled node at each tree level (Tornado incremental convention).
    pub filled_subtrees: [[u8; 32]; TREE_DEPTH],
    /// Ring buffer of the last `RECENT_ROOTS` roots.
    pub recent_roots: [[u8; 32]; RECENT_ROOTS],
    /// Ring write cursor.
    pub recent_head: u8,
    /// Number of valid entries in the ring.
    pub recent_count: u8,
}

impl Default for PoolConfig {
    fn default() -> Self {
        PoolConfig {
            version: 0,
            bump: 0,
            is_initialized: false,
            is_paused: false,
            authority: [0u8; 32],
            denomination: 0,
            merkle_root: [0u8; 32],
            note_count: 0,
            filled_subtrees: [[0u8; 32]; TREE_DEPTH],
            recent_roots: [[0u8; 32]; RECENT_ROOTS],
            recent_head: 0,
            recent_count: 0,
        }
    }
}

impl PoolConfig {
    /// Unpack directly into a heap `Box`, never materialising the ~1.2 KB struct
    /// on the SBF stack. Fields are written through the boxed pointer.
    pub fn unpack_boxed(src: &[u8]) -> Result<Box<Self>, ProgramError> {
        if src.len() < POOL_CONFIG_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        let mut b: Box<Self> = Box::new(Self::default());
        b.version = src[0];
        b.bump = src[1];
        b.is_initialized = src[2] != 0;
        b.is_paused = src[3] != 0;
        b.authority.copy_from_slice(&src[4..36]);
        b.denomination = u64::from_le_bytes(src[36..44].try_into().unwrap());
        b.merkle_root.copy_from_slice(&src[44..76]);
        b.note_count = u64::from_le_bytes(src[76..84].try_into().unwrap());
        let mut off = 84;
        for node in b.filled_subtrees.iter_mut() {
            node.copy_from_slice(&src[off..off + 32]);
            off += 32;
        }
        for root in b.recent_roots.iter_mut() {
            root.copy_from_slice(&src[off..off + 32]);
            off += 32;
        }
        b.recent_head = src[off];
        b.recent_count = src[off + 1];
        Ok(b)
    }

    /// Pack a boxed config back into a byte buffer (reuses `pack_into_slice`).
    pub fn pack_boxed(b: &Self, dst: &mut [u8]) {
        b.pack_into_slice(dst);
    }

    /// Push a new root into the recent-roots ring.
    pub fn push_recent_root(&mut self, root: [u8; 32]) {
        self.recent_roots[self.recent_head as usize] = root;
        self.recent_head = ((self.recent_head as usize + 1) % RECENT_ROOTS) as u8;
        if (self.recent_count as usize) < RECENT_ROOTS {
            self.recent_count += 1;
        }
    }

    /// Is `root` the current root or one of the recent roots? Never matches zero.
    pub fn knows_root(&self, root: &[u8; 32]) -> bool {
        if *root == [0u8; 32] {
            return false;
        }
        if *root == self.merkle_root {
            return true;
        }
        self.recent_roots[..self.recent_count as usize]
            .iter()
            .any(|r| r == root)
    }
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
        dst[0] = self.version;
        dst[1] = self.bump;
        dst[2] = self.is_initialized as u8;
        dst[3] = self.is_paused as u8;
        dst[4..36].copy_from_slice(&self.authority);
        dst[36..44].copy_from_slice(&self.denomination.to_le_bytes());
        dst[44..76].copy_from_slice(&self.merkle_root);
        dst[76..84].copy_from_slice(&self.note_count.to_le_bytes());

        let mut off = 84;
        for node in self.filled_subtrees.iter() {
            dst[off..off + 32].copy_from_slice(node);
            off += 32;
        }
        for root in self.recent_roots.iter() {
            dst[off..off + 32].copy_from_slice(root);
            off += 32;
        }
        dst[off] = self.recent_head;
        dst[off + 1] = self.recent_count;
    }

    fn unpack_from_slice(src: &[u8]) -> Result<Self, ProgramError> {
        if src.len() < POOL_CONFIG_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        let mut filled_subtrees = [[0u8; 32]; TREE_DEPTH];
        let mut recent_roots = [[0u8; 32]; RECENT_ROOTS];

        let mut off = 84;
        for node in filled_subtrees.iter_mut() {
            node.copy_from_slice(&src[off..off + 32]);
            off += 32;
        }
        for root in recent_roots.iter_mut() {
            root.copy_from_slice(&src[off..off + 32]);
            off += 32;
        }

        Ok(Self {
            version: src[0],
            bump: src[1],
            is_initialized: src[2] != 0,
            is_paused: src[3] != 0,
            authority: src[4..36].try_into().unwrap(),
            denomination: u64::from_le_bytes(src[36..44].try_into().unwrap()),
            merkle_root: src[44..76].try_into().unwrap(),
            note_count: u64::from_le_bytes(src[76..84].try_into().unwrap()),
            filled_subtrees,
            recent_roots,
            recent_head: src[off],
            recent_count: src[off + 1],
        })
    }
}

// ─── NoteLeaf ────────────────────────────────────────────────────────────────
// Seeds: [b"note_leaf", pool_config_key, &leaf_index.to_le_bytes()]
// One account per deposit. Stores the commitment hash (hides the secret).

pub const NOTE_LEAF_LEN: usize = 49;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct NoteLeaf {
    pub bump: u8,
    pub commitment: [u8; 32],
    pub leaf_index: u64,
    pub deposited_at: i64,
}

impl Sealed for NoteLeaf {}

impl IsInitialized for NoteLeaf {
    fn is_initialized(&self) -> bool {
        self.commitment != [0u8; 32]
    }
}

impl Pack for NoteLeaf {
    const LEN: usize = NOTE_LEAF_LEN;

    fn pack_into_slice(&self, dst: &mut [u8]) {
        dst[0] = self.bump;
        dst[1..33].copy_from_slice(&self.commitment);
        dst[33..41].copy_from_slice(&self.leaf_index.to_le_bytes());
        dst[41..49].copy_from_slice(&self.deposited_at.to_le_bytes());
    }

    fn unpack_from_slice(src: &[u8]) -> Result<Self, ProgramError> {
        if src.len() < NOTE_LEAF_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(Self {
            bump: src[0],
            commitment: src[1..33].try_into().unwrap(),
            leaf_index: u64::from_le_bytes(src[33..41].try_into().unwrap()),
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
        Ok(Self {
            bump: src[0],
            nullifier: src[1..33].try_into().unwrap(),
            spent_at: i64::from_le_bytes(src[33..41].try_into().unwrap()),
        })
    }
}
