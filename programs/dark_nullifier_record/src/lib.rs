pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

#[cfg(not(test))]
use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey,
};

#[cfg(not(test))]
entrypoint!(process_instruction);

#[cfg(not(test))]
fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    processor::process_instruction(program_id, accounts, instruction_data)
}

#[cfg(test)]
mod tests {
    use crate::{
        error::NullifierRecordError,
        state::{NullifierRecord, NULLIFIER_RECORD_SIZE},
    };
    use solana_program::program_error::ProgramError;

    #[test]
    fn test_nullifier_record_size() {
        assert_eq!(NULLIFIER_RECORD_SIZE, 41);
    }

    #[test]
    fn test_from_bytes_exact_len() {
        let mut data = [0u8; NULLIFIER_RECORD_SIZE];
        data[0] = 7;
        data[1..33].fill(0xab);
        data[33..41].copy_from_slice(&999u64.to_le_bytes());
        let rec = NullifierRecord::from_bytes(&data).expect("should parse");
        assert_eq!(rec.bump, 7);
        assert_eq!(rec.nullifier, [0xabu8; 32]);
        assert_eq!(rec.recorded_at_slot, 999);
    }

    #[test]
    fn test_from_bytes_too_short() {
        let data = [0u8; 40];
        assert!(NullifierRecord::from_bytes(&data).is_none());
    }

    #[test]
    fn test_from_bytes_longer_ok() {
        let data = [1u8; 50];
        assert!(NullifierRecord::from_bytes(&data).is_some());
    }

    #[test]
    fn test_to_bytes_len() {
        let rec = NullifierRecord {
            bump: 1,
            nullifier: [0u8; 32],
            recorded_at_slot: 0,
        };
        assert_eq!(rec.to_bytes().len(), NULLIFIER_RECORD_SIZE);
    }

    #[test]
    fn test_roundtrip() {
        let rec = NullifierRecord {
            bump: 3,
            nullifier: [0x55u8; 32],
            recorded_at_slot: 12_345_678,
        };
        let bytes = rec.to_bytes();
        let rec2 = NullifierRecord::from_bytes(&bytes).unwrap();
        assert_eq!(rec2.bump, rec.bump);
        assert_eq!(rec2.nullifier, rec.nullifier);
        assert_eq!(rec2.recorded_at_slot, rec.recorded_at_slot);
    }

    #[test]
    fn test_bump_preserved() {
        let rec = NullifierRecord {
            bump: 0xff,
            nullifier: [0u8; 32],
            recorded_at_slot: 0,
        };
        assert_eq!(
            NullifierRecord::from_bytes(&rec.to_bytes()).unwrap().bump,
            0xff
        );
    }

    #[test]
    fn test_nullifier_preserved() {
        let rec = NullifierRecord {
            bump: 0,
            nullifier: [0xccu8; 32],
            recorded_at_slot: 0,
        };
        assert_eq!(
            NullifierRecord::from_bytes(&rec.to_bytes())
                .unwrap()
                .nullifier,
            [0xccu8; 32]
        );
    }

    #[test]
    fn test_slot_preserved() {
        let rec = NullifierRecord {
            bump: 0,
            nullifier: [0u8; 32],
            recorded_at_slot: u64::MAX,
        };
        assert_eq!(
            NullifierRecord::from_bytes(&rec.to_bytes())
                .unwrap()
                .recorded_at_slot,
            u64::MAX
        );
    }

    #[test]
    fn test_is_recorded_correct_len_nonzero() {
        let mut data = [0u8; NULLIFIER_RECORD_SIZE];
        data[5] = 1;
        assert!(NullifierRecord::is_recorded(&data));
    }

    #[test]
    fn test_is_recorded_wrong_len() {
        let data = [1u8; 40];
        assert!(!NullifierRecord::is_recorded(&data));
    }

    #[test]
    fn test_is_recorded_all_zeros() {
        let data = [0u8; NULLIFIER_RECORD_SIZE];
        assert!(!NullifierRecord::is_recorded(&data));
    }

    #[test]
    fn test_error_already_recorded_maps_custom_10() {
        let pe: ProgramError = NullifierRecordError::AlreadyRecorded.into();
        assert_eq!(pe, ProgramError::Custom(10));
    }

    #[test]
    fn test_error_invalid_nullifier_maps_custom_11() {
        let pe: ProgramError = NullifierRecordError::InvalidNullifier.into();
        assert_eq!(pe, ProgramError::Custom(11));
    }

    #[test]
    fn test_error_invalid_instruction_data_maps() {
        let pe: ProgramError = NullifierRecordError::InvalidInstructionData.into();
        assert_eq!(pe, ProgramError::InvalidInstructionData);
    }

    #[test]
    fn test_error_display_already_recorded() {
        let msg = NullifierRecordError::AlreadyRecorded.to_string();
        assert!(msg.contains("nullifier already recorded"));
    }
}
