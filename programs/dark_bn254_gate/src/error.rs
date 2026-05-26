use solana_program::program_error::ProgramError;
use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub enum GateError {
    InvalidInstructionLength,
    ProofVerificationFailed,
    InvalidAmountEncoding,
}

impl fmt::Display for GateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GateError::InvalidInstructionLength => {
                write!(
                    f,
                    "dark_bn254_gate: instruction data must be exactly 352 bytes"
                )
            }
            GateError::ProofVerificationFailed => {
                write!(
                    f,
                    "dark_bn254_gate: BN254 Groth16 proof verification failed"
                )
            }
            GateError::InvalidAmountEncoding => {
                write!(
                    f,
                    "dark_bn254_gate: amount bytes could not be decoded as u64"
                )
            }
        }
    }
}

impl From<GateError> for ProgramError {
    fn from(e: GateError) -> Self {
        match e {
            GateError::InvalidInstructionLength => ProgramError::InvalidInstructionData,
            GateError::ProofVerificationFailed => ProgramError::Custom(1),
            GateError::InvalidAmountEncoding => ProgramError::InvalidInstructionData,
        }
    }
}
