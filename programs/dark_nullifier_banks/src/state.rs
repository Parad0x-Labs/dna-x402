use solana_program::{
    program_error::ProgramError,
    program_pack::{IsInitialized, Pack, Sealed},
};

use crate::error::DarkNullError;

pub const BANK_VERSION: u8 = 1;

// version(1) + bump(1) + shard(1) + epoch(8) + count(4) + root(32) + updated_at(8)
pub const NULLIFIER_BANK_LEN: usize = 55;

// bump(1) + inserted_at(8)
pub const NULLIFIER_RECORD_LEN: usize = 9;

// ── NullifierBank (one per shard + epoch) ────────────────────────────────────

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NullifierBank {
    pub version: u8,
    pub bump: u8,
    pub shard: u8,
    pub epoch: u64,
    pub count: u32,
    pub root: [u8; 32],
    pub updated_at: i64,
}

impl Sealed for NullifierBank {}

impl IsInitialized for NullifierBank {
    fn is_initialized(&self) -> bool {
        self.version == BANK_VERSION
    }
}

impl Pack for NullifierBank {
    const LEN: usize = NULLIFIER_BANK_LEN;

    fn unpack_from_slice(src: &[u8]) -> Result<Self, ProgramError> {
        if src.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if src[0] != BANK_VERSION {
            return Err(DarkNullError::InvalidBankAccount.into());
        }
        let version = src[0];
        let bump = src[1];
        let shard = src[2];

        let mut epoch_raw = [0u8; 8];
        epoch_raw.copy_from_slice(&src[3..11]);
        let epoch = u64::from_le_bytes(epoch_raw);

        let mut count_raw = [0u8; 4];
        count_raw.copy_from_slice(&src[11..15]);
        let count = u32::from_le_bytes(count_raw);

        let mut root = [0u8; 32];
        root.copy_from_slice(&src[15..47]);

        let mut updated_at_raw = [0u8; 8];
        updated_at_raw.copy_from_slice(&src[47..55]);
        let updated_at = i64::from_le_bytes(updated_at_raw);

        Ok(Self {
            version,
            bump,
            shard,
            epoch,
            count,
            root,
            updated_at,
        })
    }

    fn pack_into_slice(&self, dst: &mut [u8]) {
        dst.fill(0);
        dst[0] = self.version;
        dst[1] = self.bump;
        dst[2] = self.shard;
        dst[3..11].copy_from_slice(&self.epoch.to_le_bytes());
        dst[11..15].copy_from_slice(&self.count.to_le_bytes());
        dst[15..47].copy_from_slice(&self.root);
        dst[47..55].copy_from_slice(&self.updated_at.to_le_bytes());
    }
}
