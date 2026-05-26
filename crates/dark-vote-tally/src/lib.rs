use sha2::{Digest, Sha256};
use std::collections::HashSet;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum VoteChoice {
    Yes = 1,
    No = 2,
    Abstain = 3,
}

impl VoteChoice {
    pub fn as_u8(self) -> u8 {
        self as u8
    }
}

/// A committed (blinded) ballot.  Individual vote is hidden until reveal.
#[derive(Debug, Clone)]
pub struct VoteBallot {
    /// SHA256("ballot-v1" || voter_hash || choice_byte || proposal_id_le || nonce)
    pub ballot_commitment: [u8; 32],
    /// SHA256("voter-hash-v1" || voter_secret)
    pub voter_hash: [u8; 32],
    pub proposal_id: u64,
    pub mainnet_ready: bool,
}

/// A ballot after the voter has opened their commitment.
#[derive(Debug, Clone)]
pub struct RevealedBallot {
    pub ballot_commitment: [u8; 32],
    pub choice: VoteChoice,
    pub voter_hash: [u8; 32],
    pub mainnet_ready: bool,
}

/// Aggregated tally for one proposal.
#[derive(Debug, Clone)]
pub struct TallyResult {
    pub proposal_id: u64,
    pub yes_count: u32,
    pub no_count: u32,
    pub abstain_count: u32,
    pub total_votes: u32,
    /// SHA256("tally-v1" || proposal_id_le || yes_le || no_le || abstain_le)
    pub tally_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum TallyError {
    VoterSecretZero,
    EmptyBallotSet,
    CommitmentMismatch,
    DuplicateVoter,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn hash_voter(voter_secret: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"voter-hash-v1");
    h.update(voter_secret);
    h.finalize().into()
}

fn hash_ballot(
    voter_hash: &[u8; 32],
    choice: &VoteChoice,
    proposal_id: u64,
    nonce: &[u8; 32],
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"ballot-v1");
    h.update(voter_hash);
    h.update([choice.clone().as_u8()]);
    h.update(proposal_id.to_le_bytes());
    h.update(nonce);
    h.finalize().into()
}

fn hash_tally(proposal_id: u64, yes: u32, no: u32, abstain: u32) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"tally-v1");
    h.update(proposal_id.to_le_bytes());
    h.update(yes.to_le_bytes());
    h.update(no.to_le_bytes());
    h.update(abstain.to_le_bytes());
    h.finalize().into()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Commit a vote.  Returns an opaque `VoteBallot`; the choice is hidden.
///
/// Errors:
/// - `VoterSecretZero` — voter_secret is all zero bytes (invalid identity).
pub fn cast_ballot(
    voter_secret: &[u8; 32],
    choice: VoteChoice,
    proposal_id: u64,
    nonce: &[u8; 32],
) -> Result<VoteBallot, TallyError> {
    if voter_secret == &[0u8; 32] {
        return Err(TallyError::VoterSecretZero);
    }

    let voter_hash = hash_voter(voter_secret);
    let ballot_commitment = hash_ballot(&voter_hash, &choice, proposal_id, nonce);

    Ok(VoteBallot {
        ballot_commitment,
        voter_hash,
        proposal_id,
        mainnet_ready: false,
    })
}

/// Open a committed ballot by re-deriving the commitment and verifying it.
///
/// Errors:
/// - `CommitmentMismatch` — supplied secret / choice / nonce do not match the
///   original commitment stored in `ballot`.
pub fn reveal_ballot(
    ballot: &VoteBallot,
    voter_secret: &[u8; 32],
    choice: VoteChoice,
    nonce: &[u8; 32],
) -> Result<RevealedBallot, TallyError> {
    let voter_hash = hash_voter(voter_secret);
    let recomputed = hash_ballot(&voter_hash, &choice, ballot.proposal_id, nonce);

    if recomputed != ballot.ballot_commitment {
        return Err(TallyError::CommitmentMismatch);
    }

    Ok(RevealedBallot {
        ballot_commitment: ballot.ballot_commitment,
        choice,
        voter_hash,
        mainnet_ready: false,
    })
}

/// Tally a slice of revealed ballots for `proposal_id`.
///
/// Errors:
/// - `EmptyBallotSet`   — slice is empty.
/// - `DuplicateVoter`   — same voter_hash appears more than once.
pub fn tally_votes(
    revealed: &[RevealedBallot],
    proposal_id: u64,
) -> Result<TallyResult, TallyError> {
    if revealed.is_empty() {
        return Err(TallyError::EmptyBallotSet);
    }

    let mut seen: HashSet<[u8; 32]> = HashSet::new();
    let mut yes_count: u32 = 0;
    let mut no_count: u32 = 0;
    let mut abstain_count: u32 = 0;

    for rb in revealed {
        if !seen.insert(rb.voter_hash) {
            return Err(TallyError::DuplicateVoter);
        }
        match rb.choice {
            VoteChoice::Yes => yes_count += 1,
            VoteChoice::No => no_count += 1,
            VoteChoice::Abstain => abstain_count += 1,
        }
    }

    let total_votes = yes_count + no_count + abstain_count;
    let tally_hash = hash_tally(proposal_id, yes_count, no_count, abstain_count);

    Ok(TallyResult {
        proposal_id,
        yes_count,
        no_count,
        abstain_count,
        total_votes,
        tally_hash,
        mainnet_ready: false,
    })
}

