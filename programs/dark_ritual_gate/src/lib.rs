use sha2::{Digest, Sha256};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
};

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

// ── SHA256 helper ─────────────────────────────────────────────────────────────

fn sha256_domain(domain: &[u8], inputs: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(domain);
    for i in inputs {
        h.update(i);
    }
    h.finalize().into()
}

// ── Instruction discriminants ─────────────────────────────────────────────────

/// Instruction 0x00: VerifyRitualShape
/// Data layout: [0x00][ritual_type_byte: u8][expected_shape_hash: 32 bytes] = 34 bytes total
///
/// ritual_type_byte:
///   1 = AgentSpendNoCustodyV1
///   2 = ReceiptSoulRedeemV1
///   3 = AlphaCapsuleCommitV1
///   4 = SessionSettlementV1
///   5 = ChaffMaintenanceV1
pub const IX_VERIFY_RITUAL: u8 = 0x00;

/// Instruction 0x01: EchoProof
/// Data layout: [0x01][ritual_hash: 32 bytes] = 33 bytes total
pub const IX_ECHO_PROOF: u8 = 0x01;

// ── Instruction enum ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RitualInstruction {
    VerifyRitualShape {
        ritual_type_byte: u8,
        expected_shape_hash: [u8; 32],
    },
    EchoProof {
        ritual_hash: [u8; 32],
    },
}

