use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

pub const MAX_MEMBERS: u32 = 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaoV2 {
    pub dao_id: [u8; 32],
    pub founder_hash: [u8; 32],
    pub treasury_commitment: [u8; 32],
    pub member_root: [u8; 32],
    pub member_count: u32,
    pub proposal_root: [u8; 32],
    pub proposal_count: u32,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaoProposal {
    pub proposal_id: [u8; 32],
    pub proposer_hash: [u8; 32],
    pub content_commitment: [u8; 32],
}

#[derive(Debug, PartialEq)]
pub enum DaoError {
    ZeroFounderSecret,
    EmptyContent,
    MemberLimitReached,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn xor_fold(hashes: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = [0u8; 32];
    for h in hashes {
        for i in 0..32 {
            acc[i] ^= h[i];
        }
    }
    acc
}

fn hex32(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

// ── Hash formulas ──────────────────────────────────────────────────────────

fn compute_founder_hash(secret: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"dao2-founder-v1", secret])
}

fn compute_dao_id(founder_hash: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"dao2-id-v1", founder_hash])
}

fn compute_treasury_commitment(amount: u64, blinding: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"dao2-treasury-v1", &amount.to_le_bytes(), blinding])
}

fn compute_member_hash(member_secret: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"dao2-member-v1", member_secret])
}

fn compute_member_root(hashes: &[[u8; 32]], count: u32) -> [u8; 32] {
    let xored = xor_fold(hashes);
    sha256_multi(&[b"dao2-mroot-v1", &xored, &count.to_le_bytes()])
}

fn compute_content_commitment(content: &[u8]) -> [u8; 32] {
    sha256_multi(&[b"dao2-content-v1", content])
}

fn compute_proposal_id(
    dao_id: &[u8; 32],
    proposer_hash: &[u8; 32],
    content_commit: &[u8; 32],
) -> [u8; 32] {
    sha256_multi(&[b"dao2-prop-v1", dao_id, proposer_hash, content_commit])
}

