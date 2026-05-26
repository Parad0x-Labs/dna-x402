use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VotingSession {
    pub session_id: [u8; 32],
    pub ballot_root: [u8; 32],
    pub yes_commitment: [u8; 32],
    pub no_commitment: [u8; 32],
    pub vote_count: u32,
    pub closed: bool,
    pub mainnet_ready: bool,
    // Internal: running XOR of ballot_ids for ballot_root computation
    #[serde(skip)]
    ballot_xor: [u8; 32],
    // Track voter_hashes for duplicate detection
    #[serde(skip)]
    pub voter_hashes: Vec<[u8; 32]>,
    // Internal yes/no counts for commitments
    yes_count: u32,
    no_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoteBallot {
    pub ballot_id: [u8; 32],
    pub vote_commitment: [u8; 32],
    pub nullifier: [u8; 32],
}

#[derive(Debug, PartialEq)]
pub enum VoteError {
    ZeroVoterSecret,
    AlreadyClosed,
    DuplicateVoter,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256_bytes(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

pub fn compute_admin_hash(admin_secret: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"svote-admin-v1");
    d.extend_from_slice(admin_secret);
    sha256_bytes(&d)
}

pub fn compute_session_id(admin_secret: &[u8; 32], nonce: &[u8; 32]) -> [u8; 32] {
    let admin_hash = compute_admin_hash(admin_secret);
    let mut d = Vec::new();
    d.extend_from_slice(b"svote-session-v1");
    d.extend_from_slice(&admin_hash);
    d.extend_from_slice(nonce);
    sha256_bytes(&d)
}

pub fn compute_voter_hash(voter_secret: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"svote-voter-v1");
    d.extend_from_slice(voter_secret);
    sha256_bytes(&d)
}

pub fn compute_vote_commitment(voter_hash: &[u8; 32], choice: u8, nonce: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"svote-commit-v1");
    d.extend_from_slice(voter_hash);
    d.push(choice);
    d.extend_from_slice(nonce);
    sha256_bytes(&d)
}

pub fn compute_ballot_nullifier(voter_hash: &[u8; 32], session_id: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"svote-null-v1");
    d.extend_from_slice(voter_hash);
    d.extend_from_slice(session_id);
    sha256_bytes(&d)
}

pub fn compute_ballot_id(vote_commitment: &[u8; 32], nullifier: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"svote-ballot-v1");
    d.extend_from_slice(vote_commitment);
    d.extend_from_slice(nullifier);
    sha256_bytes(&d)
}

pub fn compute_yes_commitment(count: u32) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"svote-yes-v1");
    d.extend_from_slice(&count.to_le_bytes());
    sha256_bytes(&d)
}

pub fn compute_no_commitment(count: u32) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"svote-no-v1");
    d.extend_from_slice(&count.to_le_bytes());
    sha256_bytes(&d)
}

pub fn compute_ballot_root(ballot_xor: &[u8; 32], vote_count: u32) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"svote-root-v1");
    d.extend_from_slice(ballot_xor);
    d.extend_from_slice(&vote_count.to_le_bytes());
    sha256_bytes(&d)
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn new_session(admin_secret: &[u8; 32], nonce: &[u8; 32]) -> VotingSession {
    let session_id = compute_session_id(admin_secret, nonce);
    let yes_commitment = compute_yes_commitment(0);
    let no_commitment = compute_no_commitment(0);
    let ballot_root = compute_ballot_root(&[0u8; 32], 0);
    VotingSession {
        session_id,
        ballot_root,
        yes_commitment,
        no_commitment,
        vote_count: 0,
        closed: false,
        mainnet_ready: false,
        ballot_xor: [0u8; 32],
        voter_hashes: Vec::new(),
        yes_count: 0,
        no_count: 0,
    }
}

