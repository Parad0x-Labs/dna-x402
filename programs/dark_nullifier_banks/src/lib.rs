pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

pub use processor::bank_index;

pub const BANK_SEED: &[u8] = b"null_bank";
pub const NULL_REC_SEED: &[u8] = b"null_rec";
pub const DOMAIN: &[u8] = b"dark_null_v1";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        error::DarkNullError,
        state::{NullifierBank, BANK_VERSION, NULLIFIER_BANK_LEN, NULLIFIER_RECORD_LEN},
    };
    use solana_program::program_pack::IsInitialized;

    #[test]
    fn test_bank_seed_content() {
        assert_eq!(BANK_SEED, b"null_bank");
    }

    #[test]
    fn test_null_rec_seed_content() {
        assert_eq!(NULL_REC_SEED, b"null_rec");
    }

    #[test]
    fn test_domain_content() {
        assert_eq!(DOMAIN, b"dark_null_v1");
    }

    #[test]
    fn test_bank_seed_len() {
        assert_eq!(BANK_SEED.len(), 9);
    }

    #[test]
    fn test_null_rec_seed_len() {
        assert_eq!(NULL_REC_SEED.len(), 8);
    }

    #[test]
    fn test_domain_len() {
        assert_eq!(DOMAIN.len(), 12);
    }

    #[test]
    fn test_bank_index_deterministic() {
        let null = [0x11u8; 32];
        let a = bank_index(&null, 1, DOMAIN);
        let b = bank_index(&null, 1, DOMAIN);
        assert_eq!(a, b);
    }

    #[test]
    fn test_bank_index_epoch_sensitive() {
        let null = [0xAAu8; 32];
        assert_ne!(bank_index(&null, 0, DOMAIN), bank_index(&null, 1, DOMAIN));
    }

    #[test]
    fn test_nullifier_bank_len() {
        assert_eq!(NULLIFIER_BANK_LEN, 55);
    }

    #[test]
    fn test_nullifier_record_len() {
        assert_eq!(NULLIFIER_RECORD_LEN, 9);
    }

    #[test]
    fn test_bank_version() {
        assert_eq!(BANK_VERSION, 1);
    }

    #[test]
    fn test_error_missing_payer_sig_code() {
        assert_eq!(DarkNullError::MissingPayerSignature as u32, 0);
    }

    #[test]
    fn test_error_invalid_bank_account_code() {
        assert_eq!(DarkNullError::InvalidBankAccount as u32, 1);
    }

    #[test]
    fn test_error_wrong_shard_code() {
        assert_eq!(DarkNullError::WrongShard as u32, 5);
    }

    #[test]
    fn test_error_duplicate_nullifier_code() {
        assert_eq!(DarkNullError::DuplicateNullifier as u32, 6);
    }

    #[test]
    fn test_null_bank_default_not_initialized() {
        let bank = NullifierBank::default();
        assert!(!bank.is_initialized());
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
