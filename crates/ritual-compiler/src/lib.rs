use ritual_grammar::{
    default_grammar, validate_ritual, ObservedStep, RitualObservation, RitualType,
};
use ritual_proof_capsule::{RitualProofCapsule, RitualVerdict};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── SHA256 helpers ────────────────────────────────────────────────────────────

fn sha256_domain(domain: &[u8], inputs: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(domain);
    for i in inputs {
        h.update(i);
    }
    h.finalize().into()
}

fn _hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ── Program ID placeholder hashes ─────────────────────────────────────────────

/// Canonical placeholder hash for a program role, used when compiling ritual plans offline.
pub fn program_hash(role: &str) -> [u8; 32] {
    sha256_domain(b"dark_null_v1_program_role", &[role.as_bytes()])
}

// ── Input / Output types ──────────────────────────────────────────────────────

/// Pre-hashed inputs for compiling a ritual.
/// Caller extracts hashes from the primitive objects before calling compile_ritual.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RitualInput {
    pub ritual_type: String,          // "AgentSpendNoCustodyV1" etc.
    pub permission_hash: [u8; 32],    // AgentPermissionNote.note_hash()
    pub spend_hash: [u8; 32],         // PermissionSpend.nullifier
    pub shadow_bundle_hash: [u8; 32], // ShadowBundle.bundle_id
    pub receipt_soul_hash: [u8; 32],  // ReceiptSoul.soul_hash()
    pub settlement_root: [u8; 32],    // SessionSettlementRoot.root
    pub no_custody_hash: [u8; 32],    // NoCustodyCapsule.capsule_hash()
    pub max_spend_lamports: u64,
    pub withdraw_allowed: bool, // MUST be false for a valid ritual
}

/// One compiled instruction step.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstructionPlan {
    pub step_name: String,
    pub program_role: String,
    pub data_hash: [u8; 32],
    pub step_index: usize,
}

/// A compiled ritual plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RitualPlan {
    pub ritual_type: String,
    pub instructions: Vec<InstructionPlan>,
    pub expected_shape_hash: [u8; 32],
    pub expected_ritual_hash: [u8; 32],
    pub human_summary_hash: [u8; 32],
    pub withdraw_instruction_present: bool,
    pub public_summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompilerError {
    WithdrawInstructionForbidden,
    InvalidRitualType { found: String },
    RitualValidationFailed { reason: String },
}

// ── Program role helper ───────────────────────────────────────────────────────

fn role_for_step(step_name: &str) -> &'static str {
    match step_name {
        "ComputeBudget" => "ComputeBudget",
        "IntentCapsule" | "PermissionProof" | "SpendShadow" | "ReceiptSoul" => "DarkRitualGate",
        "NullifierInsert" => "DarkNullifierBanks",
        "ChaffMaintenance" => "DarkChaff",
        _ => "Unknown",
    }
}

// ── compile_ritual ────────────────────────────────────────────────────────────

