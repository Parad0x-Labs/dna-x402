use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Proposal {
    pub proposal_id: [u8; 32],
    pub proposer_hash: [u8; 32],
    pub content_hash: [u8; 32],
    pub vote_root: [u8; 32],
    pub yes_count: u32,
    pub no_count: u32,
    pub executed: bool,
    pub mainnet_ready: bool,
    /// Internal: XOR accumulator of voter_hashes for duplicate detection (not in public record).
    #[serde(skip)]
    voted_voters_xor: [u8; 32],
    /// Internal: list of voter_hashes that have voted.
    #[serde(skip)]
    voted_voters: Vec<[u8; 32]>,
    /// Internal: XOR accumulator of vote_ids for computing vote_root.
    #[serde(skip)]
    vote_ids_xor: [u8; 32],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Vote {
    pub vote_id: [u8; 32],
    pub voter_hash: [u8; 32],
    pub choice: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum GovError {
    ZeroProposerSecret,
    EmptyContent,
    AlreadyExecuted,
    DuplicateVoter,
}

fn sha256(data: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for d in data {
        h.update(d);
    }
    h.finalize().into()
}

fn xor32(a: [u8; 32], b: [u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = a[i] ^ b[i];
    }
    out
}

pub fn create_proposal(
    proposer_secret: &[u8; 32],
    content_bytes: &[u8],
    nonce: &[u8; 32],
) -> Result<Proposal, GovError> {
    if proposer_secret == &[0u8; 32] {
        return Err(GovError::ZeroProposerSecret);
    }
    if content_bytes.is_empty() {
        return Err(GovError::EmptyContent);
    }
    let proposer_hash = sha256(&[b"gov-proposer-v1", proposer_secret]);
    let content_hash = sha256(&[b"gov-content-v1", content_bytes]);
    let proposal_id = sha256(&[b"gov-proposal-v1", &proposer_hash, &content_hash, nonce]);
    Ok(Proposal {
        proposal_id,
        proposer_hash,
        content_hash,
        vote_root: [0u8; 32],
        yes_count: 0,
        no_count: 0,
        executed: false,
        mainnet_ready: false,
        voted_voters_xor: [0u8; 32],
        voted_voters: Vec::new(),
        vote_ids_xor: [0u8; 32],
    })
}

pub fn cast_vote(
    proposal: &mut Proposal,
    voter_secret: &[u8; 32],
    choice: bool,
) -> Result<Vote, GovError> {
    let voter_hash = sha256(&[b"gov-voter-v1", voter_secret]);

    // Duplicate detection
    if proposal.voted_voters.contains(&voter_hash) {
        return Err(GovError::DuplicateVoter);
    }

    let vote_id = sha256(&[
        b"gov-vote-v1",
        &proposal.proposal_id,
        &voter_hash,
        &[choice as u8],
    ]);

    // Update accumulators
    proposal.voted_voters.push(voter_hash);
    proposal.voted_voters_xor = xor32(proposal.voted_voters_xor, voter_hash);
    proposal.vote_ids_xor = xor32(proposal.vote_ids_xor, vote_id);
    proposal.vote_root = sha256(&[b"gov-root-v1", &proposal.vote_ids_xor]);

    if choice {
        proposal.yes_count += 1;
    } else {
        proposal.no_count += 1;
    }

    Ok(Vote {
        vote_id,
        voter_hash,
        choice,
        mainnet_ready: false,
    })
}

pub fn execute_proposal(proposal: &mut Proposal) -> Result<bool, GovError> {
    if proposal.executed {
        return Err(GovError::AlreadyExecuted);
    }
    proposal.executed = true;
    Ok(proposal.yes_count > proposal.no_count)
}

pub fn proposal_public_record(proposal: &Proposal) -> String {
    let obj = serde_json::json!({
        "proposal_id": hex_encode(proposal.proposal_id),
        "content_hash": hex_encode(proposal.content_hash),
        "yes_count": proposal.yes_count,
        "no_count": proposal.no_count,
        "executed": proposal.executed,
        "mainnet_ready": proposal.mainnet_ready,
    });
    serde_json::to_string(&obj).unwrap()
}

fn hex_encode(b: [u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secret() -> [u8; 32] {
        [1u8; 32]
    }
    fn nonce() -> [u8; 32] {
        [42u8; 32]
    }
    fn content() -> &'static [u8] {
        b"Increase fee by 5bps"
    }

    #[test]
    fn test_create_vote_execute_happy_path() {
        let mut p = create_proposal(&secret(), content(), &nonce()).unwrap();
        cast_vote(&mut p, &[2u8; 32], true).unwrap();
        cast_vote(&mut p, &[3u8; 32], true).unwrap();
        cast_vote(&mut p, &[4u8; 32], false).unwrap();
        assert_eq!(p.yes_count, 2);
        assert_eq!(p.no_count, 1);
        let result = execute_proposal(&mut p).unwrap();
        assert!(result); // yes > no
        assert!(p.executed);
        assert!(!p.mainnet_ready);
    }

    #[test]
    fn test_duplicate_voter_rejected() {
        let mut p = create_proposal(&secret(), content(), &nonce()).unwrap();
        cast_vote(&mut p, &[2u8; 32], true).unwrap();
        let err = cast_vote(&mut p, &[2u8; 32], false).unwrap_err();
        assert_eq!(err, GovError::DuplicateVoter);
    }

    #[test]
    fn test_zero_proposer_rejected() {
        let err = create_proposal(&[0u8; 32], content(), &nonce()).unwrap_err();
        assert_eq!(err, GovError::ZeroProposerSecret);
    }

    #[test]
    fn test_already_executed_rejected() {
        let mut p = create_proposal(&secret(), content(), &nonce()).unwrap();
        execute_proposal(&mut p).unwrap();
        let err = execute_proposal(&mut p).unwrap_err();
        assert_eq!(err, GovError::AlreadyExecuted);
    }

    #[test]
    fn test_proposal_id_deterministic() {
        let p1 = create_proposal(&secret(), content(), &nonce()).unwrap();
        let p2 = create_proposal(&secret(), content(), &nonce()).unwrap();
        assert_eq!(p1.proposal_id, p2.proposal_id);
        // Different nonce => different id
        let p3 = create_proposal(&secret(), content(), &[99u8; 32]).unwrap();
        assert_ne!(p1.proposal_id, p3.proposal_id);
    }

    #[test]
    fn test_public_record_hides_proposer_hash() {
        let p = create_proposal(&secret(), content(), &nonce()).unwrap();
        let record = proposal_public_record(&p);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v.get("proposer_hash").is_none());
        assert!(v.get("proposal_id").is_some());
        assert_eq!(v["mainnet_ready"], false);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_proposal_id_nonzero() {
        let p = create_proposal(&secret(), content(), &nonce()).unwrap();
        assert_ne!(p.proposal_id, [0u8; 32]);
    }

    #[test]
    fn test_proposer_hash_nonzero() {
        let p = create_proposal(&secret(), content(), &nonce()).unwrap();
        assert_ne!(p.proposer_hash, [0u8; 32]);
    }

    #[test]
    fn test_content_hash_nonzero() {
        let p = create_proposal(&secret(), content(), &nonce()).unwrap();
        assert_ne!(p.content_hash, [0u8; 32]);
    }

    #[test]
    fn test_empty_content_rejected() {
        let err = create_proposal(&secret(), b"", &nonce()).unwrap_err();
        assert_eq!(err, GovError::EmptyContent);
    }

    #[test]
    fn test_vote_id_nonzero() {
        let mut p = create_proposal(&secret(), content(), &nonce()).unwrap();
        let vote = cast_vote(&mut p, &[5u8; 32], true).unwrap();
        assert_ne!(vote.vote_id, [0u8; 32]);
    }

    #[test]
    fn test_vote_id_deterministic() {
        let mut p1 = create_proposal(&secret(), content(), &nonce()).unwrap();
        let mut p2 = create_proposal(&secret(), content(), &nonce()).unwrap();
        let voter = [5u8; 32];
        let v1 = cast_vote(&mut p1, &voter, true).unwrap();
        let v2 = cast_vote(&mut p2, &voter, true).unwrap();
        assert_eq!(v1.vote_id, v2.vote_id);
    }

    #[test]
    fn test_vote_mainnet_ready_false() {
        let mut p = create_proposal(&secret(), content(), &nonce()).unwrap();
        let vote = cast_vote(&mut p, &[5u8; 32], false).unwrap();
        assert!(!vote.mainnet_ready);
    }

    #[test]
    fn test_vote_root_changes_after_vote() {
        let mut p = create_proposal(&secret(), content(), &nonce()).unwrap();
        let root_before = p.vote_root;
        cast_vote(&mut p, &[5u8; 32], true).unwrap();
        assert_ne!(
            p.vote_root, root_before,
            "vote_root must change after a vote"
        );
    }

    #[test]
    fn test_starts_not_executed() {
        let p = create_proposal(&secret(), content(), &nonce()).unwrap();
        assert!(!p.executed);
    }

    #[test]
    fn test_executed_tie_returns_false() {
        // 0 yes, 0 no: yes_count > no_count is 0 > 0 = false
        let mut p = create_proposal(&secret(), content(), &nonce()).unwrap();
        let result = execute_proposal(&mut p).unwrap();
        assert!(!result, "tie (0 yes, 0 no) must return false");
    }
}
