pub mod error;
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
        error::GateError,
        state::{VerificationRecord, GATE_RECORD_SIZE},
    };
    use solana_program::program_error::ProgramError;

    #[test]
    fn test_gate_record_size() {
        assert_eq!(GATE_RECORD_SIZE, 81);
    }

    #[test]
    fn test_gate_record_size_components() {
        assert_eq!(32 + 32 + 8 + 8 + 1, GATE_RECORD_SIZE);
    }

    #[test]
    fn test_verification_record_is_verified_true() {
        let rec = VerificationRecord {
            merkle_root: [0u8; 32],
            nullifier: [0u8; 32],
            amount: 0,
            verified_at_slot: 0,
            is_verified: true,
        };
        assert!(rec.is_verified);
    }

    #[test]
    fn test_verification_record_is_verified_false() {
        let rec = VerificationRecord {
            merkle_root: [0u8; 32],
            nullifier: [0u8; 32],
            amount: 0,
            verified_at_slot: 0,
            is_verified: false,
        };
        assert!(!rec.is_verified);
    }

    #[test]
    fn test_verification_record_amount_preserved() {
        let rec = VerificationRecord {
            merkle_root: [0u8; 32],
            nullifier: [0u8; 32],
            amount: 1_000_000,
            verified_at_slot: 0,
            is_verified: false,
        };
        assert_eq!(rec.amount, 1_000_000);
    }

    #[test]
    fn test_verification_record_nullifier_preserved() {
        let rec = VerificationRecord {
            merkle_root: [0u8; 32],
            nullifier: [0xddu8; 32],
            amount: 0,
            verified_at_slot: 0,
            is_verified: false,
        };
        assert_eq!(rec.nullifier, [0xddu8; 32]);
    }

    #[test]
    fn test_error_invalid_length_maps_to_invalid_instruction_data() {
        let pe: ProgramError = GateError::InvalidInstructionLength.into();
        assert_eq!(pe, ProgramError::InvalidInstructionData);
    }

    #[test]
    fn test_error_proof_failed_maps_to_custom_1() {
        let pe: ProgramError = GateError::ProofVerificationFailed.into();
        assert_eq!(pe, ProgramError::Custom(1));
    }

    #[test]
    fn test_error_invalid_amount_maps_to_invalid_instruction_data() {
        let pe: ProgramError = GateError::InvalidAmountEncoding.into();
        assert_eq!(pe, ProgramError::InvalidInstructionData);
    }

    #[test]
    fn test_error_display_invalid_length_contains_352() {
        let msg = GateError::InvalidInstructionLength.to_string();
        assert!(msg.contains("352"));
    }

    #[test]
    fn test_error_display_proof_failed() {
        let msg = GateError::ProofVerificationFailed.to_string();
        assert!(msg.contains("BN254 Groth16 proof verification failed"));
    }

    #[test]
    fn test_error_display_invalid_amount() {
        let msg = GateError::InvalidAmountEncoding.to_string();
        assert!(msg.contains("u64"));
    }

    #[test]
    fn test_error_equality_invalid_length() {
        assert_eq!(
            GateError::InvalidInstructionLength,
            GateError::InvalidInstructionLength
        );
    }

    #[test]
    fn test_error_equality_proof_failed() {
        assert_eq!(
            GateError::ProofVerificationFailed,
            GateError::ProofVerificationFailed
        );
    }

    #[test]
    fn test_error_equality_invalid_amount() {
        assert_eq!(
            GateError::InvalidAmountEncoding,
            GateError::InvalidAmountEncoding
        );
    }

    #[test]
    fn test_merkle_root_preserved() {
        let rec = VerificationRecord {
            merkle_root: [0x42u8; 32],
            nullifier: [0u8; 32],
            amount: 0,
            verified_at_slot: 0,
            is_verified: false,
        };
        assert_eq!(rec.merkle_root, [0x42u8; 32]);
    }
}