/// Compile a RitualInput into a (RitualPlan, RitualProofCapsule).
pub fn compile_ritual(
    input: &RitualInput,
) -> Result<(RitualPlan, RitualProofCapsule), CompilerError> {
    // Step 1: withdraw guard
    if input.withdraw_allowed {
        return Err(CompilerError::WithdrawInstructionForbidden);
    }

    // Step 2: parse ritual type
    let ritual_type = match input.ritual_type.as_str() {
        "AgentSpendNoCustodyV1" => RitualType::AgentSpendNoCustodyV1,
        "ReceiptSoulRedeemV1" => RitualType::ReceiptSoulRedeemV1,
        "AlphaCapsuleCommitV1" => RitualType::AlphaCapsuleCommitV1,
        "SessionSettlementV1" => RitualType::SessionSettlementV1,
        "ChaffMaintenanceV1" => RitualType::ChaffMaintenanceV1,
        other => {
            return Err(CompilerError::InvalidRitualType {
                found: other.to_string(),
            });
        }
    };

    // Step 3: build ordered ObservedStep list
    let observed_steps: Vec<ObservedStep> = match &ritual_type {
        RitualType::AgentSpendNoCustodyV1 => vec![
            ObservedStep {
                step_name: "ComputeBudget".to_string(),
                program_id_hash: program_hash("ComputeBudget"),
                instruction_data_hash: sha256_domain(b"dark_null_v1_compute_budget", &[]),
            },
            ObservedStep {
                step_name: "IntentCapsule".to_string(),
                program_id_hash: program_hash("DarkRitualGate"),
                instruction_data_hash: sha256_domain(
                    b"dark_null_v1_intent",
                    &[&input.permission_hash],
                ),
            },
            ObservedStep {
                step_name: "PermissionProof".to_string(),
                program_id_hash: program_hash("DarkRitualGate"),
                instruction_data_hash: input.permission_hash,
            },
            ObservedStep {
                step_name: "SpendShadow".to_string(),
                program_id_hash: program_hash("DarkRitualGate"),
                instruction_data_hash: sha256_domain(
                    b"dark_null_v1_shadow",
                    &[&input.spend_hash, &input.shadow_bundle_hash],
                ),
            },
            ObservedStep {
                step_name: "ReceiptSoul".to_string(),
                program_id_hash: program_hash("DarkRitualGate"),
                instruction_data_hash: input.receipt_soul_hash,
            },
            ObservedStep {
                step_name: "NullifierInsert".to_string(),
                program_id_hash: program_hash("DarkNullifierBanks"),
                instruction_data_hash: input.settlement_root,
            },
            ObservedStep {
                step_name: "ChaffMaintenance".to_string(),
                program_id_hash: program_hash("DarkChaff"),
                instruction_data_hash: sha256_domain(
                    b"dark_null_v1_chaff_maint",
                    &[&input.no_custody_hash],
                ),
            },
        ],
        other => {
            let label = other.label();
            vec![
                ObservedStep {
                    step_name: format!("{}Main", label),
                    program_id_hash: program_hash("DarkRitualGate"),
                    instruction_data_hash: input.permission_hash,
                },
                ObservedStep {
                    step_name: format!("{}Settle", label),
                    program_id_hash: program_hash("DarkNullifierBanks"),
                    instruction_data_hash: input.settlement_root,
                },
            ]
        }
    };

    // Step 4: build RitualObservation
    let observation = RitualObservation {
        ritual_type: ritual_type.clone(),
        observed_steps: observed_steps.clone(),
        forbidden_program_hashes: vec![],
    };

    // Step 5: validate via grammar
    let grammar = default_grammar(&ritual_type);
    let shape_hash = validate_ritual(&grammar, &observation).map_err(|v| {
        CompilerError::RitualValidationFailed {
            reason: format!("{:?}", v),
        }
    })?;

    // Step 6: build InstructionPlan list
    let instructions: Vec<InstructionPlan> = observed_steps
        .iter()
        .enumerate()
        .map(|(idx, step)| InstructionPlan {
            step_name: step.step_name.clone(),
            program_role: role_for_step(&step.step_name).to_string(),
            data_hash: step.instruction_data_hash,
            step_index: idx,
        })
        .collect();

    // Step 7: expected_ritual_hash
    let max_spend_le8 = input.max_spend_lamports.to_le_bytes();
    let expected_ritual_hash = sha256_domain(
        b"dark_null_v1_ritual",
        &[
            &input.permission_hash,
            &input.spend_hash,
            &input.shadow_bundle_hash,
            &input.receipt_soul_hash,
            &input.settlement_root,
            &input.no_custody_hash,
            &max_spend_le8,
        ],
    );

    // Step 8: human summary hash
    let human_summary = format!(
        "agent can spend {} lamports; withdraw_allowed={}",
        input.max_spend_lamports, input.withdraw_allowed
    );
    let human_summary_hash =
        sha256_domain(b"dark_null_v1_human_summary", &[human_summary.as_bytes()]);

    // Step 9: public_summary
    let public_summary =
        "Full transaction grammar verified. Withdraw forbidden. No custody.".to_string();

    // Step 10: build RitualPlan
    let plan = RitualPlan {
        ritual_type: input.ritual_type.clone(),
        instructions,
        expected_shape_hash: shape_hash,
        expected_ritual_hash,
        human_summary_hash,
        withdraw_instruction_present: false,
        public_summary,
    };

    // Step 11: build RitualProofCapsule
    let rent_delta_hash = sha256_domain(b"dark_null_v1_rent_placeholder", &[]);
    let capsule = RitualProofCapsule {
        ritual_type: input.ritual_type.clone(),
        ritual_hash: expected_ritual_hash,
        shape_hash,
        permission_hash: input.permission_hash,
        receipt_hash: input.receipt_soul_hash,
        nullifier_hash: input.settlement_root,
        no_custody_hash: input.no_custody_hash,
        rent_delta_hash,
        verdict: RitualVerdict::Accepted,
    };

    // Step 12
    Ok((plan, capsule))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use ritual_proof_capsule::capsule_hash;

    fn test_input() -> RitualInput {
        RitualInput {
            ritual_type: "AgentSpendNoCustodyV1".to_string(),
            permission_hash: [0x01u8; 32],
            spend_hash: [0x02u8; 32],
            shadow_bundle_hash: [0x03u8; 32],
            receipt_soul_hash: [0x04u8; 32],
            settlement_root: [0x05u8; 32],
            no_custody_hash: [0x06u8; 32],
            max_spend_lamports: 1_000_000,
            withdraw_allowed: false,
        }
    }

    #[test]
    fn test_same_input_deterministic() {
        let (plan1, _) = compile_ritual(&test_input()).unwrap();
        let (plan2, _) = compile_ritual(&test_input()).unwrap();
        assert_eq!(plan1.expected_ritual_hash, plan2.expected_ritual_hash);
        assert_eq!(plan1.expected_shape_hash, plan2.expected_shape_hash);
    }

    #[test]
    fn test_cap_change_changes_ritual_hash() {
        let mut input1 = test_input();
        input1.max_spend_lamports = 1_000_000;
        let mut input2 = test_input();
        input2.max_spend_lamports = 500_000;
        let (plan1, _) = compile_ritual(&input1).unwrap();
        let (plan2, _) = compile_ritual(&input2).unwrap();
        assert_ne!(plan1.expected_ritual_hash, plan2.expected_ritual_hash);
    }

    #[test]
    fn test_withdraw_forbidden_returns_error() {
        let mut input = test_input();
        input.withdraw_allowed = true;
        let err = compile_ritual(&input).unwrap_err();
        assert_eq!(err, CompilerError::WithdrawInstructionForbidden);

        // Valid input should have withdraw_instruction_present = false
        let (plan, _) = compile_ritual(&test_input()).unwrap();
        assert!(!plan.withdraw_instruction_present);
    }

    #[test]
    fn test_compiled_plan_has_7_steps() {
        let (plan, _) = compile_ritual(&test_input()).unwrap();
        assert_eq!(plan.instructions.len(), 7);
    }

    #[test]
    fn test_compiled_capsule_verdict_accepted() {
        let (_, capsule) = compile_ritual(&test_input()).unwrap();
        assert_eq!(capsule.verdict, RitualVerdict::Accepted);
        assert_ne!(capsule_hash(&capsule), [0u8; 32]);
    }
}
