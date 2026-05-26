use sha2::{Digest, Sha256};
use serde::Serialize;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum VoteChoice {
    Yes = 1,
    No = 2,
    Abstain = 3,
}

pub struct VoteCommitment {
    /// SHA256("vote-commit-v1" || choice_byte || nonce || proposal_id_le)
    pub commitment_hash: [u8; 32],
    pub proposal_id: u64,
    pub committed_at_slot: u64,
    /// Always false — not mainnet-ready.
    pub mainnet_ready: bool,
}

#[derive(Debug)]
pub struct RevealedVote {
    pub commitment_hash: [u8; 32],
    pub choice: VoteChoice,
    pub revealed_at_slot: u64,
}

pub struct VoteTally {
    pub proposal_id: u64,
    pub yes_count: u32,
    pub no_count: u32,
    pub abstain_count: u32,
    pub reveal_slot_open: u64,
    /// SHA256("tally-v1" || proposal_le || yes_le || no_le || abstain_le)
    pub tally_hash: [u8; 32],
    /// Always false — not mainnet-ready.
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum VoteError {
    RevealBeforeWindow { open_at: u64, current: u64 },
    CommitmentMismatch,
    InvalidProposal,
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/// Commit to a vote before the reveal window opens.
///
/// `commitment_hash` = SHA256("vote-commit-v1" || choice as u8 || nonce || proposal_id_le)
pub fn commit_vote(
    choice: VoteChoice,
    nonce: &[u8; 32],
    proposal_id: u64,
    committed_at_slot: u64,
) -> VoteCommitment {
    let commitment_hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"vote-commit-v1");
        h.update([choice as u8]);
        h.update(nonce);
        h.update(proposal_id.to_le_bytes());
        h.finalize().into()
    };

    VoteCommitment {
        commitment_hash,
        proposal_id,
        committed_at_slot,
        mainnet_ready: false,
    }
}

/// Reveal a previously committed vote and obtain a `RevealedVote`.
///
/// Errors:
/// - `RevealBeforeWindow` if `current_slot < reveal_slot_open`
/// - `CommitmentMismatch`  if the recomputed hash does not match `commitment.commitment_hash`
pub fn reveal_vote(
    commitment: &VoteCommitment,
    choice: VoteChoice,
    nonce: &[u8; 32],
    current_slot: u64,
    reveal_slot_open: u64,
) -> Result<RevealedVote, VoteError> {
    if current_slot < reveal_slot_open {
        return Err(VoteError::RevealBeforeWindow {
            open_at: reveal_slot_open,
            current: current_slot,
        });
    }

    // Recompute the commitment hash with the claimed choice + nonce
    let recomputed: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"vote-commit-v1");
        h.update([choice as u8]);
        h.update(nonce);
        h.update(commitment.proposal_id.to_le_bytes());
        h.finalize().into()
    };

    if recomputed != commitment.commitment_hash {
        return Err(VoteError::CommitmentMismatch);
    }

    Ok(RevealedVote {
        commitment_hash: commitment.commitment_hash,
        choice,
        revealed_at_slot: current_slot,
    })
}

/// Tally a slice of revealed votes.
///
/// `tally_hash` = SHA256("tally-v1" || proposal_le || yes_le || no_le || abstain_le)
pub fn tally_votes(
    proposal_id: u64,
    votes: &[RevealedVote],
    reveal_slot_open: u64,
) -> VoteTally {
    let mut yes_count: u32 = 0;
    let mut no_count: u32 = 0;
    let mut abstain_count: u32 = 0;

    for vote in votes {
        match vote.choice {
            VoteChoice::Yes => yes_count += 1,
            VoteChoice::No => no_count += 1,
            VoteChoice::Abstain => abstain_count += 1,
        }
    }

    let tally_hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"tally-v1");
        h.update(proposal_id.to_le_bytes());
        h.update(yes_count.to_le_bytes());
        h.update(no_count.to_le_bytes());
        h.update(abstain_count.to_le_bytes());
        h.finalize().into()
    };

    VoteTally {
        proposal_id,
        yes_count,
        no_count,
        abstain_count,
        reveal_slot_open,
        tally_hash,
        mainnet_ready: false,
    }
}

// ---------------------------------------------------------------------------
// Public record (privacy-preserving serialisation)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct TallyRecord {
    proposal_id: u64,
    yes_count: u32,
    no_count: u32,
    abstain_count: u32,
    tally_hash: String,
    mainnet_ready: bool,
}

