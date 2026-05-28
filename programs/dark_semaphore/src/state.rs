use solana_program::pubkey::Pubkey;

/// GroupRecord PDA — seeds: [b"group", group_id: [u8; 32]]
///
/// Stores the current Merkle root and group metadata.
/// The admin (who initialized the group) can update the root.
///
/// Size: 8 + 32 + 1 + 4 + 32 = 77 bytes
pub const GROUP_RECORD_SIZE: usize = 77;
/// Discriminator for GroupRecord: SHA-256("dark-semaphore:group-record")[:8]
pub const GROUP_DISC: [u8; 8] = [0x8a, 0x3f, 0x1b, 0xc0, 0x42, 0xe7, 0x96, 0x55];

pub struct GroupRecord {
    pub disc:         [u8; 8],
    pub root:         [u8; 32],
    pub depth:        u8,
    pub member_count: u32,
    pub admin:        Pubkey,
}

impl GroupRecord {
    pub fn pack_into(self, dst: &mut [u8]) {
        dst[0..8].copy_from_slice(&self.disc);
        dst[8..40].copy_from_slice(&self.root);
        dst[40] = self.depth;
        dst[41..45].copy_from_slice(&self.member_count.to_le_bytes());
        dst[45..77].copy_from_slice(self.admin.as_ref());
    }

    pub fn unpack_from(src: &[u8]) -> Option<Self> {
        if src.len() < GROUP_RECORD_SIZE { return None; }
        let mut disc   = [0u8; 8];
        let mut root   = [0u8; 32];
        let mut admin  = [0u8; 32];
        disc.copy_from_slice(&src[0..8]);
        if disc != GROUP_DISC { return None; }
        root.copy_from_slice(&src[8..40]);
        let depth = src[40];
        let mut mc_bytes = [0u8; 4];
        mc_bytes.copy_from_slice(&src[41..45]);
        let member_count = u32::from_le_bytes(mc_bytes);
        admin.copy_from_slice(&src[45..77]);
        Some(Self { disc, root, depth, member_count, admin: Pubkey::from(admin) })
    }
}

/// NullifierRecord PDA — seeds: [b"nullifier", group_id: [u8; 32], nullifier_hash: [u8; 32]]
///
/// Existence = nullifier used. Contains only a discriminator + used flag.
/// Creating this account is atomic with the Signal instruction — if it already
/// exists, the instruction fails with AccountAlreadyInUse.
///
/// Size: 8 + 1 = 9 bytes
pub const NULLIFIER_RECORD_SIZE: usize = 9;
/// Discriminator for NullifierRecord: SHA-256("dark-semaphore:nullifier-record")[:8]
pub const NULLIFIER_DISC: [u8; 8] = [0x2d, 0x7e, 0x91, 0xa4, 0xf3, 0x5c, 0x08, 0xb1];

pub struct NullifierRecord {
    pub disc: [u8; 8],
    pub used: bool,
}

impl NullifierRecord {
    pub fn pack_into(self, dst: &mut [u8]) {
        dst[0..8].copy_from_slice(&self.disc);
        dst[8] = if self.used { 1 } else { 0 };
    }
}
