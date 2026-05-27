pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

pub const BATCH_SEED: &[u8] = b"chaff_batch";
pub const INTENT_SEED: &[u8] = b"chaff_intent";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        error::DarkChaffError,
        state::{
            ChaffBatch, BATCH_VERSION, CHAFF_BATCH_LEN, CHAFF_INTENT_LEN, EPOCH_SECONDS, MAX_CHAFF,
            MIN_CHAFF,
        },
    };

    #[test]
    fn test_batch_seed_content() {
        assert_eq!(BATCH_SEED, b"chaff_batch");
    }

    #[test]
    fn test_intent_seed_content() {
        assert_eq!(INTENT_SEED, b"chaff_intent");
    }

    #[test]
    fn test_batch_seed_len() {
        assert_eq!(BATCH_SEED.len(), 11);
    }

    #[test]
    fn test_intent_seed_len() {
        assert_eq!(INTENT_SEED.len(), 12);
    }

    #[test]
    fn test_min_chaff_value() {
        assert_eq!(MIN_CHAFF, 3);
    }

    #[test]
    fn test_max_chaff_value() {
        assert_eq!(MAX_CHAFF, 7);
    }

    #[test]
    fn test_batch_version() {
        assert_eq!(BATCH_VERSION, 1);
    }

    #[test]
    fn test_epoch_seconds() {
        assert_eq!(EPOCH_SECONDS, 3600);
    }

    #[test]
    fn test_chaff_batch_len() {
        assert_eq!(CHAFF_BATCH_LEN, 51);
    }

    #[test]
    fn test_chaff_intent_len() {
        assert_eq!(CHAFF_INTENT_LEN, 18);
    }

    #[test]
    fn test_chaff_batch_pack_unpack_roundtrip() {
        let batch = ChaffBatch {
            version: BATCH_VERSION,
            bump: 3,
            count: 5,
            epoch: 99,
            payer: [0xabu8; 32],
            created_at: 1_700_000_000,
        };
        let mut buf = [0u8; CHAFF_BATCH_LEN];
        batch.pack_into(&mut buf);
        let unpacked = ChaffBatch::unpack(&buf).expect("should unpack");
        assert_eq!(unpacked.version, batch.version);
        assert_eq!(unpacked.bump, batch.bump);
        assert_eq!(unpacked.count, batch.count);
        assert_eq!(unpacked.epoch, batch.epoch);
        assert_eq!(unpacked.payer, batch.payer);
        assert_eq!(unpacked.created_at, batch.created_at);
    }

    #[test]
    fn test_error_missing_payer_sig_code() {
        assert_eq!(DarkChaffError::MissingPayerSignature as u32, 0);
    }

    #[test]
    fn test_error_invalid_batch_pda_code() {
        assert_eq!(DarkChaffError::InvalidBatchPda as u32, 1);
    }

    #[test]
    fn test_error_invalid_count_code() {
        assert_eq!(DarkChaffError::InvalidCount as u32, 4);
    }

    #[test]
    fn test_error_future_epoch_code() {
        assert_eq!(DarkChaffError::FutureEpoch as u32, 5);
    }

    #[test]
    fn test_error_invalid_instruction_code() {
        assert_eq!(DarkChaffError::InvalidInstruction as u32, 8);
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
