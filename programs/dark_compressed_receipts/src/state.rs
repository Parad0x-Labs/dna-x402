use crate::error::ReceiptError;
use solana_program::{
    program_error::ProgramError,
    program_pack::{IsInitialized, Pack, Sealed},
};

pub const ROOT_VERSION: u8 = 1;
// version(1) + bump(1) + authority(32) + root(32) + count(4) + updated_at(8) = 78
pub const RECEIPT_ROOT_LEN: usize = 78;
// bump(1) + redeemed_at(8) = 9
pub const RECEIPT_NULLIFIER_LEN: usize = 9;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ReceiptRoot {
    pub version: u8,
    pub bump: u8,
    pub authority: [u8; 32],
    pub root: [u8; 32],
    pub count: u32,
    pub updated_at: i64,
}

impl Sealed for ReceiptRoot {}

impl IsInitialized for ReceiptRoot {
    fn is_initialized(&self) -> bool {
        self.version == ROOT_VERSION
    }
}

impl Pack for ReceiptRoot {
    const LEN: usize = RECEIPT_ROOT_LEN;

    fn unpack_from_slice(src: &[u8]) -> Result<Self, ProgramError> {
        if src.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if src[0] != ROOT_VERSION {
            return Err(ReceiptError::UninitializedRoot.into());
        }

        let version = src[0];
        let bump = src[1];

        let mut authority = [0u8; 32];
        authority.copy_from_slice(&src[2..34]);

        let mut root = [0u8; 32];
        root.copy_from_slice(&src[34..66]);

        let mut count_raw = [0u8; 4];
        count_raw.copy_from_slice(&src[66..70]);
        let count = u32::from_le_bytes(count_raw);

        let mut ts_raw = [0u8; 8];
        ts_raw.copy_from_slice(&src[70..78]);
        let updated_at = i64::from_le_bytes(ts_raw);

        Ok(Self {
            version,
            bump,
            authority,
            root,
            count,
            updated_at,
        })
    }

    fn pack_into_slice(&self, dst: &mut [u8]) {
        dst.fill(0);
        dst[0] = self.version;
        dst[1] = self.bump;
        dst[2..34].copy_from_slice(&self.authority);
        dst[34..66].copy_from_slice(&self.root);
        dst[66..70].copy_from_slice(&self.count.to_le_bytes());
        dst[70..78].copy_from_slice(&self.updated_at.to_le_bytes());
    }
}
