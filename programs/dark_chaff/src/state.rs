// version(1) + bump(1) + count(1) + epoch(8) + payer(32) + created_at(8) = 51
pub const CHAFF_BATCH_LEN: usize = 51;
// bump(1) + epoch(8) + index(1) + created_at(8) = 18
pub const CHAFF_INTENT_LEN: usize = 18;

pub const BATCH_VERSION: u8 = 1;
pub const MIN_CHAFF: u8 = 3;
pub const MAX_CHAFF: u8 = 7;
pub const EPOCH_SECONDS: u64 = 3600;

#[derive(Clone, Copy, Debug)]
pub struct ChaffBatch {
    pub version: u8,
    pub bump: u8,
    pub count: u8,
    pub epoch: u64,
    pub payer: [u8; 32],
    pub created_at: i64,
}

impl ChaffBatch {
    pub fn pack_into(self, dst: &mut [u8]) {
        dst[0] = self.version;
        dst[1] = self.bump;
        dst[2] = self.count;
        dst[3..11].copy_from_slice(&self.epoch.to_le_bytes());
        dst[11..43].copy_from_slice(&self.payer);
        dst[43..51].copy_from_slice(&self.created_at.to_le_bytes());
    }

    pub fn unpack(src: &[u8]) -> Option<Self> {
        if src.len() < CHAFF_BATCH_LEN || src[0] != BATCH_VERSION {
            return None;
        }
        let mut epoch_raw = [0u8; 8];
        epoch_raw.copy_from_slice(&src[3..11]);
        let mut payer = [0u8; 32];
        payer.copy_from_slice(&src[11..43]);
        let mut ts_raw = [0u8; 8];
        ts_raw.copy_from_slice(&src[43..51]);
        Some(Self {
            version: src[0],
            bump: src[1],
            count: src[2],
            epoch: u64::from_le_bytes(epoch_raw),
            payer,
            created_at: i64::from_le_bytes(ts_raw),
        })
    }
}