fn compute_proposal_root(prop_ids: &[[u8; 32]], count: u32) -> [u8; 32] {
    let xored = xor_fold(prop_ids);
    sha256_multi(&[b"dao2-proot-v1", &xored, &count.to_le_bytes()])
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn new_dao(
    founder_secret: &[u8; 32],
    initial_treasury: u64,
    treasury_blinding: &[u8; 32],
) -> Result<DaoV2, DaoError> {
    if founder_secret == &[0u8; 32] {
        return Err(DaoError::ZeroFounderSecret);
    }
    let founder_hash = compute_founder_hash(founder_secret);
    let dao_id = compute_dao_id(&founder_hash);
    let treasury_commitment = compute_treasury_commitment(initial_treasury, treasury_blinding);
    let member_root = compute_member_root(&[], 0);
    let proposal_root = compute_proposal_root(&[], 0);
    Ok(DaoV2 {
        dao_id,
        founder_hash,
        treasury_commitment,
        member_root,
        member_count: 0,
        proposal_root,
        proposal_count: 0,
        mainnet_ready: false,
    })
}

pub fn add_member(dao: &mut DaoV2, member_secret: &[u8; 32]) -> Result<[u8; 32], DaoError> {
    if dao.member_count >= MAX_MEMBERS {
        return Err(DaoError::MemberLimitReached);
    }
    let mhash = compute_member_hash(member_secret);
    dao.member_count += 1;
    // Update member root by folding the previous root with the new member hash
    let new_root = compute_member_root(&[dao.member_root, mhash], dao.member_count);
    dao.member_root = new_root;
    Ok(mhash)
}

pub fn create_proposal(
    dao: &mut DaoV2,
    proposer_secret: &[u8; 32],
    content: &[u8],
) -> Result<DaoProposal, DaoError> {
    if content.is_empty() {
        return Err(DaoError::EmptyContent);
    }
    let proposer_hash = compute_member_hash(proposer_secret);
    let content_commitment = compute_content_commitment(content);
    let proposal_id = compute_proposal_id(&dao.dao_id, &proposer_hash, &content_commitment);
    dao.proposal_count += 1;
    let new_root = compute_proposal_root(&[dao.proposal_root, proposal_id], dao.proposal_count);
    dao.proposal_root = new_root;
    Ok(DaoProposal {
        proposal_id,
        proposer_hash,
        content_commitment,
    })
}

pub fn dao_public_record(dao: &DaoV2) -> String {
    serde_json::json!({
        "dao_id": hex32(&dao.dao_id),
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
        s[0] = 0xf1;
        s
    }
    fn tblind() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xf2;
        s
    }
    fn member1() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xaa;
        s
    }

    // Test 1: new_dao + mainnet_ready=false
    #[test]
    fn test_new_dao_mainnet_ready_false() {
        let dao = new_dao(&founder(), 5_000, &tblind()).unwrap();
        assert!(!dao.mainnet_ready);
        assert_eq!(dao.member_count, 0);
        assert_eq!(dao.proposal_count, 0);
    }

    // Test 2: add_member updates root
    #[test]
    fn test_add_member_updates_root() {
        let mut dao = new_dao(&founder(), 5_000, &tblind()).unwrap();
        let root_before = dao.member_root;
        add_member(&mut dao, &member1()).unwrap();
        assert_ne!(dao.member_root, root_before);
        assert_eq!(dao.member_count, 1);
    }

    // Test 3: proposal_root changes
    #[test]
    fn test_proposal_root_changes() {
        let mut dao = new_dao(&founder(), 5_000, &tblind()).unwrap();
        let root_before = dao.proposal_root;
        create_proposal(&mut dao, &member1(), b"fund public goods").unwrap();
        assert_ne!(dao.proposal_root, root_before);
        assert_eq!(dao.proposal_count, 1);
    }

    // Test 4: zero_founder rejected
    #[test]
    fn test_zero_founder_rejected() {
        let err = new_dao(&[0u8; 32], 1_000, &tblind()).unwrap_err();
        assert_eq!(err, DaoError::ZeroFounderSecret);
    }

    // Test 5: empty_content rejected
    #[test]
    fn test_empty_content_rejected() {
        let mut dao = new_dao(&founder(), 1_000, &tblind()).unwrap();
        let err = create_proposal(&mut dao, &member1(), b"").unwrap_err();
        assert_eq!(err, DaoError::EmptyContent);
    }

    // Test 6: dao_id is deterministic
    #[test]
    fn test_dao_id_is_deterministic() {
        let d1 = new_dao(&founder(), 5_000, &tblind()).unwrap();
        let d2 = new_dao(&founder(), 5_000, &tblind()).unwrap();
        assert_eq!(d1.dao_id, d2.dao_id);
        assert_ne!(d1.dao_id, [0u8; 32]);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_dao_id_nonzero() {
        let dao = new_dao(&founder(), 1_000, &tblind()).unwrap();
        assert_ne!(dao.dao_id, [0u8; 32]);
    }

    #[test]
    fn test_founder_hash_nonzero() {
        let dao = new_dao(&founder(), 1_000, &tblind()).unwrap();
        assert_ne!(dao.founder_hash, [0u8; 32]);
    }

    #[test]
    fn test_treasury_commitment_nonzero() {
        let dao = new_dao(&founder(), 1_000, &tblind()).unwrap();
        assert_ne!(dao.treasury_commitment, [0u8; 32]);
    }

    #[test]
    fn test_mainnet_ready_false() {
        let dao = new_dao(&founder(), 1_000, &tblind()).unwrap();
        assert!(!dao.mainnet_ready);
    }

    #[test]
    fn test_member_count_increments() {
        let mut dao = new_dao(&founder(), 1_000, &tblind()).unwrap();
        assert_eq!(dao.member_count, 0);
        add_member(&mut dao, &member1()).unwrap();
        assert_eq!(dao.member_count, 1);
    }

    #[test]
    fn test_proposal_count_increments() {
        let mut dao = new_dao(&founder(), 1_000, &tblind()).unwrap();
        assert_eq!(dao.proposal_count, 0);
        create_proposal(&mut dao, &member1(), b"proposal content").unwrap();
        assert_eq!(dao.proposal_count, 1);
    }

    #[test]
    fn test_member_hash_nonzero() {
        let mut dao = new_dao(&founder(), 1_000, &tblind()).unwrap();
        let mhash = add_member(&mut dao, &member1()).unwrap();
        assert_ne!(mhash, [0u8; 32]);
    }

    #[test]
    fn test_proposal_id_nonzero() {
        let mut dao = new_dao(&founder(), 1_000, &tblind()).unwrap();
        let prop = create_proposal(&mut dao, &member1(), b"build something").unwrap();
        assert_ne!(prop.proposal_id, [0u8; 32]);
    }

    #[test]
    fn test_different_founder_different_dao_id() {
        let mut s2 = [0u8; 32];
        s2[0] = 0xf9;
        let d1 = new_dao(&founder(), 1_000, &tblind()).unwrap();
        let d2 = new_dao(&s2, 1_000, &tblind()).unwrap();
        assert_ne!(d1.dao_id, d2.dao_id);
    }

    #[test]
    fn test_public_record_has_correct_fields() {
        let dao = new_dao(&founder(), 1_000, &tblind()).unwrap();
        let v: serde_json::Value = serde_json::from_str(&dao_public_record(&dao)).unwrap();
        assert!(v["dao_id"].is_string());
        assert_eq!(v["member_count"], 0u32);
        assert_eq!(v["proposal_count"], 0u32);
        assert_eq!(v["mainnet_ready"], false);
    }
}
