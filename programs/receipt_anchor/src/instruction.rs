use solana_program::program_error::ProgramError;

use crate::error::ReceiptAnchorError;

pub const INSTRUCTION_VERSION_V1: u8 = 1;
pub const FLAG_HAS_BUCKET_ID: u8 = 1 << 0;
pub const SINGLE_LEN_NO_BUCKET: usize = 34;
pub const SINGLE_LEN_WITH_BUCKET: usize = 42;
pub const BATCH_PREFIX_LEN: usize = 2;
pub const ANCHOR_BYTES: usize = 32;
pub const MAX_BATCH_ANCHORS: usize = 32;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AnchorV1Single {
    pub version: u8,
    pub flags: u8,
    pub anchor32: [u8; ANCHOR_BYTES],
    pub bucket_id: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AnchorV1Batch {
    pub version: u8,
    pub count: u8,
    pub anchors: Vec<[u8; ANCHOR_BYTES]>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReceiptAnchorInstruction {
    AnchorSingle(AnchorV1Single),
    AnchorBatch(AnchorV1Batch),
}

impl ReceiptAnchorInstruction {
    pub fn unpack(input: &[u8]) -> Result<Self, ProgramError> {
        if input.len() == SINGLE_LEN_NO_BUCKET || input.len() == SINGLE_LEN_WITH_BUCKET {
            return Self::unpack_single(input);
        }
        Self::unpack_batch(input)
    }

    fn unpack_single(input: &[u8]) -> Result<Self, ProgramError> {
        if input.len() != SINGLE_LEN_NO_BUCKET && input.len() != SINGLE_LEN_WITH_BUCKET {
            return Err(ReceiptAnchorError::InvalidInstruction.into());
        }

        let version = input[0];
        if version != INSTRUCTION_VERSION_V1 {
            return Err(ReceiptAnchorError::InvalidVersion.into());
        }

        let flags = input[1];
        let mut anchor32 = [0u8; ANCHOR_BYTES];
        anchor32.copy_from_slice(&input[2..SINGLE_LEN_NO_BUCKET]);

        let bucket_id = if input.len() == SINGLE_LEN_WITH_BUCKET {
            if (flags & FLAG_HAS_BUCKET_ID) == 0 {
                return Err(ReceiptAnchorError::InvalidInstruction.into());
            }
            let mut raw = [0u8; 8];
            raw.copy_from_slice(&input[SINGLE_LEN_NO_BUCKET..SINGLE_LEN_WITH_BUCKET]);
            Some(u64::from_le_bytes(raw))
        } else {
            if (flags & FLAG_HAS_BUCKET_ID) != 0 {
                return Err(ReceiptAnchorError::InvalidInstruction.into());
            }
            None
        };

        Ok(Self::AnchorSingle(AnchorV1Single {
            version,
            flags,
            anchor32,
            bucket_id,
        }))
    }

    fn unpack_batch(input: &[u8]) -> Result<Self, ProgramError> {
        if input.len() < BATCH_PREFIX_LEN + ANCHOR_BYTES * 2 {
            return Err(ReceiptAnchorError::InvalidInstruction.into());
        }

        let version = input[0];
        if version != INSTRUCTION_VERSION_V1 {
            return Err(ReceiptAnchorError::InvalidVersion.into());
        }

        let count = input[1] as usize;
        if count < 2 || count > MAX_BATCH_ANCHORS {
            return Err(ReceiptAnchorError::InvalidBatchLength.into());
        }

        let expected_len = BATCH_PREFIX_LEN + count * ANCHOR_BYTES;
        if input.len() != expected_len {
            return Err(ReceiptAnchorError::InvalidBatchLength.into());
        }

        let mut anchors = Vec::with_capacity(count);
        for index in 0..count {
            let start = BATCH_PREFIX_LEN + index * ANCHOR_BYTES;
            let end = start + ANCHOR_BYTES;
            let mut anchor = [0u8; ANCHOR_BYTES];
            anchor.copy_from_slice(&input[start..end]);
            anchors.push(anchor);
        }

        Ok(Self::AnchorBatch(AnchorV1Batch {
            version,
            count: count as u8,
            anchors,
        }))
    }
}
