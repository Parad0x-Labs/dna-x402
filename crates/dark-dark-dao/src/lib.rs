use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DarkDao {
    pub dao_id: [u8; 32],
    pub governance_root: [u8; 32],
    /// Repurposed: stores the quorum threshold.
    pub member_count: u32,
    pub proposal_count: u32,
    pub treasury_commitment: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaoProposal {
    pub proposal_hash: [u8; 32],
    pub dao_id: [u8; 32],
    pub proposer_hash: [u8; 32],
    pub action_hash: [u8; 32],
    pub vote_count: u32,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum DaoError {
    ZeroFounderSecret,
    EmptyAction,
    QuorumNotMet { need: u32, got: u32 },
    AlreadyFinalized,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

fn hex(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn create_dao(
    founder_secret: &[u8; 32],
    initial_balance: u64,
    quorum: u32,
    nonce: &[u8; 32],
) -> Result<DarkDao, DaoError> {
    if founder_secret == &[0u8; 32] {
        return Err(DaoError::ZeroFounderSecret);
    }

    // founder_hash = SHA256("dao-founder-v1" || founder_secret)
    let founder_hash = {
        let mut d = Vec::new();
        d.extend_from_slice(b"dao-founder-v1");
        d.extend_from_slice(founder_secret);
        sha256(&d)
    };

    // dao_id = SHA256("dao-id-v1" || founder_hash || quorum_le || nonce)
    let dao_id = {
        let mut d = Vec::new();
        d.extend_from_slice(b"dao-id-v1");
        d.extend_from_slice(&founder_hash);
        d.extend_from_slice(&quorum.to_le_bytes());
        d.extend_from_slice(nonce);
        sha256(&d)
    };

    // treasury_commitment = SHA256("dao-treasury-v1" || dao_id || initial_balance_le)
    let treasury_commitment = {
        let mut d = Vec::new();
        d.extend_from_slice(b"dao-treasury-v1");
        d.extend_from_slice(&dao_id);
        d.extend_from_slice(&initial_balance.to_le_bytes());
        sha256(&d)
    };

    // governance_root = SHA256("dao-gov-root-v1" || dao_id || [0u8;32])
    let governance_root = {
        let mut d = Vec::new();
        d.extend_from_slice(b"dao-gov-root-v1");
        d.extend_from_slice(&dao_id);
        d.extend_from_slice(&[0u8; 32]);
        sha256(&d)
    };

    Ok(DarkDao {
        dao_id,
        governance_root,
        member_count: quorum, // store quorum threshold here
        proposal_count: 0,
        treasury_commitment,
        mainnet_ready: false,
    })
}

pub fn create_proposal(
    dao: &DarkDao,
    proposer_secret: &[u8; 32],
    action_bytes: &[u8],
) -> Result<DaoProposal, DaoError> {
    if action_bytes.is_empty() {
        return Err(DaoError::EmptyAction);
    }

    // proposer_hash = SHA256("dao-proposer-v1" || proposer_secret)
    let proposer_hash = {
        let mut d = Vec::new();
        d.extend_from_slice(b"dao-proposer-v1");
        d.extend_from_slice(proposer_secret);
        sha256(&d)
    };

    // action_hash = SHA256("dao-action-v1" || action_bytes)
    let action_hash = {
        let mut d = Vec::new();
        d.extend_from_slice(b"dao-action-v1");
        d.extend_from_slice(action_bytes);
        sha256(&d)
    };

    // proposal_hash = SHA256("dao-proposal-v1" || dao_id || proposer_hash || action_hash)
    let proposal_hash = {
        let mut d = Vec::new();
        d.extend_from_slice(b"dao-proposal-v1");
        d.extend_from_slice(&dao.dao_id);
        d.extend_from_slice(&proposer_hash);
        d.extend_from_slice(&action_hash);
        sha256(&d)
    };

    Ok(DaoProposal {
        proposal_hash,
        dao_id: dao.dao_id,
        proposer_hash,
        action_hash,
        vote_count: 0,
        mainnet_ready: false,
    })
}

pub fn finalize_proposal(
    dao: &DarkDao,
    proposal: &mut DaoProposal,
    votes_cast: u32,
) -> Result<bool, DaoError> {
    if proposal.vote_count > 0 {
        return Err(DaoError::AlreadyFinalized);
    }
    let quorum = dao.member_count;
    if votes_cast < quorum {
        return Err(DaoError::QuorumNotMet {
            need: quorum,
            got: votes_cast,
        });
    }
    proposal.vote_count = votes_cast;
    Ok(votes_cast >= quorum)
}

pub fn dao_public_record(dao: &DarkDao) -> String {
    serde_json::json!({
        "dao_id": hex(&dao.dao_id),
        "governance_root": hex(&dao.governance_root),
        "member_count": dao.member_count,
        "proposal_count": dao.proposal_count,
        "mainnet_ready": dao.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn founder() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 1;
        s
    }
    fn nonce() -> [u8; 32] {
        let mut n = [0u8; 32];
        n[31] = 42;
        n
    }
    fn proposer() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[1] = 7;
        s
    }

    // Test 1: happy path — create + propose + finalize
    #[test]
    fn test_happy_path() {
        let dao = create_dao(&founder(), 1_000_000, 3, &nonce()).unwrap();
        assert!(!dao.mainnet_ready);
        let mut proposal = create_proposal(&dao, &proposer(), b"upgrade-protocol").unwrap();
        assert!(!proposal.mainnet_ready);
        let passed = finalize_proposal(&dao, &mut proposal, 4).unwrap();
        assert!(passed);
        assert_eq!(proposal.vote_count, 4);
    }

    // Test 2: quorum not met → rejected
    #[test]
    fn test_quorum_not_met() {
        let dao = create_dao(&founder(), 0, 5, &nonce()).unwrap();
        let mut proposal = create_proposal(&dao, &proposer(), b"some-action").unwrap();
        let err = finalize_proposal(&dao, &mut proposal, 3).unwrap_err();
        assert_eq!(err, DaoError::QuorumNotMet { need: 5, got: 3 });
    }

    // Test 3: zero founder secret → rejected
    #[test]
    fn test_zero_founder_rejected() {
        let err = create_dao(&[0u8; 32], 0, 1, &nonce()).unwrap_err();
        assert_eq!(err, DaoError::ZeroFounderSecret);
    }

    // Test 4: empty action → rejected
    #[test]
    fn test_empty_action_rejected() {
        let dao = create_dao(&founder(), 0, 1, &nonce()).unwrap();
        let err = create_proposal(&dao, &proposer(), b"").unwrap_err();
        assert_eq!(err, DaoError::EmptyAction);
    }

    // Test 5: proposal_hash is deterministic
    #[test]
    fn test_proposal_hash_deterministic() {
        let dao = create_dao(&founder(), 0, 1, &nonce()).unwrap();
        let p1 = create_proposal(&dao, &proposer(), b"action-x").unwrap();
        let p2 = create_proposal(&dao, &proposer(), b"action-x").unwrap();
        assert_eq!(p1.proposal_hash, p2.proposal_hash);
    }

    // Test 6: public record contains required fields, mainnet_ready=false
    #[test]
    fn test_public_record_fields() {
        let dao = create_dao(&founder(), 500, 2, &nonce()).unwrap();
        let record = dao_public_record(&dao);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["dao_id"].is_string());
        assert!(v["governance_root"].is_string());
        assert_eq!(v["member_count"], 2u32);
        assert_eq!(v["mainnet_ready"], false);
    }
}
