use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

fn sha256_domain(domain: &[u8], inputs: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(domain);
    for input in inputs {
        h.update(input);
    }
    h.finalize().into()
}

// ── Enums ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RitualType {
    AgentSpendNoCustodyV1,
    ReceiptSoulRedeemV1,
    AlphaCapsuleCommitV1,
    SessionSettlementV1,
    ChaffMaintenanceV1,
}

impl RitualType {
    pub fn label(&self) -> &'static str {
        match self {
            RitualType::AgentSpendNoCustodyV1 => "AgentSpendNoCustodyV1",
            RitualType::ReceiptSoulRedeemV1 => "ReceiptSoulRedeemV1",
            RitualType::AlphaCapsuleCommitV1 => "AlphaCapsuleCommitV1",
            RitualType::SessionSettlementV1 => "SessionSettlementV1",
            RitualType::ChaffMaintenanceV1 => "ChaffMaintenanceV1",
        }
    }

    pub fn type_byte(&self) -> u8 {
        match self {
            RitualType::AgentSpendNoCustodyV1 => 1,
            RitualType::ReceiptSoulRedeemV1 => 2,
            RitualType::AlphaCapsuleCommitV1 => 3,
            RitualType::SessionSettlementV1 => 4,
            RitualType::ChaffMaintenanceV1 => 5,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ProgramRole {
    ComputeBudget,
    DarkRitualGate,
    DarkNullifierBanks,
    DarkChaff,
    SystemProgram,
    AnyAllowed,
    Forbidden,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AccountRole {
    Payer,
    Agent,
    PermissionPda,
    ShadowBundle,
    NullifierBank,
    ReceiptSoul,
    ChaffPda,
    SessionRoot,
    KillSwitchRoot,
    ReadonlyDecoy,
}

// ── Structs ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstructionShape {
    pub step_name: String,
    pub program_role: ProgramRole,
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RitualGrammar {
    pub ritual_type: RitualType,
    pub steps: Vec<InstructionShape>,
    pub permission_step_name: String,
    pub spend_step_name: String,
}

/// One instruction as observed in a transaction.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObservedStep {
    pub step_name: String,
    pub program_id_hash: [u8; 32],
    pub instruction_data_hash: [u8; 32],
}

/// The full transaction observation to validate.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RitualObservation {
    pub ritual_type: RitualType,
    pub observed_steps: Vec<ObservedStep>,
    pub forbidden_program_hashes: Vec<[u8; 32]>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RitualViolation {
    MissingRequiredStep { step_name: String },
    ForbiddenProgram { program_id_hash: [u8; 32] },
    InsufficientSteps { min: usize, found: usize },
    PermissionMustPrecedeSpend,
    ShapeHashMismatch { expected: [u8; 32], found: [u8; 32] },
    WithdrawInstructionForbidden,
}

// ── Functions ─────────────────────────────────────────────────────────────────

/// SHA256("dark_null_v1_ritual_shape" || step0_name_bytes || step0_data_hash || step1_name_bytes || step1_data_hash || ...)
pub fn compute_shape_hash(steps: &[ObservedStep]) -> [u8; 32] {
    let mut inputs: Vec<&[u8]> = Vec::with_capacity(steps.len() * 2);
    for step in steps {
        inputs.push(step.step_name.as_bytes());
        inputs.push(&step.instruction_data_hash);
    }
    sha256_domain(b"dark_null_v1_ritual_shape", &inputs)
}

/// Validate a ritual observation against a grammar.
pub fn validate_ritual(
    grammar: &RitualGrammar,
    observation: &RitualObservation,
) -> Result<[u8; 32], RitualViolation> {
    // Step 1: Check for forbidden programs.
    if let Some(forbidden) = observation.forbidden_program_hashes.first() {
        return Err(RitualViolation::ForbiddenProgram {
            program_id_hash: *forbidden,
        });
    }

    // Build a set of observed step names for fast lookup.
    let observed_names: HashSet<&str> = observation
        .observed_steps
        .iter()
        .map(|s| s.step_name.as_str())
        .collect();

    // Step 2 & 3: Check required steps and count them.
    let required_steps: Vec<&InstructionShape> =
        grammar.steps.iter().filter(|s| s.required).collect();
    let required_count = required_steps.len();

    let mut found_required = 0usize;
    for shape in &required_steps {
        if observed_names.contains(shape.step_name.as_str()) {
            found_required += 1;
        } else {
            return Err(RitualViolation::MissingRequiredStep {
                step_name: shape.step_name.clone(),
            });
        }
    }

    if found_required < required_count {
        return Err(RitualViolation::InsufficientSteps {
            min: required_count,
            found: found_required,
        });
    }

    // Step 4: Permission must precede spend.
    let permission_idx = observation
        .observed_steps
        .iter()
        .position(|s| s.step_name == grammar.permission_step_name);
    let spend_idx = observation
        .observed_steps
        .iter()
        .position(|s| s.step_name == grammar.spend_step_name);

    if let (Some(p_idx), Some(s_idx)) = (permission_idx, spend_idx) {
        if p_idx >= s_idx {
            return Err(RitualViolation::PermissionMustPrecedeSpend);
        }
    }

    // Step 5: Compute and return shape hash.
    Ok(compute_shape_hash(&observation.observed_steps))
}

/// Return the default grammar for a ritual type.
pub fn default_grammar(ritual_type: &RitualType) -> RitualGrammar {
    match ritual_type {
        RitualType::AgentSpendNoCustodyV1 => RitualGrammar {
            ritual_type: ritual_type.clone(),
            steps: vec![
                InstructionShape {
                    step_name: "ComputeBudget".to_string(),
                    program_role: ProgramRole::ComputeBudget,
                    required: false,
                },
                InstructionShape {
                    step_name: "IntentCapsule".to_string(),
                    program_role: ProgramRole::DarkRitualGate,
                    required: true,
                },
                InstructionShape {
                    step_name: "PermissionProof".to_string(),
                    program_role: ProgramRole::DarkRitualGate,
                    required: true,
                },
                InstructionShape {
                    step_name: "SpendShadow".to_string(),
                    program_role: ProgramRole::DarkRitualGate,
                    required: true,
                },
                InstructionShape {
                    step_name: "ReceiptSoul".to_string(),
                    program_role: ProgramRole::DarkRitualGate,
                    required: true,
                },
                InstructionShape {
                    step_name: "NullifierInsert".to_string(),
                    program_role: ProgramRole::DarkNullifierBanks,
                    required: true,
                },
                InstructionShape {
                    step_name: "ChaffMaintenance".to_string(),
                    program_role: ProgramRole::DarkChaff,
                    required: false,
                },
            ],
            permission_step_name: "PermissionProof".to_string(),
            spend_step_name: "SpendShadow".to_string(),
        },
        other => {
            let label = other.label();
            let main_name = format!("{}Main", label);
            let settle_name = format!("{}Settle", label);
            RitualGrammar {
                ritual_type: ritual_type.clone(),
                steps: vec![
                    InstructionShape {
                        step_name: main_name.clone(),
                        program_role: ProgramRole::DarkRitualGate,
                        required: true,
                    },
                    InstructionShape {
                        step_name: settle_name.clone(),
                        program_role: ProgramRole::DarkNullifierBanks,
                        required: true,
                    },
                ],
                permission_step_name: main_name,
                spend_step_name: settle_name,
            }
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_step(name: &str) -> ObservedStep {
        ObservedStep {
            step_name: name.to_string(),
            program_id_hash: [0u8; 32],
            instruction_data_hash: [0u8; 32],
        }
    }

    fn valid_agent_spend_steps() -> Vec<ObservedStep> {
        vec![
            make_step("IntentCapsule"),
            make_step("PermissionProof"),
            make_step("SpendShadow"),
            make_step("ReceiptSoul"),
            make_step("NullifierInsert"),
        ]
    }

    #[test]
    fn test_valid_agent_spend_ritual_passes() {
        let grammar = default_grammar(&RitualType::AgentSpendNoCustodyV1);
        let observation = RitualObservation {
            ritual_type: RitualType::AgentSpendNoCustodyV1,
            observed_steps: valid_agent_spend_steps(),
            forbidden_program_hashes: vec![],
        };
        let result = validate_ritual(&grammar, &observation);
        assert!(result.is_ok(), "expected Ok but got {:?}", result);
    }

    #[test]
    fn test_missing_permission_step_fails() {
        let grammar = default_grammar(&RitualType::AgentSpendNoCustodyV1);
        let steps: Vec<ObservedStep> = valid_agent_spend_steps()
            .into_iter()
            .filter(|s| s.step_name != "PermissionProof")
            .collect();
        let observation = RitualObservation {
            ritual_type: RitualType::AgentSpendNoCustodyV1,
            observed_steps: steps,
            forbidden_program_hashes: vec![],
        };
        let result = validate_ritual(&grammar, &observation);
        assert_eq!(
            result,
            Err(RitualViolation::MissingRequiredStep {
                step_name: "PermissionProof".to_string()
            })
        );
    }

    #[test]
    fn test_wrong_order_fails() {
        let grammar = default_grammar(&RitualType::AgentSpendNoCustodyV1);
        // SpendShadow before PermissionProof
        let steps = vec![
            make_step("IntentCapsule"),
            make_step("SpendShadow"),
            make_step("PermissionProof"),
            make_step("ReceiptSoul"),
            make_step("NullifierInsert"),
        ];
        let observation = RitualObservation {
            ritual_type: RitualType::AgentSpendNoCustodyV1,
            observed_steps: steps,
            forbidden_program_hashes: vec![],
        };
        let result = validate_ritual(&grammar, &observation);
        assert_eq!(result, Err(RitualViolation::PermissionMustPrecedeSpend));
    }

    #[test]
    fn test_forbidden_program_fails() {
        let grammar = default_grammar(&RitualType::AgentSpendNoCustodyV1);
        let observation = RitualObservation {
            ritual_type: RitualType::AgentSpendNoCustodyV1,
            observed_steps: valid_agent_spend_steps(),
            forbidden_program_hashes: vec![[0xFFu8; 32]],
        };
        let result = validate_ritual(&grammar, &observation);
        assert_eq!(
            result,
            Err(RitualViolation::ForbiddenProgram {
                program_id_hash: [0xFFu8; 32]
            })
        );
    }

    #[test]
    fn test_optional_chaff_not_required() {
        let grammar = default_grammar(&RitualType::AgentSpendNoCustodyV1);
        // No ChaffMaintenance — that's optional, should be fine
        let observation = RitualObservation {
            ritual_type: RitualType::AgentSpendNoCustodyV1,
            observed_steps: valid_agent_spend_steps(),
            forbidden_program_hashes: vec![],
        };
        let result = validate_ritual(&grammar, &observation);
        assert!(
            result.is_ok(),
            "optional step absence should not fail: {:?}",
            result
        );
    }

    #[test]
    fn test_missing_required_step_insufficient() {
        let grammar = default_grammar(&RitualType::AgentSpendNoCustodyV1);
        // Only 3 of the 5 required steps
        let steps = vec![
            make_step("IntentCapsule"),
            make_step("PermissionProof"),
            make_step("SpendShadow"),
        ];
        let observation = RitualObservation {
            ritual_type: RitualType::AgentSpendNoCustodyV1,
            observed_steps: steps,
            forbidden_program_hashes: vec![],
        };
        let result = validate_ritual(&grammar, &observation);
        assert!(result.is_err(), "expected Err for missing required steps");
    }

    #[test]
    fn test_shape_hash_deterministic() {
        let steps_a = valid_agent_spend_steps();
        let steps_b = valid_agent_spend_steps();
        let hash_a = compute_shape_hash(&steps_a);
        let hash_b = compute_shape_hash(&steps_b);
        assert_eq!(
            hash_a, hash_b,
            "identical observations must produce equal shape hashes"
        );

        // Modify one step's data_hash
        let mut steps_c = valid_agent_spend_steps();
        steps_c[0].instruction_data_hash = [0xABu8; 32];
        let hash_c = compute_shape_hash(&steps_c);
        assert_ne!(
            hash_a, hash_c,
            "modified observation must produce different shape hash"
        );
    }
}
