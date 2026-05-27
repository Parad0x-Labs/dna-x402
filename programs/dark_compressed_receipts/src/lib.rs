pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

pub const ROOT_SEED: &[u8] = b"receipt_root";
pub const NULL_SEED: &[u8] = b"receipt_null";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        error::ReceiptError,
        state::{ReceiptRoot, RECEIPT_NULLIFIER_LEN, RECEIPT_ROOT_LEN, ROOT_VERSION},
    };
    use solana_program::program_pack::{IsInitialized, Pack};

    #[test]
    fn test_root_seed_content() {
        assert_eq!(ROOT_SEED, b"receipt_root");
    }

    #[test]
    fn test_null_seed_content() {
        assert_eq!(NULL_SEED, b"receipt_null");
    }

    #[test]
    fn test_root_seed_len() {
        assert_eq!(ROOT_SEED.len(), 12);
    }

    #[test]
    fn test_null_seed_len() {
        assert_eq!(NULL_SEED.len(), 12);
    }

    #[test]
    fn test_receipt_root_len() {
        assert_eq!(RECEIPT_ROOT_LEN, 78);
    }

    #[test]
    fn test_receipt_nullifier_len() {
        assert_eq!(RECEIPT_NULLIFIER_LEN, 9);
    }

    #[test]
    fn test_root_version() {
        assert_eq!(ROOT_VERSION, 1);
    }

    #[test]
    fn test_receipt_root_default_not_initialized() {
        let rr = ReceiptRoot::default();
        assert!(!rr.is_initialized());
    }

    #[test]
    fn test_receipt_root_pack_len() {
        assert_eq!(ReceiptRoot::LEN, RECEIPT_ROOT_LEN);
    }

    #[test]
    fn test_receipt_root_pack_unpack_roundtrip() {
        let rr = ReceiptRoot {
            version: ROOT_VERSION,
            bump: 5,
            authority: [0x11u8; 32],
            root: [0x22u8; 32],
            count: 10,
            updated_at: 1_700_000_000,
        };
        let mut buf = [0u8; RECEIPT_ROOT_LEN];
        rr.pack_into_slice(&mut buf);
        let unpacked = ReceiptRoot::unpack_from_slice(&buf).expect("should unpack");
        assert_eq!(unpacked, rr);
    }

    #[test]
    fn test_error_missing_authority_code() {
        assert_eq!(ReceiptError::MissingAuthority as u32, 0);
    }

    #[test]
    fn test_error_invalid_root_pda_code() {
        assert_eq!(ReceiptError::InvalidRootPda as u32, 1);
    }

    #[test]
    fn test_error_already_redeemed_code() {
        assert_eq!(ReceiptError::AlreadyRedeemed as u32, 4);
    }

    #[test]
    fn test_error_arithmetic_overflow_code() {
        assert_eq!(ReceiptError::ArithmeticOverflow as u32, 5);
    }

    #[test]
    fn test_error_uninitialized_root_code() {
        assert_eq!(ReceiptError::UninitializedRoot as u32, 7);
    }

    #[test]
    fn test_error_wrong_authority_code() {
        assert_eq!(ReceiptError::WrongAuthority as u32, 8);
    }
}

#[cfg(not(feature = "no-entrypoint"))]
mod entrypoint {
    use crate::processor::process;
    use solana_program::{
        account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey,
    };
    entrypoint!(process_instruction);
    fn process_instruction(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        data: &[u8],
    ) -> ProgramResult {
        process(program_id, accounts, data)
    }
}
