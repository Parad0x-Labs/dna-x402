pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

#[cfg(not(feature = "no-entrypoint"))]
use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey,
};

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

#[cfg(not(feature = "no-entrypoint"))]
fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    processor::process(program_id, accounts, instruction_data)
}

#[cfg(test)]
mod tests {
    use crate::{
        error::ReceiptAnchorError,
        state::{AnchorBucket, ANCHOR_BUCKET_ACCOUNT_LEN, BUCKET_STATE_VERSION},
    };
    use solana_program::program_pack::{IsInitialized, Pack};

    #[test]
    fn test_bucket_state_version() {
        assert_eq!(BUCKET_STATE_VERSION, 1);
    }

    #[test]
    fn test_anchor_bucket_account_len() {
        assert_eq!(ANCHOR_BUCKET_ACCOUNT_LEN, 54);
    }

    #[test]
    fn test_anchor_bucket_len_eq_constant() {
        assert_eq!(AnchorBucket::LEN, ANCHOR_BUCKET_ACCOUNT_LEN);
    }

    #[test]
    fn test_anchor_bucket_default_not_initialized() {
        let b = AnchorBucket::default();
        assert!(!b.is_initialized());
    }

    #[test]
    fn test_anchor_bucket_initialized_after_version_set() {
        let b = AnchorBucket {
            version: BUCKET_STATE_VERSION,
            ..AnchorBucket::default()
        };
        assert!(b.is_initialized());
    }

    #[test]
    fn test_anchor_bucket_pack_unpack_roundtrip() {
        let bucket = AnchorBucket {
            version: BUCKET_STATE_VERSION,
            bump: 7,
            bucket_id: 42,
            count: 3,
            root: [0xabu8; 32],
            updated_at: 99_999,
        };
        let mut buf = [0u8; ANCHOR_BUCKET_ACCOUNT_LEN];
        bucket.pack_into_slice(&mut buf);
        let unpacked = AnchorBucket::unpack_from_slice(&buf).unwrap();
        assert_eq!(unpacked, bucket);
    }

    #[test]
    fn test_root_preserved() {
        let bucket = AnchorBucket {
            version: BUCKET_STATE_VERSION,
            bump: 1,
            bucket_id: 0,
            count: 0,
            root: [0x77u8; 32],
            updated_at: 0,
        };
        let mut buf = [0u8; ANCHOR_BUCKET_ACCOUNT_LEN];
        bucket.pack_into_slice(&mut buf);
        let unpacked = AnchorBucket::unpack_from_slice(&buf).unwrap();
        assert_eq!(unpacked.root, [0x77u8; 32]);
    }

    #[test]
    fn test_bucket_id_preserved() {
        let bucket = AnchorBucket {
            version: BUCKET_STATE_VERSION,
            bump: 1,
            bucket_id: u64::MAX,
            count: 0,
            root: [0u8; 32],
            updated_at: 0,
        };
        let mut buf = [0u8; ANCHOR_BUCKET_ACCOUNT_LEN];
        bucket.pack_into_slice(&mut buf);
        let unpacked = AnchorBucket::unpack_from_slice(&buf).unwrap();
        assert_eq!(unpacked.bucket_id, u64::MAX);
    }

    #[test]
    fn test_error_invalid_instruction_code() {
        assert_eq!(ReceiptAnchorError::InvalidInstruction as u32, 0);
    }

    #[test]
    fn test_error_invalid_version_code() {
        assert_eq!(ReceiptAnchorError::InvalidVersion as u32, 1);
    }

    #[test]
    fn test_error_invalid_batch_length_code() {
        assert_eq!(ReceiptAnchorError::InvalidBatchLength as u32, 2);
    }

    #[test]
    fn test_error_invalid_bucket_pda_code() {
        assert_eq!(ReceiptAnchorError::InvalidBucketPda as u32, 3);
    }

    #[test]
    fn test_error_missing_payer_sig_code() {
        assert_eq!(ReceiptAnchorError::MissingPayerSignature as u32, 4);
    }

    #[test]
    fn test_error_invalid_bucket_account_code() {
        assert_eq!(ReceiptAnchorError::InvalidBucketAccount as u32, 5);
    }

    #[test]
    fn test_error_missing_system_program_code() {
        assert_eq!(ReceiptAnchorError::MissingSystemProgram as u32, 6);
    }

    #[test]
    fn test_error_arithmetic_overflow_code() {
        assert_eq!(ReceiptAnchorError::ArithmeticOverflow as u32, 8);
    }
}
