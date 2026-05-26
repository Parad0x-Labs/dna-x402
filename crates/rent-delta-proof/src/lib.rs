use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Private helper
// ---------------------------------------------------------------------------

fn sha256_domain(domain: &[u8], inputs: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(domain);
    for input in inputs {
        h.update(input);
    }
    h.finalize().into()
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RentAction {
    CreateAccount {
        account_hash: [u8; 32],
        lamports: u64,
    },
    CloseAccount {
        account_hash: [u8; 32],
        lamports: u64,
    },
    Realloc {
        account_hash: [u8; 32],
        delta_bytes: i64,
        lamports_delta: i64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RentDeltaProof {
    pub actions: Vec<RentAction>,
    pub rent_locked: u64,
    pub rent_reclaimed: u64,
    pub net_rent_cost: i64,
    pub chaff_reward: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RentDeltaSummary {
    pub net_rent_cost: i64,
    pub chaff_reward: u64,
    pub summary_hash: [u8; 32],
    pub net_label: String,
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/// Compute RentDeltaProof from a list of actions.
pub fn compute_rent_delta(actions: &[RentAction]) -> RentDeltaProof {
    let mut rent_locked: u64 = 0;
    let mut rent_reclaimed: u64 = 0;

    for action in actions {
        match action {
            RentAction::CreateAccount { lamports, .. } => {
                rent_locked = rent_locked.saturating_add(*lamports);
            }
            RentAction::CloseAccount { lamports, .. } => {
                rent_reclaimed = rent_reclaimed.saturating_add(*lamports);
            }
            RentAction::Realloc { .. } => {
                // realloc does not directly affect locked/reclaimed totals
            }
        }
    }

    let net_rent_cost = rent_locked as i64 - rent_reclaimed as i64;
    let chaff_reward = rent_reclaimed.min(rent_locked);

    RentDeltaProof {
        actions: actions.to_vec(),
        rent_locked,
        rent_reclaimed,
        net_rent_cost,
        chaff_reward,
    }
}

/// Produce a summary.
/// summary_hash = SHA256("dark_null_v1_rent_delta" || net_rent_cost_le8 || chaff_reward_le8)
pub fn summarize_rent_delta(proof: &RentDeltaProof, _redact_owners: bool) -> RentDeltaSummary {
    let net_bytes = proof.net_rent_cost.to_le_bytes();
    let reward_bytes = proof.chaff_reward.to_le_bytes();
    let summary_hash = sha256_domain(b"dark_null_v1_rent_delta", &[&net_bytes, &reward_bytes]);

    let net_label = if proof.net_rent_cost <= 0 && proof.chaff_reward > 0 {
        "profitable".to_string()
    } else if proof.net_rent_cost <= 0 {
        "self-funding".to_string()
    } else {
        "net cost".to_string()
    };

    RentDeltaSummary {
        net_rent_cost: proof.net_rent_cost,
        chaff_reward: proof.chaff_reward,
        summary_hash,
        net_label,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_hash(seed: u8) -> [u8; 32] {
        [seed; 32]
    }

    #[test]
    fn test_create_account_increases_locked() {
        let actions = vec![
            RentAction::CreateAccount {
                account_hash: make_hash(0x01),
                lamports: 5000,
            },
            RentAction::CreateAccount {
                account_hash: make_hash(0x02),
                lamports: 3000,
            },
        ];
        let proof = compute_rent_delta(&actions);
        assert_eq!(proof.rent_locked, 8000);
        assert_eq!(proof.rent_reclaimed, 0);
        assert_eq!(proof.net_rent_cost, 8000);
    }

    #[test]
    fn test_close_account_increases_reclaimed() {
        let actions = vec![RentAction::CloseAccount {
            account_hash: make_hash(0x01),
            lamports: 10000,
        }];
        let proof = compute_rent_delta(&actions);
        assert_eq!(proof.rent_locked, 0);
        assert_eq!(proof.rent_reclaimed, 10000);
        assert_eq!(proof.net_rent_cost, 0i64 - 10000i64);
    }

    #[test]
    fn test_net_delta_computed() {
        let actions = vec![
            RentAction::CreateAccount {
                account_hash: make_hash(0x01),
                lamports: 5000,
            },
            RentAction::CloseAccount {
                account_hash: make_hash(0x02),
                lamports: 8000,
            },
        ];
        let proof = compute_rent_delta(&actions);
        assert_eq!(proof.rent_locked, 5000);
        assert_eq!(proof.rent_reclaimed, 8000);
        assert_eq!(proof.net_rent_cost, -3000);
    }

    #[test]
    fn test_chaff_reward_cannot_exceed_reclaimed_rent() {
        let actions = vec![
            RentAction::CreateAccount {
                account_hash: make_hash(0x01),
                lamports: 1000,
            },
            RentAction::CloseAccount {
                account_hash: make_hash(0x02),
                lamports: 9000,
            },
        ];
        let proof = compute_rent_delta(&actions);
        // chaff_reward = rent_reclaimed.min(rent_locked) = 9000.min(1000) = 1000
        assert_eq!(proof.chaff_reward, 1000);
    }

    #[test]
    fn test_redacted_summary_correct() {
        let actions = vec![
            RentAction::CreateAccount {
                account_hash: make_hash(0x01),
                lamports: 2000,
            },
            RentAction::CloseAccount {
                account_hash: make_hash(0x02),
                lamports: 5000,
            },
        ];
        let proof = compute_rent_delta(&actions);
        let summary = summarize_rent_delta(&proof, true);

        assert_ne!(summary.summary_hash, [0u8; 32]);
        assert!(
            summary.net_label == "self-funding"
                || summary.net_label == "profitable"
                || summary.net_label == "net cost",
            "unexpected net_label: {}",
            summary.net_label
        );
        assert_eq!(summary.net_rent_cost, proof.net_rent_cost);
    }
}
