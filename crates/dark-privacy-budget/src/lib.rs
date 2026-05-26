use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrivacyBudget {
    pub budget_id: [u8; 32],
    pub total_epsilon: u32,
    pub spent_epsilon: u32,
    pub query_count: u32,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryReceipt {
    pub budget_id: [u8; 32],
    pub epsilon_spent: u32,
    pub new_total_spent: u32,
    pub query_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum BudgetError {
    BudgetExhausted { remaining: u32, requested: u32 },
    ZeroEpsilon,
    BudgetIdZero,
}

pub fn new_budget(budget_id: [u8; 32], total_epsilon: u32) -> Result<PrivacyBudget, BudgetError> {
    if budget_id == [0u8; 32] {
        return Err(BudgetError::BudgetIdZero);
    }
    Ok(PrivacyBudget {
        budget_id,
        total_epsilon,
        spent_epsilon: 0,
        query_count: 0,
        mainnet_ready: false,
    })
}

pub fn consume_budget(
    budget: &mut PrivacyBudget,
    epsilon: u32,
) -> Result<QueryReceipt, BudgetError> {
    if epsilon == 0 {
        return Err(BudgetError::ZeroEpsilon);
    }
    let new_spent = budget
        .spent_epsilon
        .checked_add(epsilon)
        .unwrap_or(u32::MAX);
    if new_spent > budget.total_epsilon {
        return Err(BudgetError::BudgetExhausted {
            remaining: budget.total_epsilon - budget.spent_epsilon,
            requested: epsilon,
        });
    }

    // query_hash = SHA256("query-v1" || budget_id || epsilon_le || query_count_le)
    let mut hasher = Sha256::new();
    hasher.update(b"query-v1");
    hasher.update(budget.budget_id);
    hasher.update(epsilon.to_le_bytes());
    hasher.update(budget.query_count.to_le_bytes());
    let query_hash: [u8; 32] = hasher.finalize().into();

    budget.spent_epsilon = new_spent;
    budget.query_count += 1;

    Ok(QueryReceipt {
        budget_id: budget.budget_id,
        epsilon_spent: epsilon,
        new_total_spent: new_spent,
        query_hash,
        mainnet_ready: false,
    })
}

pub fn remaining_budget(budget: &PrivacyBudget) -> u32 {
    budget.total_epsilon - budget.spent_epsilon
}

pub fn budget_public_record(budget: &PrivacyBudget) -> String {
    let id_hex: String = budget
        .budget_id
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    serde_json::json!({
        "budget_id": id_hex,
        "total_epsilon": budget.total_epsilon,
        "spent_epsilon": budget.spent_epsilon,
        "query_count": budget.query_count,
        "mainnet_ready": budget.mainnet_ready,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn budget_id() -> [u8; 32] {
        let mut id = [0u8; 32];
        id[0] = 0x77;
        id
    }

    #[test]
    fn test_consume_succeeds() {
        let mut b = new_budget(budget_id(), 1000).unwrap();
        let receipt = consume_budget(&mut b, 100).unwrap();
        assert_eq!(receipt.epsilon_spent, 100);
        assert_eq!(receipt.new_total_spent, 100);
        assert!(!receipt.mainnet_ready);
    }

    #[test]
    fn test_budget_exhausted() {
        let mut b = new_budget(budget_id(), 100).unwrap();
        let err = consume_budget(&mut b, 101).unwrap_err();
        assert_eq!(
            err,
            BudgetError::BudgetExhausted {
                remaining: 100,
                requested: 101
            }
        );
    }

    #[test]
    fn test_zero_epsilon_rejected() {
        let mut b = new_budget(budget_id(), 1000).unwrap();
        let err = consume_budget(&mut b, 0).unwrap_err();
        assert_eq!(err, BudgetError::ZeroEpsilon);
    }

    #[test]
    fn test_multiple_queries_tracked() {
        let mut b = new_budget(budget_id(), 1000).unwrap();
        consume_budget(&mut b, 100).unwrap();
        consume_budget(&mut b, 200).unwrap();
        consume_budget(&mut b, 300).unwrap();
        assert_eq!(b.spent_epsilon, 600);
        assert_eq!(b.query_count, 3);
        // next one that would exceed
        let err = consume_budget(&mut b, 500).unwrap_err();
        assert_eq!(
            err,
            BudgetError::BudgetExhausted {
                remaining: 400,
                requested: 500
            }
        );
    }

    #[test]
    fn test_remaining_budget_correct() {
        let mut b = new_budget(budget_id(), 500).unwrap();
        assert_eq!(remaining_budget(&b), 500);
        consume_budget(&mut b, 150).unwrap();
        assert_eq!(remaining_budget(&b), 350);
        consume_budget(&mut b, 350).unwrap();
        assert_eq!(remaining_budget(&b), 0);
    }

    #[test]
    fn test_public_record_has_all_fields() {
        let mut b = new_budget(budget_id(), 1000).unwrap();
        consume_budget(&mut b, 42).unwrap();
        let json_str = budget_public_record(&b);
        let v: serde_json::Value = serde_json::from_str(&json_str).unwrap();
        assert!(v["budget_id"].is_string());
        assert_eq!(v["total_epsilon"], 1000u32);
        assert_eq!(v["spent_epsilon"], 42u32);
        assert_eq!(v["query_count"], 1u32);
        assert_eq!(v["mainnet_ready"], false);
        assert!(!v["mainnet_ready"].as_bool().unwrap());
    }
}