/// Produce a JSON public record for `tally`.  Contains aggregate counts and
/// the tally hash, but **no** individual voter information.
pub fn tally_public_record(tally: &TallyResult) -> String {
    let tally_hash_hex: String = tally.tally_hash.iter().map(|b| format!("{b:02x}")).collect();

    serde_json::json!({
        "proposal_id": tally.proposal_id,
        "yes_count": tally.yes_count,
        "no_count": tally.no_count,
        "abstain_count": tally.abstain_count,
        "total_votes": tally.total_votes,
        "tally_hash": tally_hash_hex,
        "mainnet_ready": tally.mainnet_ready,
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn voter_secret(seed: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = seed;
        s
    }

    fn nonce(seed: u8) -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = seed;
        n
    }

    // 1. Happy path: 3 voters, 2 yes 1 no
    #[test]
    fn test_cast_reveal_tally_happy_path() {
        let pid = 42u64;

        let ballot_a = cast_ballot(&voter_secret(1), VoteChoice::Yes, pid, &nonce(10)).unwrap();
        let ballot_b = cast_ballot(&voter_secret(2), VoteChoice::Yes, pid, &nonce(20)).unwrap();
        let ballot_c = cast_ballot(&voter_secret(3), VoteChoice::No, pid, &nonce(30)).unwrap();

        let rev_a = reveal_ballot(&ballot_a, &voter_secret(1), VoteChoice::Yes, &nonce(10)).unwrap();
        let rev_b = reveal_ballot(&ballot_b, &voter_secret(2), VoteChoice::Yes, &nonce(20)).unwrap();
        let rev_c = reveal_ballot(&ballot_c, &voter_secret(3), VoteChoice::No, &nonce(30)).unwrap();

        let tally = tally_votes(&[rev_a, rev_b, rev_c], pid).unwrap();

        assert_eq!(tally.yes_count, 2);
        assert_eq!(tally.no_count, 1);
        assert_eq!(tally.abstain_count, 0);
        assert_eq!(tally.total_votes, 3);
        assert_eq!(tally.proposal_id, pid);
        assert!(!tally.mainnet_ready);
    }

    // 2. Wrong nonce causes CommitmentMismatch
    #[test]
    fn test_wrong_nonce_fails_reveal() {
        let pid = 7u64;
        let ballot = cast_ballot(&voter_secret(5), VoteChoice::Abstain, pid, &nonce(99)).unwrap();

        let err = reveal_ballot(&ballot, &voter_secret(5), VoteChoice::Abstain, &nonce(1))
            .unwrap_err();
        assert_eq!(err, TallyError::CommitmentMismatch);
    }

    // 3. Duplicate voter rejected
    #[test]
    fn test_duplicate_voter_rejected() {
        let pid = 1u64;
        let ballot = cast_ballot(&voter_secret(7), VoteChoice::Yes, pid, &nonce(1)).unwrap();
        let rev = reveal_ballot(&ballot, &voter_secret(7), VoteChoice::Yes, &nonce(1)).unwrap();

        // same voter_hash twice
        let err = tally_votes(&[rev.clone(), rev], pid).unwrap_err();
        assert_eq!(err, TallyError::DuplicateVoter);
    }

    // 4. Tally hash is deterministic
    #[test]
    fn test_tally_hash_deterministic() {
        let pid = 100u64;

        let make_tally = || {
            let b1 = cast_ballot(&voter_secret(11), VoteChoice::Yes, pid, &nonce(11)).unwrap();
            let b2 = cast_ballot(&voter_secret(12), VoteChoice::No, pid, &nonce(12)).unwrap();
            let r1 = reveal_ballot(&b1, &voter_secret(11), VoteChoice::Yes, &nonce(11)).unwrap();
            let r2 = reveal_ballot(&b2, &voter_secret(12), VoteChoice::No, &nonce(12)).unwrap();
            tally_votes(&[r1, r2], pid).unwrap()
        };

        let t1 = make_tally();
        let t2 = make_tally();
        assert_eq!(t1.tally_hash, t2.tally_hash);
    }

    // 5. All-zero voter secret rejected
    #[test]
    fn test_zero_voter_secret_rejected() {
        let err = cast_ballot(&[0u8; 32], VoteChoice::Yes, 1, &nonce(1)).unwrap_err();
        assert_eq!(err, TallyError::VoterSecretZero);
    }

    // 6. tally_public_record does not contain any voter_hash hex
    #[test]
    fn test_public_record_hides_voters() {
        let pid = 55u64;
        let ballot = cast_ballot(&voter_secret(22), VoteChoice::Yes, pid, &nonce(22)).unwrap();
        let rev = reveal_ballot(&ballot, &voter_secret(22), VoteChoice::Yes, &nonce(22)).unwrap();

        let voter_hash_hex: String = rev.voter_hash.iter().map(|b| format!("{b:02x}")).collect();

        let tally = tally_votes(&[rev], pid).unwrap();
        let record = tally_public_record(&tally);

        // Record must not contain the voter's identity hash
        assert!(
            !record.contains(&voter_hash_hex),
            "public record must not expose voter_hash"
        );

        // Sanity: record does contain expected fields
        assert!(record.contains("proposal_id"));
        assert!(record.contains("tally_hash"));
        assert!(record.contains("mainnet_ready"));
    }
}
