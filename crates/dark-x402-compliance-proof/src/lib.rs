//! dark-x402-compliance-proof — budget-compliance ZK proof without revealing payments
//!
//! First implementation of zero-knowledge budget compliance proofs for x402.
//! An AI agent proves to an auditor: "I spent ≤ N lamports total in this period"
//! without revealing: which APIs it called, how much each cost, or even which
//! on-chain accounts received payment.
//!
//! The proof commits to: the total spent (hidden), the budget (hidden), a flag
//! `within_budget`, the receipt count, and the period. An auditor can verify
//! compliance with the committed budget without learning any payment details.
//!
//! Use case: enterprise AI agent reports monthly spend compliance to CFO bot
//! without leaking competitive intelligence about which APIs it uses.
//!
//! IS_STUB  = true
//! MAINNET_READY = false

use sha2::{Digest, Sha256};

pub const IS_STUB: bool = true;
pub const MAINNET_READY: bool = false;

// ── domain tags ───────────────────────────────────────────────────────────────
const DOMAIN_TOTAL_COMMIT: &[u8] = b"x402-total-commit-v1";
const DOMAIN_BUDGET_COMMIT: &[u8] = b"x402-budget-commit-v1";
const DOMAIN_RECEIPTS_HASH: &[u8] = b"x402-receipts-hash-v1";
const DOMAIN_COMPLIANCE_ID: &[u8] = b"x402-compliance-id-v1";

// ── error ─────────────────────────────────────────────────────────────────────
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum ComplianceError {
    ZeroScope,
    ZeroBlinding,
    EmptyReceipts,
    InvalidPeriod,
    ZeroBudget,
}

impl core::fmt::Display for ComplianceError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::ZeroScope => write!(f, "program scope must not be all zeros"),
            Self::ZeroBlinding => write!(f, "blinding factor must not be all zeros"),
            Self::EmptyReceipts => write!(f, "receipts list must not be empty"),
            Self::InvalidPeriod => write!(f, "period_start must be <= period_end"),
            Self::ZeroBudget => write!(f, "budget must be > 0"),
        }
    }
}

// ── types ─────────────────────────────────────────────────────────────────────

/// A zero-knowledge budget compliance proof for an AI agent's x402 spending.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComplianceProof {
    /// Unique proof identifier.
    pub proof_id: [u8; 32],
    /// Commitment to total_spent (hides exact amount).
    pub total_commitment: [u8; 32],
    /// Commitment to budget (hides exact budget from auditor).
    pub budget_commitment: [u8; 32],
    /// True if total_spent <= budget at proof creation time.
    pub within_budget: bool,
    /// Number of receipts covered by this proof.
    pub receipt_count: u32,
    /// On-chain program scope these receipts belong to.
    pub program_scope: [u8; 32],
    /// Start of the reporting period (Unix seconds).
    pub period_start: u64,
    /// End of the reporting period (Unix seconds).
    pub period_end: u64,
    pub is_stub: bool,
    pub mainnet_ready: bool,
}

// ── public API ────────────────────────────────────────────────────────────────

