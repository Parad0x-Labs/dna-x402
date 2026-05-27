// dark-coalition-proof — agent coalition collective spending proof
// Prove coalition threshold met without revealing members or individual amounts.
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false

use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct AgentContribution {
    /// SHA256("agent-contrib-v1" || agent_id_hash || amount_le8 || nonce)
    pub contribution_commit: [u8; 32],
    /// SHA256 of agent identity — never raw
    pub agent_id_hash: [u8; 32],
    pub mainnet_ready: bool, // always false
}

#[derive(Debug, Clone, PartialEq)]
pub struct CoalitionConfig {
    /// Minimum total spend for the condition to be satisfied (lamports)
    pub spend_threshold: u64,
    /// Maximum number of agents in coalition
    pub max_members: u8,
    /// Domain hash (e.g., SHA256 of the spending purpose)
    pub domain_hash: [u8; 32],
    pub mainnet_ready: bool, // always false
}

#[derive(Debug, Clone, PartialEq)]
pub struct CoalitionProof {
    /// SHA256("coalition-root-v1" || sorted(contribution_commits))
    /// Sorting makes this order-independent.
    pub coalition_root: [u8; 32],
    /// SHA256("spend-commit-v1" || total_amount_le8 || nonce)
    /// Hides the actual total.
    pub total_spend_commit: [u8; 32],
    /// True if total_amount >= config.spend_threshold
    pub threshold_met: bool,
    /// Number of contributors (public — how many, not who)
    pub contributor_count: u8,
    pub mainnet_ready: bool, // always false
}

