use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

pub const MAX_GOAL: u64 = 1_000_000_000_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Crowdfund {
    pub campaign_id: [u8; 32],
    pub organizer_hash: [u8; 32],
    pub goal_commitment: [u8; 32],
    pub contribution_root: [u8; 32],
    pub contribution_count: u32,
    pub total_committed: u64,
    pub funded: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Contribution {
    pub contrib_id: [u8; 32],
    pub commitment: [u8; 32],
}

#[derive(Debug, PartialEq)]
pub enum CrowdfundError {
    ZeroOrganizerSecret,
    AlreadyFunded,
    GoalTooHigh,
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

// ── Hash formulas ──────────────────────────────────────────────────────────

fn compute_organizer_hash(secret: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"cf-organizer-v1", secret])
}

fn compute_goal_commitment(goal: u64, blinding: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"cf-goal-v1", &goal.to_le_bytes(), blinding])
}

fn compute_campaign_id(org_hash: &[u8; 32], goal_commit: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"cf-id-v1", org_hash, goal_commit])
}

fn compute_backer_hash(backer_secret: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"cf-backer-v1", backer_secret])
}

fn compute_contribution_commitment(
    backer_hash: &[u8; 32],
    amount: u64,
    nonce: &[u8; 32],
) -> [u8; 32] {
    sha256_multi(&[b"cf-contrib-v1", backer_hash, &amount.to_le_bytes(), nonce])
}

fn compute_contrib_id(campaign_id: &[u8; 32], backer_hash: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"cf-cid-v1", campaign_id, backer_hash])
}

fn compute_contribution_root(contrib_ids: &[[u8; 32]], count: u32) -> [u8; 32] {
    let xored = xor_fold(contrib_ids);
    sha256_multi(&[b"cf-root-v1", &xored, &count.to_le_bytes()])
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn new_crowdfund(
    organizer_secret: &[u8; 32],
    goal: u64,
    goal_blinding: &[u8; 32],
) -> Result<Crowdfund, CrowdfundError> {
    if organizer_secret == &[0u8; 32] {
        return Err(CrowdfundError::ZeroOrganizerSecret);
    }
    if goal > MAX_GOAL {
        return Err(CrowdfundError::GoalTooHigh);
    }
    let org_hash = compute_organizer_hash(organizer_secret);
    let goal_commit = compute_goal_commitment(goal, goal_blinding);
    let campaign_id = compute_campaign_id(&org_hash, &goal_commit);
    let empty_root = compute_contribution_root(&[], 0);
    Ok(Crowdfund {
        campaign_id,
        organizer_hash: org_hash,
        goal_commitment: goal_commit,
        contribution_root: empty_root,
        contribution_count: 0,
        total_committed: 0,
        funded: false,
        mainnet_ready: false,
    })
}

pub fn back_campaign(
    cf: &mut Crowdfund,
    backer_secret: &[u8; 32],
    amount: u64,
    nonce: &[u8; 32],
    goal: u64,
) -> Result<Contribution, CrowdfundError> {
    if cf.funded {
        return Err(CrowdfundError::AlreadyFunded);
    }
    let backer_hash = compute_backer_hash(backer_secret);
    let commitment = compute_contribution_commitment(&backer_hash, amount, nonce);
    let contrib_id = compute_contrib_id(&cf.campaign_id, &backer_hash);

    // Update state
    cf.total_committed = cf.total_committed.saturating_add(amount);
    cf.contribution_count += 1;
    // Rebuild contribution root with the new contrib_id (simple: fold all existing by re-deriving)
    // For simplicity, XOR-fold the campaign_id with contrib_id using count as domain separator
    let new_root =
        compute_contribution_root(&[cf.contribution_root, contrib_id], cf.contribution_count);
    cf.contribution_root = new_root;
    if cf.total_committed >= goal {
        cf.funded = true;
    }
    Ok(Contribution {
        contrib_id,
        commitment,
    })
}

pub fn is_funded(cf: &Crowdfund) -> bool {
    cf.funded
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn org_secret() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0x11;
        s
    }
    fn goal_blind() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0x22;
        s
    }
    fn backer1() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0x33;
        s
    }
    fn nonce1() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0x44;
        s
    }

    // Test 1: new_crowdfund + mainnet_ready=false
    #[test]
    fn test_new_crowdfund_mainnet_ready_false() {
        let cf = new_crowdfund(&org_secret(), 1_000, &goal_blind()).unwrap();
        assert!(!cf.mainnet_ready);
        assert!(!cf.funded);
        assert_eq!(cf.contribution_count, 0);
        assert_eq!(cf.total_committed, 0);
    }

    // Test 2: back_campaign updates total
    #[test]
    fn test_back_campaign_updates_total() {
        let mut cf = new_crowdfund(&org_secret(), 1_000, &goal_blind()).unwrap();
        back_campaign(&mut cf, &backer1(), 300, &nonce1(), 1_000).unwrap();
        assert_eq!(cf.total_committed, 300);
        assert_eq!(cf.contribution_count, 1);
    }

    // Test 3: funded after reaching goal
    #[test]
    fn test_funded_after_reaching_goal() {
        let mut cf = new_crowdfund(&org_secret(), 500, &goal_blind()).unwrap();
        back_campaign(&mut cf, &backer1(), 500, &nonce1(), 500).unwrap();
        assert!(cf.funded);
        assert!(is_funded(&cf));
    }

    // Test 4: already_funded returns error
    #[test]
    fn test_already_funded_returns_error() {
        let mut cf = new_crowdfund(&org_secret(), 100, &goal_blind()).unwrap();
        back_campaign(&mut cf, &backer1(), 100, &nonce1(), 100).unwrap();
        let mut b2 = [0u8; 32];
        b2[0] = 0x55;
        let mut n2 = [0u8; 32];
        n2[0] = 0x66;
        let err = back_campaign(&mut cf, &b2, 50, &n2, 100).unwrap_err();
        assert_eq!(err, CrowdfundError::AlreadyFunded);
    }

    // Test 5: zero_organizer rejected
    #[test]
    fn test_zero_organizer_rejected() {
        let err = new_crowdfund(&[0u8; 32], 1_000, &goal_blind()).unwrap_err();
        assert_eq!(err, CrowdfundError::ZeroOrganizerSecret);
    }

    // Test 6: campaign_id is deterministic
    #[test]
    fn test_campaign_id_is_deterministic() {
        let cf1 = new_crowdfund(&org_secret(), 1_000, &goal_blind()).unwrap();
        let cf2 = new_crowdfund(&org_secret(), 1_000, &goal_blind()).unwrap();
        assert_eq!(cf1.campaign_id, cf2.campaign_id);
        assert_ne!(cf1.campaign_id, [0u8; 32]);
    }
}