pub fn cast_vote(
    session: &mut VotingSession,
    voter_secret: &[u8; 32],
    choice: bool,
    nonce: &[u8; 32],
) -> Result<VoteBallot, VoteError> {
    if voter_secret == &[0u8; 32] {
        return Err(VoteError::ZeroVoterSecret);
    }
    if session.closed {
        return Err(VoteError::AlreadyClosed);
    }
    let voter_hash = compute_voter_hash(voter_secret);
    if session.voter_hashes.contains(&voter_hash) {
        return Err(VoteError::DuplicateVoter);
    }
    let choice_u8 = if choice { 1u8 } else { 0u8 };
    let vote_commitment = compute_vote_commitment(&voter_hash, choice_u8, nonce);
    let nullifier = compute_ballot_nullifier(&voter_hash, &session.session_id);
    let ballot_id = compute_ballot_id(&vote_commitment, &nullifier);

    // Update running XOR
    for i in 0..32 {
        session.ballot_xor[i] ^= ballot_id[i];
    }
    session.vote_count += 1;
    session.ballot_root = compute_ballot_root(&session.ballot_xor, session.vote_count);
    session.voter_hashes.push(voter_hash);

    if choice {
        session.yes_count += 1;
    } else {
        session.no_count += 1;
    }
    session.yes_commitment = compute_yes_commitment(session.yes_count);
    session.no_commitment = compute_no_commitment(session.no_count);

    Ok(VoteBallot {
        ballot_id,
        vote_commitment,
        nullifier,
    })
}

pub fn close_session(session: &mut VotingSession) -> Result<(), VoteError> {
    if session.closed {
        return Err(VoteError::AlreadyClosed);
    }
    session.closed = true;
    Ok(())
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn admin() -> [u8; 32] {
        [0xaau8; 32]
    }
    fn nonce(b: u8) -> [u8; 32] {
        [b; 32]
    }
    fn voter(b: u8) -> [u8; 32] {
        [b; 32]
    }

    // Test 1: new_session + mainnet_ready=false
    #[test]
    fn test_new_session_mainnet_ready_false() {
        let session = new_session(&admin(), &nonce(0x01));
        assert!(!session.mainnet_ready);
        assert!(!session.closed);
        assert_eq!(session.vote_count, 0);

        let expected_id = compute_session_id(&admin(), &nonce(0x01));
        assert_eq!(session.session_id, expected_id);

        let expected_yes = compute_yes_commitment(0);
        let expected_no = compute_no_commitment(0);
        assert_eq!(session.yes_commitment, expected_yes);
        assert_eq!(session.no_commitment, expected_no);
    }

    // Test 2: cast_yes_vote updates yes_commitment
    #[test]
    fn test_cast_yes_vote_updates_yes_commitment() {
        let mut session = new_session(&admin(), &nonce(0x01));
        let yes_before = session.yes_commitment;
        cast_vote(&mut session, &voter(0xb1), true, &nonce(0x0a)).unwrap();
        assert_ne!(session.yes_commitment, yes_before);
        let expected = compute_yes_commitment(1);
        assert_eq!(session.yes_commitment, expected);
        // no_commitment stays the same (0 no votes)
        assert_eq!(session.no_commitment, compute_no_commitment(0));
    }

    // Test 3: cast_no_vote updates no_commitment
    #[test]
    fn test_cast_no_vote_updates_no_commitment() {
        let mut session = new_session(&admin(), &nonce(0x01));
        let no_before = session.no_commitment;
        cast_vote(&mut session, &voter(0xb2), false, &nonce(0x0b)).unwrap();
        assert_ne!(session.no_commitment, no_before);
        let expected = compute_no_commitment(1);
        assert_eq!(session.no_commitment, expected);
        // yes_commitment stays the same
        assert_eq!(session.yes_commitment, compute_yes_commitment(0));
    }

    // Test 4: duplicate_voter rejected
    #[test]
    fn test_duplicate_voter_rejected() {
        let mut session = new_session(&admin(), &nonce(0x01));
        cast_vote(&mut session, &voter(0xb1), true, &nonce(0x0a)).unwrap();
        let err = cast_vote(&mut session, &voter(0xb1), false, &nonce(0x0b)).unwrap_err();
        assert_eq!(err, VoteError::DuplicateVoter);
    }

    // Test 5: close_session sets flag
    #[test]
    fn test_close_session_sets_flag() {
        let mut session = new_session(&admin(), &nonce(0x01));
        assert!(!session.closed);
        close_session(&mut session).unwrap();
        assert!(session.closed);
        // Double close rejected
        let err = close_session(&mut session).unwrap_err();
        assert_eq!(err, VoteError::AlreadyClosed);
    }

    // Test 6: ballot_root changes after vote
    #[test]
    fn test_ballot_root_changes_after_vote() {
        let mut session = new_session(&admin(), &nonce(0x01));
        let root_before = session.ballot_root;
        cast_vote(&mut session, &voter(0xb1), true, &nonce(0x0a)).unwrap();
        assert_ne!(session.ballot_root, root_before);
        assert_ne!(session.ballot_root, [0u8; 32]);
    }
}
