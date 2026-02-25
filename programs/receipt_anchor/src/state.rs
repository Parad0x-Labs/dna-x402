use solana_program::{
    program_error::ProgramError,
    program_pack::{IsInitialized, Pack, Sealed},
};

use crate::error::ReceiptAnchorError;

pub const BUCKET_STATE_VERSION: u8 = 1;
pub const ANCHOR_BUCKET_ACCOUNT_LEN: usize = 1 + 1 + 8 + 4 + 32 + 8;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct AnchorBucket {
    pub version: u8,
    pub bump: u8,
    pub bucket_id: u64,
    pub count: u32,
    pub root: [u8; 32],
    pub updated_at: i64,
}

impl Sealed for AnchorBucket {}

impl IsInitialized for AnchorBucket {
    fn is_initialized(&self) -> bool {
        self.version == BUCKET_STATE_VERSION
    }
}

impl Pack for AnchorBucket {
    const LEN: usize = ANCHOR_BUCKET_ACCOUNT_LEN;

    fn unpack_from_slice(src: &[u8]) -> Result<Self, ProgramError> {
        if src.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }

        let version = src[0];
        if version != BUCKET_STATE_VERSION {
            return Err(ReceiptAnchorError::BucketStateMismatch.into());
        }

        let bump = src[1];

        let mut bucket_id_raw = [0u8; 8];
        bucket_id_raw.copy_from_slice(&src[2..10]);
        let bucket_id = u64::from_le_bytes(bucket_id_raw);

        let mut count_raw = [0u8; 4];
        count_raw.copy_from_slice(&src[10..14]);
        let count = u32::from_le_bytes(count_raw);

        let mut root = [0u8; 32];
        root.copy_from_slice(&src[14..46]);

        let mut updated_at_raw = [0u8; 8];
        updated_at_raw.copy_from_slice(&src[46..54]);
        let updated_at = i64::from_le_bytes(updated_at_raw);

        Ok(Self {
            version,
            bump,
            bucket_id,
            count,
            root,
            updated_at,
        })
    }

    fn pack_into_slice(&self, dst: &mut [u8]) {
        dst.fill(0);
        dst[0] = self.version;
        dst[1] = self.bump;
        dst[2..10].copy_from_slice(&self.bucket_id.to_le_bytes());
        dst[10..14].copy_from_slice(&self.count.to_le_bytes());
        dst[14..46].copy_from_slice(&self.root);
        dst[46..54].copy_from_slice(&self.updated_at.to_le_bytes());
    }
}