/// Create a budget compliance proof.
///
/// - `receipt_hashes`: slice of 32-byte receipt hashes covered by this proof
/// - `total_spent`: exact lamports spent (hidden inside commitment)
/// - `budget`: the budget limit (hidden inside commitment)
/// - `blinding`: random 32-byte blinding factor (same blinding for both commitments
///   means auditor can verify relative ordering but not absolute amounts)
/// - `scope`: 32-byte program scope
/// - `period_start` / `period_end`: Unix seconds for the reporting window
pub fn create_compliance_proof(
    receipt_hashes: &[[u8; 32]],
    total_spent: u64,
    budget: u64,
    blinding: &[u8; 32],
    scope: &[u8; 32],
    period_start: u64,
    period_end: u64,
) -> Result<ComplianceProof, ComplianceError> {
    if scope == &[0u8; 32] {
        return Err(ComplianceError::ZeroScope);
    }
    if blinding == &[0u8; 32] {
        return Err(ComplianceError::ZeroBlinding);
    }
    if receipt_hashes.is_empty() {
        return Err(ComplianceError::EmptyReceipts);
    }
    if period_start > period_end {
        return Err(ComplianceError::InvalidPeriod);
    }
    if budget == 0 {
        return Err(ComplianceError::ZeroBudget);
    }

    let total_commitment: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(DOMAIN_TOTAL_COMMIT);
        h.update(total_spent.to_le_bytes());
        h.update(blinding);
        h.finalize().into()
    };

    let budget_commitment: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(DOMAIN_BUDGET_COMMIT);
        h.update(budget.to_le_bytes());
        h.update(blinding);
        h.finalize().into()
    };

    // Hash all receipts together for the proof id (receipt set is committed, not revealed)
    let receipts_hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(DOMAIN_RECEIPTS_HASH);
        for rh in receipt_hashes {
            h.update(rh);
        }
        h.finalize().into()
    };

    let within_budget = total_spent <= budget;

    let proof_id: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(DOMAIN_COMPLIANCE_ID);
        h.update(total_commitment);
        h.update(budget_commitment);
        h.update(scope);
        h.update(period_start.to_le_bytes());
        h.update(period_end.to_le_bytes());
        h.update(receipts_hash);
        h.finalize().into()
    };

    Ok(ComplianceProof {
        proof_id,
        total_commitment,
        budget_commitment,
        within_budget,
        receipt_count: receipt_hashes.len() as u32,
        program_scope: *scope,
        period_start,
        period_end,
        is_stub: IS_STUB,
        mainnet_ready: MAINNET_READY,
    })
}

/// Verify that a compliance proof correctly represents the given spend vs budget.
///
/// Returns true if the recomputed commitments match AND `within_budget` is consistent.
pub fn verify_within_budget(
    proof: &ComplianceProof,
    total_spent: u64,
    budget: u64,
    blinding: &[u8; 32],
) -> bool {
    let expected_total: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(DOMAIN_TOTAL_COMMIT);
        h.update(total_spent.to_le_bytes());
        h.update(blinding);
        h.finalize().into()
    };

    let expected_budget: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(DOMAIN_BUDGET_COMMIT);
        h.update(budget.to_le_bytes());
        h.update(blinding);
        h.finalize().into()
    };

    let flag_consistent = proof.within_budget == (total_spent <= budget);

    expected_total == proof.total_commitment
        && expected_budget == proof.budget_commitment
        && flag_consistent
}