/// Produce a JSON record of the tally that omits individual voter data.
///
/// Fields: `proposal_id`, `yes_count`, `no_count`, `abstain_count`,
/// `tally_hash` (hex), `mainnet_ready`.
///
/// Deliberately absent: voter `commitment_hash` values.
pub fn tally_public_record(tally: &VoteTally) -> String {
    let record = TallyRecord {
        proposal_id: tally.proposal_id,
        yes_count: tally.yes_count,
        no_count: tally.no_count,
        abstain_count: tally.abstain_count,
        tally_hash: hex_encode(&tally.tally_hash),
        mainnet_ready: tally.mainnet_ready,
    };
    serde_json::to_string(&record).expect("serialisation is infallible")
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const PROPOSAL: u64 = 42;
    const NONCE_YES: [u8; 32] = [0x11; 32];
    const NONCE_NO: [u8; 32] = [0x22; 32];
    const NONCE_ABS: [u8; 32] = [0x33; 32];
    const COMMIT_SLOT: u64 = 100;
    const REVEAL_OPEN: u64 = 200;
    const REVEAL_SLOT: u64 = 250;

    // Test 1: commit Yes, reveal at valid slot → Ok, choice == Yes
    #[test]
    fn test_commit_reveal_vote_happy_path() {
        let commitment = commit_vote(VoteChoice::Yes, &NONCE_YES, PROPOSAL, COMMIT_SLOT);
        assert!(!commitment.mainnet_ready);

        let revealed = reveal_vote(&commitment, VoteChoice::Yes, &NONCE_YES, REVEAL_SLOT, REVEAL_OPEN);
        assert!(revealed.is_ok());
        let rv = revealed.unwrap();
        assert_eq!(rv.choice, VoteChoice::Yes);
        assert_eq!(rv.commitment_hash, commitment.commitment_hash);
        assert_eq!(rv.revealed_at_slot, REVEAL_SLOT);
    }

    // Test 2: reveal at slot < reveal_slot_open → RevealBeforeWindow
    #[test]
    fn test_reveal_before_window() {
        let commitment = commit_vote(VoteChoice::Yes, &NONCE_YES, PROPOSAL, COMMIT_SLOT);
        let result = reveal_vote(&commitment, VoteChoice::Yes, &NONCE_YES, 150, REVEAL_OPEN);
        assert_eq!(
            result.unwrap_err(),
            VoteError::RevealBeforeWindow { open_at: REVEAL_OPEN, current: 150 }
        );
    }

    // Test 3: reveal with wrong choice (No instead of Yes) → CommitmentMismatch
    #[test]
    fn test_wrong_choice_fails() {
        let commitment = commit_vote(VoteChoice::Yes, &NONCE_YES, PROPOSAL, COMMIT_SLOT);
        let result = reveal_vote(&commitment, VoteChoice::No, &NONCE_YES, REVEAL_SLOT, REVEAL_OPEN);
        assert_eq!(result.unwrap_err(), VoteError::CommitmentMismatch);
    }

    // Test 4: 3 yes, 2 no, 1 abstain → tally counts correct
    #[test]
    fn test_tally_counts_correct() {
        let votes = build_votes();
        let tally = tally_votes(PROPOSAL, &votes, REVEAL_OPEN);
        assert_eq!(tally.yes_count, 3);
        assert_eq!(tally.no_count, 2);
        assert_eq!(tally.abstain_count, 1);
        assert!(!tally.mainnet_ready);
    }

    // Test 5: same votes → same tally_hash (deterministic)
    #[test]
    fn test_tally_hash_deterministic() {
        let votes_a = build_votes();
        let votes_b = build_votes();
        let tally_a = tally_votes(PROPOSAL, &votes_a, REVEAL_OPEN);
        let tally_b = tally_votes(PROPOSAL, &votes_b, REVEAL_OPEN);
        assert_eq!(tally_a.tally_hash, tally_b.tally_hash);
    }

    // Test 6: tally_public_record contains aggregate counts but no voter commitments
    #[test]
    fn test_tally_hides_individual_votes() {
        let votes = build_votes();
        let tally = tally_votes(PROPOSAL, &votes, REVEAL_OPEN);
        let json = tally_public_record(&tally);

        // Must contain aggregate public fields
        assert!(json.contains("yes_count"));
        assert!(json.contains("no_count"));
        assert!(json.contains("abstain_count"));
        assert!(json.contains("tally_hash"));

        // Must NOT expose individual voter commitment hashes.
        // Each commitment hash would be 64 hex chars; the tally_hash is the
        // only 64-char hex string present, and it corresponds to the aggregate.
        // We verify no per-voter commitment_hash key appears.
        assert!(!json.contains("commitment_hash"));

        // Sanity: counts are correct in the serialised output
        assert!(json.contains("\"yes_count\":3"));
        assert!(json.contains("\"no_count\":2"));
        assert!(json.contains("\"abstain_count\":1"));
    }

    // ---------------------------------------------------------------------------
    // Helper: build a canonical 6-vote slice (3 Yes, 2 No, 1 Abstain)
    // ---------------------------------------------------------------------------
    fn build_votes() -> Vec<RevealedVote> {
        let nonces: Vec<[u8; 32]> = (0u8..6).map(|i| [i + 0x10; 32]).collect();
        let choices = [
            VoteChoice::Yes,
            VoteChoice::Yes,
            VoteChoice::Yes,
            VoteChoice::No,
            VoteChoice::No,
            VoteChoice::Abstain,
        ];
        choices
            .iter()
            .enumerate()
            .map(|(i, &choice)| {
                let commitment = commit_vote(choice, &nonces[i], PROPOSAL, COMMIT_SLOT);
                reveal_vote(&commitment, choice, &nonces[i], REVEAL_SLOT, REVEAL_OPEN)
                    .expect("reveal must succeed in test setup")
            })
            .collect()
    }
}
