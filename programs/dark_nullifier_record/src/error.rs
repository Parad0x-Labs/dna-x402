use solana_program::program_error::ProgramError;
use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub enum NullifierRecordError {
    /// Nullifier has already been recorded in this PDA.
    AlreadyRecorded,
    /// Instruction data has the wrong length.
    InvalidInstructionData,
    /// Nullifier is all zeros — not a valid spent nullifier.
    InvalidNullifier,
}

impl fmt::Display for NullifierRecordError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            NullifierRecordError::AlreadyRecorded => {
                write!(f, "dark_nullifier_record: nullifier already recorded")
            }
            NullifierRecordError::InvalidInstructionData => {
                write!(
                    f,
                    "dark_nullifier_record: instruction data must be exactly 33 bytes"
                )
            }
            NullifierRecordError::InvalidNullifier => {
                write!(f, "dark_nullifier_record: all-zero nullifier is not valid")
            }
        }
    }
}

impl From<NullifierRecordError> for ProgramError {
    fn from(e: NullifierRecordError) -> Self {
        match e {
            NullifierRecordError::AlreadyRecorded => ProgramError::Custom(10),
            NullifierRecordError::InvalidInstructionData => ProgramError::InvalidInstructionData,
            NullifierRecordError::InvalidNullifier => ProgramError::Custom(11),
        }
    }
}
