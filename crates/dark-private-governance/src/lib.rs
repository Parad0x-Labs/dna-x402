use sha2::{Digest, Sha256};

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct Proposal {
    /// SHA256("gov-proposal-v1" || proposer_hash || content_hash)
    pub proposal_id: [u8; 32],
    /// SHA256("gov-proposer-v1" || proposer_secret)
    pub proposer_hash: [u8; 32],
    /// SHA256("gov-content-v1" || content)
    pub content_hash: [u8; 32],
    /// SHA256("gov-root-v1" || xor_fold(vote_ids) || count_le4)
    pub vote_root: [u8; 32],
    pub vote_count: u32,
    pub yes_count: u32,
    pub no_count: u32,
    pub finalized: bool,
    pub mainnet_ready: bool,
    // internal voter tracking
    voter_hashes: Vec<[u8; 32]>,
    vote_ids: Vec<[u8; 32]>,
}

#[derive(Debug, Clone)]
pub struct VoteCommitment {
    /// SHA256("gov-vid-v1" || proposal_id || voter_hash)
    pub vote_id: [u8; 32],
    /// SHA256("gov-vote-v1" || voter_hash || [choice] || nonce)
    pub commitment: [u8; 32],
}

#[derive(Debug, PartialEq)]
pub enum GovError {
    ZeroProposerSecret,
    EmptyContent,
    AlreadyFinalized,
    DuplicateVoter,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn sha256_parts(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn xor_fold(ids: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = [0u8; 32];
    for id in ids {
        for (a, b) in acc.iter_mut().zip(id.iter()) {
            *a ^= b;
        }
    }
    acc
}

// ── Hash formulas ─────────────────────────────────────────────────────────────

pub fn proposer_hash(secret: &[u8; 32]) -> [u8; 32] {
    sha256_parts(&[b"gov-proposer-v1", secret.as_ref()])
}

pub fn content_hash(content: &[u8]) -> [u8; 32] {
    sha256_parts(&[b"gov-content-v1", content])
}

pub fn proposal_id(proposer_h: &[u8; 32], content_h: &[u8; 32]) -> [u8; 32] {
    sha256_parts(&[b"gov-proposal-v1", proposer_h.as_ref(), content_h.as_ref()])
}

pub fn voter_hash(voter_secret: &[u8; 32]) -> [u8; 32] {
    sha256_parts(&[b"gov-voter-v1", voter_secret.as_ref()])
}

pub fn vote_commitment(voter_h: &[u8; 32], choice: bool, nonce: &[u8; 32]) -> [u8; 32] {
    sha256_parts(&[
        b"gov-vote-v1",
        voter_h.as_ref(),
        &[if choice { 1u8 } else { 0u8 }],
        nonce.as_ref(),
    ])
}

pub fn vote_id(proposal_id_h: &[u8; 32], voter_h: &[u8; 32]) -> [u8; 32] {
    sha256_parts(&[b"gov-vid-v1", proposal_id_h.as_ref(), voter_h.as_ref()])
}

pub fn vote_root(vote_ids: &[[u8; 32]], count: u32) -> [u8; 32] {
    let folded = xor_fold(vote_ids);
    sha256_parts(&[b"gov-root-v1", folded.as_ref(), &count.to_le_bytes()])
}

// ── Public API ────────────────────────────────────────────────────────────────

pub fn new_proposal(proposer_secret: &[u8; 32], content: &[u8]) -> Result<Proposal, GovError> {
    if proposer_secret == &[0u8; 32] {
        return Err(GovError::ZeroProposerSecret);
    }
    if content.is_empty() {
        return Err(GovError::EmptyContent);
    }

    let ph = proposer_hash(proposer_secret);
    let ch = content_hash(content);
    let pid = proposal_id(&ph, &ch);
    let initial_root = vote_root(&[], 0);

    Ok(Proposal {
        proposal_id: pid,
        proposer_hash: ph,
        content_hash: ch,
        vote_root: initial_root,
        vote_count: 0,
        yes_count: 0,
        no_count: 0,
        finalized: false,
        mainnet_ready: false,
        voter_hashes: Vec::new(),
        vote_ids: Vec::new(),
    })
}

pub fn cast_vote(
    proposal: &mut Proposal,
    voter_secret: &[u8; 32],
    choice: bool,
    nonce: &[u8; 32],
) -> Result<VoteCommitment, GovError> {
    if proposal.finalized {
        return Err(GovError::AlreadyFinalized);
    }

    let vh = voter_hash(voter_secret);

    // Check for duplicate voter
    if proposal.voter_hashes.contains(&vh) {
        return Err(GovError::DuplicateVoter);
    }

    let vc = vote_commitment(&vh, choice, nonce);
    let vid = vote_id(&proposal.proposal_id, &vh);

    proposal.voter_hashes.push(vh);
    proposal.vote_ids.push(vid);
    proposal.vote_count += 1;
    if choice {
        proposal.yes_count += 1;
    } else {
        proposal.no_count += 1;
    }
    proposal.vote_root = vote_root(&proposal.vote_ids, proposal.vote_count);

    Ok(VoteCommitment {
        vote_id: vid,
        commitment: vc,
    })
}

pub fn finalize_proposal(proposal: &mut Proposal) -> Result<(), GovError> {
    if proposal.finalized {
        return Err(GovError::AlreadyFinalized);
    }
    proposal.finalized = true;
    Ok(())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const PROPOSER: [u8; 32] = [0x01u8; 32];
    const VOTER_A: [u8; 32] = [0x02u8; 32];
    const VOTER_B: [u8; 32] = [0x03u8; 32];
    const NONCE_A: [u8; 32] = [0xaau8; 32];
    const NONCE_B: [u8; 32] = [0xbbu8; 32];
    const CONTENT: &[u8] = b"Proposal: increase fee to 0.5%";

    #[test]
    fn create_proposal() {
        let p = new_proposal(&PROPOSER, CONTENT).unwrap();
        assert_ne!(p.proposal_id, [0u8; 32]);
        assert_ne!(p.proposer_hash, [0u8; 32]);
        assert_eq!(p.vote_count, 0);
        assert!(!p.finalized);
        assert!(!p.mainnet_ready);
    }

    #[test]
    fn cast_yes_and_no_vote_updates_counts() {
        let mut p = new_proposal(&PROPOSER, CONTENT).unwrap();
        let root_before = p.vote_root;

        cast_vote(&mut p, &VOTER_A, true, &NONCE_A).unwrap();
        cast_vote(&mut p, &VOTER_B, false, &NONCE_B).unwrap();

        assert_eq!(p.vote_count, 2);
        assert_eq!(p.yes_count, 1);
        assert_eq!(p.no_count, 1);
        assert_ne!(p.vote_root, root_before);
    }

    #[test]
    fn duplicate_voter_rejected() {
        let mut p = new_proposal(&PROPOSER, CONTENT).unwrap();
        cast_vote(&mut p, &VOTER_A, true, &NONCE_A).unwrap();
        let result = cast_vote(&mut p, &VOTER_A, false, &NONCE_B);
        assert_eq!(result.unwrap_err(), GovError::DuplicateVoter);
    }

    #[test]
    fn finalize_sets_flag() {
        let mut p = new_proposal(&PROPOSER, CONTENT).unwrap();
        finalize_proposal(&mut p).unwrap();
        assert!(p.finalized);
    }

    #[test]
    fn already_finalized_cast_rejected() {
        let mut p = new_proposal(&PROPOSER, CONTENT).unwrap();
        finalize_proposal(&mut p).unwrap();
        let result = cast_vote(&mut p, &VOTER_A, true, &NONCE_A);
        assert_eq!(result.unwrap_err(), GovError::AlreadyFinalized);
    }

    #[test]
    fn mainnet_ready_is_false() {
        let p = new_proposal(&PROPOSER, CONTENT).unwrap();
        assert!(!p.mainnet_ready);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_content_hash_nonzero() {
        let p = new_proposal(&PROPOSER, CONTENT).unwrap();
        assert_ne!(p.content_hash, [0u8; 32]);
    }

    #[test]
    fn test_proposal_id_nonzero() {
        let p = new_proposal(&PROPOSER, CONTENT).unwrap();
        assert_ne!(p.proposal_id, [0u8; 32]);
    }

    #[test]
    fn test_vote_root_changes_after_vote() {
        let mut p = new_proposal(&PROPOSER, CONTENT).unwrap();
        let root_before = p.vote_root;
        cast_vote(&mut p, &VOTER_A, true, &NONCE_A).unwrap();
        assert_ne!(p.vote_root, root_before);
    }

    #[test]
    fn test_vote_count_zero_initially() {
        let p = new_proposal(&PROPOSER, CONTENT).unwrap();
        assert_eq!(p.vote_count, 0);
    }

    #[test]
    fn test_yes_count_increments() {
        let mut p = new_proposal(&PROPOSER, CONTENT).unwrap();
        cast_vote(&mut p, &VOTER_A, true, &NONCE_A).unwrap();
        assert_eq!(p.yes_count, 1);
    }

    #[test]
    fn test_no_count_increments() {
        let mut p = new_proposal(&PROPOSER, CONTENT).unwrap();
        cast_vote(&mut p, &VOTER_A, false, &NONCE_A).unwrap();
        assert_eq!(p.no_count, 1);
    }

    #[test]
    fn test_vote_commitment_nonzero() {
        let mut p = new_proposal(&PROPOSER, CONTENT).unwrap();
        let vc = cast_vote(&mut p, &VOTER_A, true, &NONCE_A).unwrap();
        assert_ne!(vc.commitment, [0u8; 32]);
    }

    #[test]
    fn test_vote_id_nonzero() {
        let mut p = new_proposal(&PROPOSER, CONTENT).unwrap();
        let vc = cast_vote(&mut p, &VOTER_A, true, &NONCE_A).unwrap();
        assert_ne!(vc.vote_id, [0u8; 32]);
    }

    #[test]
    fn test_double_finalize_rejected() {
        let mut p = new_proposal(&PROPOSER, CONTENT).unwrap();
        finalize_proposal(&mut p).unwrap();
        let err = finalize_proposal(&mut p).unwrap_err();
        assert_eq!(err, GovError::AlreadyFinalized);
    }

    #[test]
    fn test_zero_proposer_rejected() {
        let err = new_proposal(&[0u8; 32], CONTENT).unwrap_err();
        assert_eq!(err, GovError::ZeroProposerSecret);
    }
}