/// Parse instruction data into a RitualInstruction.
/// Returns ProgramError::InvalidInstructionData if malformed.
pub fn parse_instruction(data: &[u8]) -> Result<RitualInstruction, ProgramError> {
    if data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }
    match data[0] {
        IX_VERIFY_RITUAL => {
            // Need 34 bytes: [0x00][ritual_type_byte][shape_hash:32]
            if data.len() < 34 {
                return Err(ProgramError::InvalidInstructionData);
            }
            let ritual_type_byte = data[1];
            let mut expected_shape_hash = [0u8; 32];
            expected_shape_hash.copy_from_slice(&data[2..34]);
            Ok(RitualInstruction::VerifyRitualShape {
                ritual_type_byte,
                expected_shape_hash,
            })
        }
        IX_ECHO_PROOF => {
            // Need 33 bytes: [0x01][ritual_hash:32]
            if data.len() < 33 {
                return Err(ProgramError::InvalidInstructionData);
            }
            let mut ritual_hash = [0u8; 32];
            ritual_hash.copy_from_slice(&data[1..33]);
            Ok(RitualInstruction::EchoProof { ritual_hash })
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

// ── Return data encoding ──────────────────────────────────────────────────────

/// 33-byte proof capsule for return data:
/// [verdict_byte: 1][ritual_hash: 32]
/// verdict_byte: 1=Accepted, 2=Rejected, 0=Pending
pub fn encode_proof_return(verdict: u8, ritual_hash: &[u8; 32]) -> [u8; 33] {
    let mut out = [0u8; 33];
    out[0] = verdict;
    out[1..33].copy_from_slice(ritual_hash);
    out
}

// ── Grammar validation (inline, no dependency on ritual-grammar crate) ─────────

/// Required step names for AgentSpendNoCustodyV1 ritual (in order).
pub const AGENT_SPEND_STEPS: &[&str] = &[
    "ComputeBudget",
    "IntentCapsule",
    "PermissionProof",
    "SpendShadow",
    "ReceiptSoul",
    "NullifierInsert",
    "ChaffMaintenance",
];

/// Steps that are required (not optional).
pub const AGENT_SPEND_REQUIRED: &[&str] = &[
    "IntentCapsule",
    "PermissionProof",
    "SpendShadow",
    "ReceiptSoul",
    "NullifierInsert",
];

/// Validate that observed step names satisfy the AgentSpendNoCustodyV1 ritual grammar.
/// Returns Ok(shape_hash) or Err(ProgramError).
///
/// Checks:
/// 1. All required steps present
/// 2. "PermissionProof" appears before "SpendShadow"
/// 3. Compute shape_hash = SHA256("dark_null_v1_ritual_shape" || step_names concatenated)
pub fn validate_agent_spend_ritual(observed_step_names: &[&str]) -> Result<[u8; 32], ProgramError> {
    // 1. Check required steps
    for req in AGENT_SPEND_REQUIRED {
        if !observed_step_names.contains(req) {
            msg!("dark_ritual_gate: missing required step: {}", req);
            return Err(ProgramError::InvalidArgument);
        }
    }

    // 2. Check order: PermissionProof before SpendShadow
    let perm_pos = observed_step_names
        .iter()
        .position(|&s| s == "PermissionProof");
    let spend_pos = observed_step_names.iter().position(|&s| s == "SpendShadow");
    if let (Some(p), Some(s)) = (perm_pos, spend_pos) {
        if p >= s {
            msg!("dark_ritual_gate: PermissionProof must precede SpendShadow");
            return Err(ProgramError::InvalidArgument);
        }
    }

    // 3. Compute shape hash from step names in order
    let step_bytes_list: Vec<Vec<u8>> = observed_step_names
        .iter()
        .map(|s| s.as_bytes().to_vec())
        .collect();
    let slices: Vec<&[u8]> = step_bytes_list.iter().map(|v| v.as_slice()).collect();
    Ok(sha256_domain(b"dark_null_v1_ritual_shape", &slices))
}

// ── Processor ─────────────────────────────────────────────────────────────────

pub fn process_instruction(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let ix = parse_instruction(instruction_data)?;

    match ix {
        RitualInstruction::VerifyRitualShape {
            ritual_type_byte,
            expected_shape_hash,
        } => {
            // Expect accounts: [instructions_sysvar]
            let _instructions_account = next_account_info(accounts_iter)?;

            // For type 1 (AgentSpendNoCustodyV1), validate using inline grammar.
            // In a real deployment, we would read the Instructions sysvar to get the
            // actual transaction instruction list and build observed_step_names from it.
            // Here we validate the expected_shape_hash was correctly precomputed.
            if ritual_type_byte == 1 {
                // Build shape hash from canonical step names for AgentSpendNoCustodyV1
                let canonical_steps = &[
                    "ComputeBudget",
                    "IntentCapsule",
                    "PermissionProof",
                    "SpendShadow",
                    "ReceiptSoul",
                    "NullifierInsert",
                    "ChaffMaintenance",
                ];
                let computed_shape_hash = validate_agent_spend_ritual(canonical_steps)?;
                if computed_shape_hash != expected_shape_hash {
                    msg!("dark_ritual_gate: shape hash mismatch");
                    return Err(ProgramError::InvalidArgument);
                }
                // Set return data: [1=Accepted][ritual_type_hash:32]
                let ritual_type_hash =
                    sha256_domain(b"dark_null_v1_ritual_type", &[&[ritual_type_byte]]);
                let proof_return = encode_proof_return(1, &ritual_type_hash);
                solana_program::program::set_return_data(&proof_return);
                msg!("dark_ritual_gate: ritual ACCEPTED");
            } else {
                msg!(
                    "dark_ritual_gate: unsupported ritual_type_byte {}",
                    ritual_type_byte
                );
                return Err(ProgramError::InvalidArgument);
            }
            Ok(())
        }
        RitualInstruction::EchoProof { ritual_hash } => {
            // Simple: echo back the ritual_hash as proof capsule
            let proof_return = encode_proof_return(1, &ritual_hash);
            solana_program::program::set_return_data(&proof_return);
            msg!("dark_ritual_gate: echo proof");
            Ok(())
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_verify_ritual_instruction() {
        let mut data = [0u8; 34];
        data[0] = 0x00;
        data[1] = 0x01;
        data[2..34].copy_from_slice(&[0xABu8; 32]);
        let ix = parse_instruction(&data).unwrap();
        assert_eq!(
            ix,
            RitualInstruction::VerifyRitualShape {
                ritual_type_byte: 1,
                expected_shape_hash: [0xABu8; 32],
            }
        );
    }

    #[test]
    fn test_parse_echo_proof_instruction() {
        let mut data = [0u8; 33];
        data[0] = 0x01;
        data[1..33].copy_from_slice(&[0xCDu8; 32]);
        let ix = parse_instruction(&data).unwrap();
        assert_eq!(
            ix,
            RitualInstruction::EchoProof {
                ritual_hash: [0xCDu8; 32],
            }
        );
    }

    #[test]
    fn test_parse_empty_data_fails() {
        assert_eq!(
            parse_instruction(&[]),
            Err(ProgramError::InvalidInstructionData)
        );
    }

    #[test]
    fn test_parse_too_short_fails() {
        // Only 3 bytes for a VerifyRitualShape that needs 34
        assert_eq!(
            parse_instruction(&[0x00, 0x01, 0x00]),
            Err(ProgramError::InvalidInstructionData)
        );
    }

    #[test]
    fn test_valid_agent_spend_ritual_passes() {
        let steps = &[
            "ComputeBudget",
            "IntentCapsule",
            "PermissionProof",
            "SpendShadow",
            "ReceiptSoul",
            "NullifierInsert",
            "ChaffMaintenance",
        ];
        let result = validate_agent_spend_ritual(steps);
        assert!(result.is_ok(), "expected Ok but got {:?}", result);
        let shape_hash = result.unwrap();
        assert_ne!(shape_hash, [0u8; 32]);
    }

    #[test]
    fn test_missing_required_step_fails() {
        // No "PermissionProof"
        let steps = &[
            "IntentCapsule",
            "SpendShadow",
            "ReceiptSoul",
            "NullifierInsert",
        ];
        assert_eq!(
            validate_agent_spend_ritual(steps),
            Err(ProgramError::InvalidArgument)
        );
    }

    #[test]
    fn test_wrong_order_fails() {
        // SpendShadow before PermissionProof
        let steps = &[
            "IntentCapsule",
            "SpendShadow",
            "PermissionProof",
            "ReceiptSoul",
            "NullifierInsert",
        ];
        assert_eq!(
            validate_agent_spend_ritual(steps),
            Err(ProgramError::InvalidArgument)
        );
    }

    #[test]
    fn test_shape_hash_deterministic() {
        let steps = &[
            "ComputeBudget",
            "IntentCapsule",
            "PermissionProof",
            "SpendShadow",
            "ReceiptSoul",
            "NullifierInsert",
            "ChaffMaintenance",
        ];
        let hash1 = validate_agent_spend_ritual(steps).unwrap();
        let hash2 = validate_agent_spend_ritual(steps).unwrap();
        assert_eq!(hash1, hash2);

        // Swap last two — should produce different hash
        let steps_swapped = &[
            "ComputeBudget",
            "IntentCapsule",
            "PermissionProof",
            "SpendShadow",
            "ReceiptSoul",
            "ChaffMaintenance",
            "NullifierInsert",
        ];
        let hash3 = validate_agent_spend_ritual(steps_swapped).unwrap();
        assert_ne!(hash1, hash3);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_encode_proof_return_verdict_byte() {
        let hash = [0x11u8; 32];
        let encoded = encode_proof_return(1, &hash);
        assert_eq!(encoded[0], 1);
    }

    #[test]
    fn test_encode_proof_return_hash_embedded() {
        let hash = [0xAAu8; 32];
        let encoded = encode_proof_return(2, &hash);
        assert_eq!(&encoded[1..33], &hash);
    }

    #[test]
    fn test_encode_proof_return_is_33_bytes() {
        let encoded = encode_proof_return(0, &[0u8; 32]);
        assert_eq!(encoded.len(), 33);
    }

    #[test]
    fn test_agent_spend_steps_count() {
        assert_eq!(AGENT_SPEND_STEPS.len(), 7);
    }

    #[test]
    fn test_agent_spend_required_count() {
        assert_eq!(AGENT_SPEND_REQUIRED.len(), 5);
    }

    #[test]
    fn test_unknown_instruction_tag_fails() {
        let data = [0xFF, 0x00, 0x00];
        assert_eq!(
            parse_instruction(&data),
            Err(ProgramError::InvalidInstructionData)
        );
    }

    #[test]
    fn test_shape_hash_nonzero_canonical() {
        let hash = validate_agent_spend_ritual(AGENT_SPEND_STEPS).unwrap();
        assert_ne!(hash, [0u8; 32]);
    }

    #[test]
    fn test_shape_hash_step_name_sensitive() {
        let steps_a: Vec<&str> = AGENT_SPEND_STEPS.to_vec();
        let mut steps_b: Vec<&str> = AGENT_SPEND_STEPS.to_vec();
        steps_b[0] = "DifferentStep"; // Replace ComputeBudget (optional step)
        let hash_a = validate_agent_spend_ritual(&steps_a).unwrap();
        let hash_b = validate_agent_spend_ritual(&steps_b).unwrap();
        assert_ne!(hash_a, hash_b);
    }
}