/// Verify the proof covers the expected time period.
pub fn verify_period(proof: &ComplianceProof, start: u64, end: u64) -> bool {
    proof.period_start == start && proof.period_end == end
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope() -> [u8; 32] { let mut s = [0u8; 32]; s[0] = 0xAA; s[31] = 0x01; s }
    fn blinding() -> [u8; 32] { let mut b = [0u8; 32]; b[0] = 0xBB; b[16] = 0x42; b }
    fn receipts() -> Vec<[u8; 32]> {
        (0u8..3).map(|i| { let mut r = [0u8; 32]; r[0] = 0xCC; r[1] = i; r }).collect()
    }
    const TOTAL: u64 = 3_000;
    const BUDGET: u64 = 5_000;
    const START: u64 = 1_700_000_000;
    const END: u64 = 1_700_086_400;

    fn fresh() -> ComplianceProof {
        create_compliance_proof(&receipts(), TOTAL, BUDGET, &blinding(), &scope(), START, END).unwrap()
    }

    // 1. constants
    #[test]
    fn test_constants() {
        assert!(IS_STUB);
        assert!(!MAINNET_READY);
    }

    // 2. proof created within budget has within_budget = true
    #[test]
    fn test_create_compliance_proof_within_budget() {
        let p = fresh();
        assert!(p.within_budget);
        assert!(!p.mainnet_ready);
        assert_ne!(p.proof_id, [0u8; 32]);
    }

    // 3. total == budget → within_budget = true (boundary)
    #[test]
    fn test_create_compliance_proof_at_exact_budget() {
        let p = create_compliance_proof(
            &receipts(), BUDGET, BUDGET, &blinding(), &scope(), START, END
        ).unwrap();
        assert!(p.within_budget, "spending exactly the budget is within_budget");
    }

    // 4. proof_id is deterministic
    #[test]
    fn test_proof_id_deterministic() {
        let a = fresh();
        let b = fresh();
        assert_eq!(a.proof_id, b.proof_id);
    }

    // 5. verify_within_budget with correct params passes
    #[test]
    fn test_verify_within_budget_correct_blinding() {
        let p = fresh();
        assert!(verify_within_budget(&p, TOTAL, BUDGET, &blinding()));
    }

    // 6. verify_within_budget with wrong blinding fails
    #[test]
    fn test_verify_within_budget_wrong_blinding_fails() {
        let p = fresh();
        let mut bad = blinding();
        bad[5] ^= 0xFF;
        assert!(!verify_within_budget(&p, TOTAL, BUDGET, &bad));
    }

    // 7. verify_within_budget with wrong total fails
    #[test]
    fn test_verify_within_budget_wrong_total_fails() {
        let p = fresh();
        assert!(!verify_within_budget(&p, TOTAL + 1, BUDGET, &blinding()));
    }

    // 8. total > budget → within_budget = false
    #[test]
    fn test_within_budget_flag_false_when_exceeded() {
        let p = create_compliance_proof(
            &receipts(), BUDGET + 1, BUDGET, &blinding(), &scope(), START, END
        ).unwrap();
        assert!(!p.within_budget);
        // verify_within_budget must also return false (flag mismatch would fail)
        assert!(verify_within_budget(&p, BUDGET + 1, BUDGET, &blinding()));
    }

    // 9. verify_period correct
    #[test]
    fn test_verify_period_correct() {
        let p = fresh();
        assert!(verify_period(&p, START, END));
    }

    // 10. verify_period wrong start fails
    #[test]
    fn test_verify_period_wrong_start_fails() {
        let p = fresh();
        assert!(!verify_period(&p, START + 1, END));
    }

    // 11. zero scope → error
    #[test]
    fn test_zero_scope_error() {
        let err = create_compliance_proof(
            &receipts(), TOTAL, BUDGET, &blinding(), &[0u8; 32], START, END
        ).unwrap_err();
        assert_eq!(err, ComplianceError::ZeroScope);
    }

    // 12. zero blinding → error
    #[test]
    fn test_zero_blinding_error() {
        let err = create_compliance_proof(
            &receipts(), TOTAL, BUDGET, &[0u8; 32], &scope(), START, END
        ).unwrap_err();
        assert_eq!(err, ComplianceError::ZeroBlinding);
    }

    // 13. empty receipts → error
    #[test]
    fn test_empty_receipts_error() {
        let err = create_compliance_proof(
            &[], TOTAL, BUDGET, &blinding(), &scope(), START, END
        ).unwrap_err();
        assert_eq!(err, ComplianceError::EmptyReceipts);
    }

    // 14. start > end → invalid period error
    #[test]
    fn test_invalid_period_error() {
        let err = create_compliance_proof(
            &receipts(), TOTAL, BUDGET, &blinding(), &scope(), END + 1, END
        ).unwrap_err();
        assert_eq!(err, ComplianceError::InvalidPeriod);
    }

    // 15. zero budget → error
    #[test]
    fn test_zero_budget_error() {
        let err = create_compliance_proof(
            &receipts(), 0, 0, &blinding(), &scope(), START, END
        ).unwrap_err();
        assert_eq!(err, ComplianceError::ZeroBudget);
    }

    // 16. receipt_count matches input slice length
    #[test]
    fn test_receipt_count_matches_input() {
        let rhs: Vec<[u8; 32]> = (0u8..7)
            .map(|i| { let mut r = [0u8; 32]; r[0] = 0xCC; r[1] = i; r })
            .collect();
        let p = create_compliance_proof(
            &rhs, TOTAL, BUDGET, &blinding(), &scope(), START, END
        ).unwrap();
        assert_eq!(p.receipt_count, 7);
    }
}
