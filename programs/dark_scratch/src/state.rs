// version(1) + bump(1) + owner(32) + expires_at_slot(8) + tag(8) + created_at_slot(8) = 58
pub const SCRATCH_LEN: usize = 58;
pub const SCRATCH_VERSION: u8 = 1;

#[derive(Clone, Copy, Debug)]
pub struct ScratchAccount {
    pub version: u8,
    pub bump: u8,
    pub owner: [u8; 32],
    pub expires_at_slot: u64,
    pub tag: [u8; 8],
    pub created_at_slot: u64,
}

impl ScratchAccount {
    pub fn pack_into(self, dst: &mut [u8]) {
        dst[0] = self.version;
        dst[1] = self.bump;
        dst[2..34].copy_from_slice(&self.owner);
        dst[34..42].copy_from_slice(&self.expires_at_slot.to_le_bytes());
        dst[42..50].copy_from_slice(&self.tag);
        dst[50..58].copy_from_slice(&self.created_at_slot.to_le_bytes());
    }

    pub fn unpack(src: &[u8]) -> Option<Self> {
        if src.len() < SCRATCH_LEN || src[0] != SCRATCH_VERSION {
            return None;
        }
        let mut owner = [0u8; 32];
        owner.copy_from_slice(&src[2..34]);
        let mut exp = [0u8; 8];
        exp.copy_from_slice(&src[34..42]);
        let mut tag = [0u8; 8];
        tag.copy_from_slice(&src[42..50]);
        let mut created = [0u8; 8];
        created.copy_from_slice(&src[50..58]);
        Some(Self {
            version: src[0],
            bump: src[1],
            owner,
            expires_at_slot: u64::from_le_bytes(exp),
            tag,
            created_at_slot: u64::from_le_bytes(created),
        })
    }
}