#[derive(Debug, PartialEq)]
pub enum CoalitionError {
    TooManyMembers { have: usize, max: u8 },
    EmptyCoalition,
    DuplicateAgent,
    ThresholdNotMet { total: u64, threshold: u64 },
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn sha256(data: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for chunk in data {
        h.update(chunk);
    }
    h.finalize().into()
}

fn hash_agent_id(agent_id: &[u8]) -> [u8; 32] {
    sha256(&[b"agent-id-v1", agent_id])
}

fn make_contribution_commit(agent_id_hash: &[u8; 32], amount: u64, nonce: &[u8; 32]) -> [u8; 32] {
    sha256(&[
        b"agent-contrib-v1",
        agent_id_hash.as_ref(),
        &amount.to_le_bytes(),
        nonce.as_ref(),
    ])
}

fn make_coalition_root(contribution_commits: &[[u8; 32]], domain_hash: &[u8; 32]) -> [u8; 32] {
    // Sort lexicographically — makes root order-independent.
    let mut sorted = contribution_commits.to_vec();
    sorted.sort_unstable();

    let mut h = Sha256::new();
    h.update(b"coalition-root-v1");
    h.update(domain_hash);
    for c in &sorted {
        h.update(c);
    }
    h.finalize().into()
}

fn make_total_spend_commit(total_amount: u64, nonce: &[u8; 32]) -> [u8; 32] {
    sha256(&[
        b"spend-commit-v1",
        &total_amount.to_le_bytes(),
        nonce.as_ref(),
    ])
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Create a contribution commitment for one agent.
/// `agent_id` is hashed internally — never stored raw.
pub fn make_contribution(agent_id: &[u8], amount: u64, nonce: &[u8; 32]) -> AgentContribution {
    let agent_id_hash = hash_agent_id(agent_id);
    let contribution_commit = make_contribution_commit(&agent_id_hash, amount, nonce);
    AgentContribution {
        contribution_commit,
        agent_id_hash,
        mainnet_ready: false,
    }
}

/// Verify a contribution commitment matches the given (amount, nonce, agent_id).
pub fn verify_contribution(
    contribution: &AgentContribution,
    agent_id: &[u8],
    amount: u64,
    nonce: &[u8; 32],
) -> bool {
    let expected_id_hash = hash_agent_id(agent_id);
    if expected_id_hash != contribution.agent_id_hash {
        return false;
    }
    let expected_commit = make_contribution_commit(&expected_id_hash, amount, nonce);
    expected_commit == contribution.contribution_commit
}

/// Build a coalition proof from N individual contributions.
/// `amounts[i]` corresponds to `contributions[i]`.
/// `total = sum(amounts)`.
/// Proof does NOT embed amounts — only the total commitment.
pub fn prove_coalition(
    config: &CoalitionConfig,
    contributions: &[AgentContribution],
    amounts: &[u64],
    total_nonce: &[u8; 32],
) -> Result<CoalitionProof, CoalitionError> {
    // Empty coalition guard.
    if contributions.is_empty() {
        return Err(CoalitionError::EmptyCoalition);
    }

    // Too many members guard.
    if contributions.len() > config.max_members as usize {
        return Err(CoalitionError::TooManyMembers {
            have: contributions.len(),
            max: config.max_members,
        });
    }

    // Duplicate agent detection — compare agent_id_hash values.
    let mut seen: Vec<[u8; 32]> = Vec::with_capacity(contributions.len());
    for c in contributions {
        if seen.contains(&c.agent_id_hash) {
            return Err(CoalitionError::DuplicateAgent);
        }
        seen.push(c.agent_id_hash);
    }

    // Sum amounts with saturation — check threshold.
    let total: u64 = amounts.iter().copied().fold(0u64, u64::saturating_add);
    if total < config.spend_threshold {
        return Err(CoalitionError::ThresholdNotMet {
            total,
            threshold: config.spend_threshold,
        });
    }

    // Build the coalition root from contribution_commits + domain_hash.
    let commits: Vec<[u8; 32]> = contributions
        .iter()
        .map(|c| c.contribution_commit)
        .collect();
    let coalition_root = make_coalition_root(&commits, &config.domain_hash);

    // Commit to total spend without embedding the raw value.
    let total_spend_commit = make_total_spend_commit(total, total_nonce);

    Ok(CoalitionProof {
        coalition_root,
        total_spend_commit,
        threshold_met: true,
        contributor_count: contributions.len() as u8,
        mainnet_ready: false,
    })
}

/// Verify a coalition proof (public verification — no amounts needed).
/// Checks that `coalition_root` is consistent with the contributions slice.
/// Does NOT check amounts (those are committed, not revealed).
pub fn verify_coalition_proof(
    proof: &CoalitionProof,
    contributions: &[AgentContribution],
    config: &CoalitionConfig,
) -> bool {
    if contributions.len() != proof.contributor_count as usize {
        return false;
    }
    let commits: Vec<[u8; 32]> = contributions
        .iter()
        .map(|c| c.contribution_commit)
        .collect();
    let expected_root = make_coalition_root(&commits, &config.domain_hash);
    expected_root == proof.coalition_root
}

/// Check if a proof claims the threshold was met.
pub fn threshold_satisfied(proof: &CoalitionProof) -> bool {
    proof.threshold_met
}

/// Public evidence JSON: only root, contributor_count, threshold_met, domain_hash.
/// Never includes agent IDs or amounts.
pub fn evidence_json(proof: &CoalitionProof, config: &CoalitionConfig) -> String {
    let root_hex = hex_encode(&proof.coalition_root);
    let spend_commit_hex = hex_encode(&proof.total_spend_commit);
    let domain_hex = hex_encode(&config.domain_hash);
    format!(
        r#"{{"coalition_root":"{root_hex}","total_spend_commit":"{spend_commit_hex}","threshold_met":{threshold_met},"contributor_count":{contributor_count},"domain_hash":"{domain_hex}","mainnet_ready":false}}"#,
        root_hex = root_hex,
        spend_commit_hex = spend_commit_hex,
        threshold_met = proof.threshold_met,
        contributor_count = proof.contributor_count,
        domain_hex = domain_hex,
    )
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn test_nonce(seed: u8) -> [u8; 32] {
        [seed; 32]
    }

    fn test_domain() -> [u8; 32] {
        sha256(&[b"test-domain"])
    }

    fn default_config() -> CoalitionConfig {
        CoalitionConfig {
            spend_threshold: 1_000,
            max_members: 5,
            domain_hash: test_domain(),
            mainnet_ready: false,
        }
    }

    // 1. mainnet_ready is always false on AgentContribution
    #[test]
    fn test_contribution_mainnet_ready_false() {
        let c = make_contribution(b"alice", 500, &test_nonce(1));
        assert!(!c.mainnet_ready);
    }

    // 2. agent_id_hash is not the raw agent_id bytes
    #[test]
    fn test_contribution_hides_agent_id() {
        let agent_id = b"alice";
        let c = make_contribution(agent_id, 500, &test_nonce(1));
        // The stored hash must not equal the raw agent_id padded to 32 bytes.
        let mut raw_padded = [0u8; 32];
        let len = agent_id.len().min(32);
        raw_padded[..len].copy_from_slice(&agent_id[..len]);
        assert_ne!(c.agent_id_hash, raw_padded);
        // Also must not equal a plain sha256 of just the agent bytes (no prefix).
        let plain_hash = sha256(&[agent_id.as_ref()]);
        assert_ne!(c.agent_id_hash, plain_hash);
    }

    // 3. verify_contribution round-trips correctly
    #[test]
    fn test_verify_contribution_passes() {
        let nonce = test_nonce(7);
        let c = make_contribution(b"bob", 300, &nonce);
        assert!(verify_contribution(&c, b"bob", 300, &nonce));
    }

    // 4. wrong amount fails
    #[test]
    fn test_verify_contribution_fails_wrong_amount() {
        let nonce = test_nonce(8);
        let c = make_contribution(b"bob", 300, &nonce);
        assert!(!verify_contribution(&c, b"bob", 301, &nonce));
    }

    // 5. wrong nonce fails
    #[test]
    fn test_verify_contribution_fails_wrong_nonce() {
        let nonce = test_nonce(9);
        let c = make_contribution(b"bob", 300, &nonce);
        assert!(!verify_contribution(&c, b"bob", 300, &test_nonce(10)));
    }

    // 6. prove_coalition succeeds when threshold is met
    #[test]
    fn test_prove_coalition_threshold_met() {
        let config = default_config();
        let c1 = make_contribution(b"alice", 600, &test_nonce(1));
        let c2 = make_contribution(b"bob", 500, &test_nonce(2));
        let proof = prove_coalition(&config, &[c1, c2], &[600, 500], &test_nonce(0));
        assert!(proof.is_ok());
        let p = proof.unwrap();
        assert!(p.threshold_met);
        assert_eq!(p.contributor_count, 2);
        assert!(!p.mainnet_ready);
    }

    // 7. prove_coalition returns ThresholdNotMet when sum < threshold
    #[test]
    fn test_prove_coalition_threshold_not_met() {
        let config = default_config();
        let c1 = make_contribution(b"alice", 400, &test_nonce(1));
        let c2 = make_contribution(b"bob", 400, &test_nonce(2));
        let err = prove_coalition(&config, &[c1, c2], &[400, 400], &test_nonce(0));
        assert_eq!(
            err,
            Err(CoalitionError::ThresholdNotMet {
                total: 800,
                threshold: 1_000
            })
        );
    }

    // 8. too many members is rejected
    #[test]
    fn test_too_many_members_rejected() {
        let config = CoalitionConfig {
            max_members: 2,
            ..default_config()
        };
        let cs: Vec<_> = (0u8..3)
            .map(|i| make_contribution(&[i], 400, &test_nonce(i)))
            .collect();
        let amounts = vec![400u64; 3];
        let err = prove_coalition(&config, &cs, &amounts, &test_nonce(0));
        assert_eq!(err, Err(CoalitionError::TooManyMembers { have: 3, max: 2 }));
    }

    // 9. empty coalition is rejected
    #[test]
    fn test_empty_coalition_rejected() {
        let config = default_config();
        let err = prove_coalition(&config, &[], &[], &test_nonce(0));
        assert_eq!(err, Err(CoalitionError::EmptyCoalition));
    }

    // 10. duplicate agent is rejected
    #[test]
    fn test_duplicate_agent_rejected() {
        let config = default_config();
        // Same agent_id → same agent_id_hash.
        let c1 = make_contribution(b"alice", 600, &test_nonce(1));
        let c2 = make_contribution(b"alice", 600, &test_nonce(2));
        let err = prove_coalition(&config, &[c1, c2], &[600, 600], &test_nonce(0));
        assert_eq!(err, Err(CoalitionError::DuplicateAgent));
    }

    // 11. coalition_root is order-independent
    #[test]
    fn test_coalition_root_order_independent() {
        let config = default_config();
        let c1 = make_contribution(b"alice", 600, &test_nonce(1));
        let c2 = make_contribution(b"bob", 500, &test_nonce(2));
        let nonce = test_nonce(0);

        let p1 = prove_coalition(&config, &[c1.clone(), c2.clone()], &[600, 500], &nonce).unwrap();
        let p2 = prove_coalition(&config, &[c2.clone(), c1.clone()], &[500, 600], &nonce).unwrap();
        assert_eq!(p1.coalition_root, p2.coalition_root);
    }

    // 12. verify_coalition_proof passes for a valid proof
    #[test]
    fn test_verify_coalition_proof_passes() {
        let config = default_config();
        let c1 = make_contribution(b"alice", 600, &test_nonce(1));
        let c2 = make_contribution(b"bob", 500, &test_nonce(2));
        let proof = prove_coalition(
            &config,
            &[c1.clone(), c2.clone()],
            &[600, 500],
            &test_nonce(0),
        )
        .unwrap();
        assert!(verify_coalition_proof(&proof, &[c1, c2], &config));
    }

    // 13. evidence_json contains no raw agent identities
    #[test]
    fn test_evidence_json_no_agent_ids() {
        let config = default_config();
        let c1 = make_contribution(b"alice", 600, &test_nonce(1));
        let c2 = make_contribution(b"bob", 500, &test_nonce(2));
        let proof = prove_coalition(&config, &[c1, c2], &[600, 500], &test_nonce(0)).unwrap();
        let json = evidence_json(&proof, &config);
        assert!(!json.contains("alice"));
        assert!(!json.contains("bob"));
        // No raw agent_id_hash key either.
        assert!(!json.contains("agent_id"));
    }

    // 14. evidence_json contains no raw u64 amount values
    #[test]
    fn test_evidence_json_no_raw_amounts() {
        let config = default_config();
        let c1 = make_contribution(b"alice", 600, &test_nonce(1));
        let c2 = make_contribution(b"bob", 500, &test_nonce(2));
        let proof = prove_coalition(&config, &[c1, c2], &[600, 500], &test_nonce(0)).unwrap();
        let json = evidence_json(&proof, &config);
        // Individual amounts must not appear.
        assert!(!json.contains("\"600\""));
        assert!(!json.contains(":600"));
        assert!(!json.contains("\"500\""));
        assert!(!json.contains(":500"));
        // Total (1100) must not appear either.
        assert!(!json.contains("\"1100\""));
        assert!(!json.contains(":1100"));
        // spend_threshold must not appear in plain form.
        assert!(!json.contains("spend_threshold"));
    }

    // 15. CoalitionProof mainnet_ready is always false
    #[test]
    fn test_coalition_proof_mainnet_ready_false() {
        let config = default_config();
        let c1 = make_contribution(b"alice", 600, &test_nonce(1));
        let c2 = make_contribution(b"bob", 500, &test_nonce(2));
        let proof = prove_coalition(&config, &[c1, c2], &[600, 500], &test_nonce(0)).unwrap();
        assert!(!proof.mainnet_ready);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_coalition_root_domain_sensitive() {
        let config1 = default_config();
        let config2 = CoalitionConfig {
            domain_hash: sha256(&[b"other-domain"]),
            ..default_config()
        };
        let c1 = make_contribution(b"alice", 600, &test_nonce(1));
        let c2 = make_contribution(b"bob", 500, &test_nonce(2));
        let nonce = test_nonce(0);
        let p1 = prove_coalition(&config1, &[c1.clone(), c2.clone()], &[600, 500], &nonce).unwrap();
        let p2 = prove_coalition(&config2, &[c1, c2], &[600, 500], &nonce).unwrap();
        assert_ne!(p1.coalition_root, p2.coalition_root);
    }
}
