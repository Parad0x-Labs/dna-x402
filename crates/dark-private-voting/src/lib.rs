use serde::Serialize;
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Domain-separation constants
// ---------------------------------------------------------------------------

const DOMAIN_VOTE: u8 = 0x70;
const DOMAIN_COMMIT: u8 = 0x71;
const DOMAIN_REVEAL: u8 = 0x72;
const DOMAIN_TALLY: u8 = 0x73;
const DOMAIN_NULLIFIER: u8 = 0x74;

// Keep DOMAIN_VOTE in scope so it does not warn.
#[allow(dead_code)]
const _USED: u8 = DOMAIN_VOTE;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum VoteChoice {
    Yes,
    No,
    Abstain,
}

impl VoteChoice {
    pub fn to_byte(&self) -> u8 {
        match self {
            VoteChoice::Yes => 1,
            VoteChoice::No => 2,
            VoteChoice::Abstain => 3,
        }
    }
}

#[derive(Debug)]
pub struct VoteCommitment {
    /// SHA256(DOMAIN_COMMIT || voter_id_hash || choice_byte || nonce)
    pub vote_commit: [u8; 32],
    /// SHA256(DOMAIN_NULLIFIER || voter_id_hash || poll_id)
    pub voter_nullifier: [u8; 32],
    pub poll_id: [u8; 32],
    pub reveal_after_slot: u64,
    /// Always false — not mainnet-ready.
    pub mainnet_ready: bool,
    /// SHA256(DOMAIN_COMMIT || choice_byte || nonce) lets reveal_vote verify
    /// (choice, nonce) without knowing voter_id_hash.
    inner_check: [u8; 32],
}

#[derive(Debug)]
pub struct VoteReveal {
    pub vote_commit: [u8; 32],
    pub choice: VoteChoice,
    /// SHA256(DOMAIN_REVEAL || vote_commit || choice_byte || nonce)
    pub reveal_proof: [u8; 32],
    /// Always false — not mainnet-ready.
    pub mainnet_ready: bool,
    /// SHA256(DOMAIN_REVEAL || vote_commit || choice_byte || inner_check)
    /// lets verify_reveal confirm consistency without publicly storing nonce.
    reveal_root: [u8; 32],
}

#[derive(Debug)]
pub struct VoteTally {
    pub poll_id: [u8; 32],
    pub yes_count: u32,
    pub no_count: u32,
    pub abstain_count: u32,
    /// Commitment to the aggregate result — never to individual choices.
    pub tally_root: [u8; 32],
    /// Always false — not mainnet-ready.
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum VoteError {
    EmptyPollId,
    TooEarlyToReveal { current: u64, required: u64 },
    CommitMismatch,
    NullifierConflict,
    EmptyRevealList,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Commit to a ballot choice.  Pure function; never fails.
///
/// vote_commit     = SHA256(DOMAIN_COMMIT    || voter_id_hash || choice_byte || nonce)
/// voter_nullifier = SHA256(DOMAIN_NULLIFIER || voter_id_hash || poll_id)
pub fn commit_vote(
    voter_id_hash: &[u8; 32],
    choice: &VoteChoice,
    nonce: &[u8; 32],
    poll_id: &[u8; 32],
    reveal_after_slot: u64,
) -> VoteCommitment {
    let cb = choice.to_byte();
    let vote_commit = sha256(&[
        &[DOMAIN_COMMIT],
        voter_id_hash.as_ref(),
        &[cb],
        nonce.as_ref(),
    ]);
    let voter_nullifier = sha256(&[
        &[DOMAIN_NULLIFIER],
        voter_id_hash.as_ref(),
        poll_id.as_ref(),
    ]);
    let inner_check = sha256(&[&[DOMAIN_COMMIT], &[cb], nonce.as_ref()]);
    VoteCommitment {
        vote_commit,
        voter_nullifier,
        poll_id: *poll_id,
        reveal_after_slot,
        mainnet_ready: false,
        inner_check,
    }
}

/// Reveal a previously committed ballot.
///
/// Errors:
///   TooEarlyToReveal — current_slot < reveal_after_slot
///   CommitMismatch   — (choice, nonce) do not match the commitment
///
/// reveal_proof = SHA256(DOMAIN_REVEAL || vote_commit || choice_byte || nonce)
pub fn reveal_vote(
    commitment: &VoteCommitment,
    choice: &VoteChoice,
    nonce: &[u8; 32],
    current_slot: u64,
) -> Result<VoteReveal, VoteError> {
    if current_slot < commitment.reveal_after_slot {
        return Err(VoteError::TooEarlyToReveal {
            current: current_slot,
            required: commitment.reveal_after_slot,
        });
    }
    let cb = choice.to_byte();
    // Verify (choice, nonce) via inner_check stored in the commitment.
    if sha256(&[&[DOMAIN_COMMIT], &[cb], nonce.as_ref()]) != commitment.inner_check {
        return Err(VoteError::CommitMismatch);
    }
    let reveal_proof = sha256(&[
        &[DOMAIN_REVEAL],
        commitment.vote_commit.as_ref(),
        &[cb],
        nonce.as_ref(),
    ]);
    let reveal_root = sha256(&[
        &[DOMAIN_REVEAL],
        commitment.vote_commit.as_ref(),
        &[cb],
        commitment.inner_check.as_ref(),
    ]);
    Ok(VoteReveal {
        vote_commit: commitment.vote_commit,
        choice: *choice,
        reveal_proof,
        mainnet_ready: false,
        reveal_root,
    })
}

/// Verify that reveal is structurally consistent with its commitment.
pub fn verify_reveal(commitment: &VoteCommitment, reveal: &VoteReveal) -> bool {
    if reveal.vote_commit != commitment.vote_commit {
        return false;
    }
    let cb = reveal.choice.to_byte();
    let expected = sha256(&[
        &[DOMAIN_REVEAL],
        commitment.vote_commit.as_ref(),
        &[cb],
        commitment.inner_check.as_ref(),
    ]);
    reveal.reveal_root == expected
}

/// Tally all valid reveals in a poll.
///
/// Errors:
///   EmptyPollId       — poll_id is all-zero
///   EmptyRevealList   — reveals slice is empty
///   NullifierConflict — two commitments share a voter_nullifier
///
/// tally_seed = XOR-fold of sorted(vote_commits)
/// tally_root = SHA256(DOMAIN_TALLY || tally_seed || yes_count_le4 || no_count_le4)
pub fn tally_votes(
    poll_id: &[u8; 32],
    reveals: &[VoteReveal],
    commitments: &[VoteCommitment],
) -> Result<VoteTally, VoteError> {
    if *poll_id == [0u8; 32] {
        return Err(VoteError::EmptyPollId);
    }
    if reveals.is_empty() {
        return Err(VoteError::EmptyRevealList);
    }

    let mut seen: Vec<[u8; 32]> = Vec::with_capacity(commitments.len());
    for c in commitments {
        if seen.contains(&c.voter_nullifier) {
            return Err(VoteError::NullifierConflict);
        }
        seen.push(c.voter_nullifier);
    }

    let (mut yes, mut no, mut abs) = (0u32, 0u32, 0u32);
    for r in reveals {
        match r.choice {
            VoteChoice::Yes => yes += 1,
            VoteChoice::No => no += 1,
            VoteChoice::Abstain => abs += 1,
        }
    }

    let mut vc_sorted: Vec<[u8; 32]> = reveals.iter().map(|r| r.vote_commit).collect();
    vc_sorted.sort_unstable();
    let mut seed = [0u8; 32];
    for vc in &vc_sorted {
        for (i, b) in vc.iter().enumerate() {
            seed[i] ^= b;
        }
    }

    let tally_root = sha256(&[
        &[DOMAIN_TALLY],
        seed.as_ref(),
        &yes.to_le_bytes(),
        &no.to_le_bytes(),
    ]);
    Ok(VoteTally {
        poll_id: *poll_id,
        yes_count: yes,
        no_count: no,
        abstain_count: abs,
        tally_root,
        mainnet_ready: false,
    })
}

/// Serialize a VoteTally to JSON.
///
/// Output: poll_id, yes_count, no_count, abstain_count, tally_root (hex),
/// mainnet_ready.  Voter IDs, individual choices, and nonces are never present.
pub fn tally_to_json(tally: &VoteTally) -> String {
    #[derive(Serialize)]
    struct Out {
        poll_id: String,
        yes_count: u32,
        no_count: u32,
        abstain_count: u32,
        tally_root: String,
        mainnet_ready: bool,
    }
    serde_json::to_string(&Out {
        poll_id: hex_encode(&tally.poll_id),
        yes_count: tally.yes_count,
        no_count: tally.no_count,
        abstain_count: tally.abstain_count,
        tally_root: hex_encode(&tally.tally_root),
        mainnet_ready: tally.mainnet_ready,
    })
    .expect("infallible")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn voter_a() -> [u8; 32] {
        let mut v = [0u8; 32];
        v[0] = 0xAA;
        v[1] = 0x01;
        v
    }
    fn voter_b() -> [u8; 32] {
        let mut v = [0u8; 32];
        v[0] = 0xBB;
        v[1] = 0x02;
        v
    }
    fn voter_c() -> [u8; 32] {
        let mut v = [0u8; 32];
        v[0] = 0xCC;
        v[1] = 0x03;
        v
    }
    fn nonce_a() -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = 0x11;
        n
    }
    fn nonce_b() -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = 0x22;
        n
    }
    fn nonce_c() -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = 0x33;
        n
    }
    fn poll() -> [u8; 32] {
        let mut p = [0u8; 32];
        p[0] = 0x50;
        p[1] = 0x01;
        p
    }

    const REVEAL_SLOT: u64 = 500;
    const NOW: u64 = 600;

    fn build_votes(choices: &[VoteChoice; 3]) -> (Vec<VoteCommitment>, Vec<VoteReveal>) {
        let voters = [voter_a(), voter_b(), voter_c()];
        let nonces = [nonce_a(), nonce_b(), nonce_c()];
        let mut coms = Vec::new();
        let mut revs = Vec::new();
        for i in 0..3 {
            let c = commit_vote(&voters[i], &choices[i], &nonces[i], &poll(), REVEAL_SLOT);
            let r = reveal_vote(&c, &choices[i], &nonces[i], NOW).unwrap();
            coms.push(c);
            revs.push(r);
        }
        (coms, revs)
    }

    #[test]
    fn test_commit_mainnet_ready_false() {
        assert!(
            !commit_vote(
                &voter_a(),
                &VoteChoice::Yes,
                &nonce_a(),
                &poll(),
                REVEAL_SLOT
            )
            .mainnet_ready
        );
    }

    #[test]
    fn test_commit_deterministic_same_inputs() {
        let c1 = commit_vote(
            &voter_a(),
            &VoteChoice::Yes,
            &nonce_a(),
            &poll(),
            REVEAL_SLOT,
        );
        let c2 = commit_vote(
            &voter_a(),
            &VoteChoice::Yes,
            &nonce_a(),
            &poll(),
            REVEAL_SLOT,
        );
        assert_eq!(c1.vote_commit, c2.vote_commit);
        assert_eq!(c1.voter_nullifier, c2.voter_nullifier);
    }

    #[test]
    fn test_different_choice_different_commit() {
        let cy = commit_vote(
            &voter_a(),
            &VoteChoice::Yes,
            &nonce_a(),
            &poll(),
            REVEAL_SLOT,
        );
        let cn = commit_vote(
            &voter_a(),
            &VoteChoice::No,
            &nonce_a(),
            &poll(),
            REVEAL_SLOT,
        );
        assert_ne!(cy.vote_commit, cn.vote_commit);
    }

    #[test]
    fn test_different_nonce_different_commit() {
        let c1 = commit_vote(
            &voter_a(),
            &VoteChoice::Yes,
            &nonce_a(),
            &poll(),
            REVEAL_SLOT,
        );
        let c2 = commit_vote(
            &voter_a(),
            &VoteChoice::Yes,
            &nonce_b(),
            &poll(),
            REVEAL_SLOT,
        );
        assert_ne!(c1.vote_commit, c2.vote_commit);
    }

    #[test]
    fn test_reveal_vote_success() {
        let c = commit_vote(
            &voter_a(),
            &VoteChoice::Yes,
            &nonce_a(),
            &poll(),
            REVEAL_SLOT,
        );
        let r = reveal_vote(&c, &VoteChoice::Yes, &nonce_a(), NOW).unwrap();
        assert_eq!(r.choice, VoteChoice::Yes);
        assert_eq!(r.vote_commit, c.vote_commit);
        assert!(!r.mainnet_ready);
    }

    #[test]
    fn test_reveal_too_early_fails() {
        let c = commit_vote(
            &voter_a(),
            &VoteChoice::Yes,
            &nonce_a(),
            &poll(),
            REVEAL_SLOT,
        );
        assert_eq!(
            reveal_vote(&c, &VoteChoice::Yes, &nonce_a(), REVEAL_SLOT - 1).unwrap_err(),
            VoteError::TooEarlyToReveal {
                current: REVEAL_SLOT - 1,
                required: REVEAL_SLOT
            }
        );
    }

    #[test]
    fn test_reveal_wrong_nonce_fails() {
        let c = commit_vote(
            &voter_a(),
            &VoteChoice::Yes,
            &nonce_a(),
            &poll(),
            REVEAL_SLOT,
        );
        assert_eq!(
            reveal_vote(&c, &VoteChoice::Yes, &nonce_b(), NOW).unwrap_err(),
            VoteError::CommitMismatch
        );
    }

    #[test]
    fn test_reveal_wrong_choice_fails() {
        let c = commit_vote(
            &voter_a(),
            &VoteChoice::Yes,
            &nonce_a(),
            &poll(),
            REVEAL_SLOT,
        );
        assert_eq!(
            reveal_vote(&c, &VoteChoice::No, &nonce_a(), NOW).unwrap_err(),
            VoteError::CommitMismatch
        );
    }

    #[test]
    fn test_verify_reveal_valid() {
        let c = commit_vote(
            &voter_a(),
            &VoteChoice::Yes,
            &nonce_a(),
            &poll(),
            REVEAL_SLOT,
        );
        let r = reveal_vote(&c, &VoteChoice::Yes, &nonce_a(), NOW).unwrap();
        assert!(verify_reveal(&c, &r));
    }

    #[test]
    fn test_verify_reveal_tampered_choice_fails() {
        let c = commit_vote(
            &voter_a(),
            &VoteChoice::Yes,
            &nonce_a(),
            &poll(),
            REVEAL_SLOT,
        );
        let mut r = reveal_vote(&c, &VoteChoice::Yes, &nonce_a(), NOW).unwrap();
        r.choice = VoteChoice::No;
        assert!(!verify_reveal(&c, &r));
    }

    #[test]
    fn test_tally_three_voters() {
        let (coms, revs) = build_votes(&[VoteChoice::Yes, VoteChoice::No, VoteChoice::Abstain]);
        let t = tally_votes(&poll(), &revs, &coms).unwrap();
        assert_eq!((t.yes_count, t.no_count, t.abstain_count), (1, 1, 1));
        assert!(!t.mainnet_ready);
    }

    #[test]
    fn test_tally_unanimous_yes() {
        let (coms, revs) = build_votes(&[VoteChoice::Yes, VoteChoice::Yes, VoteChoice::Yes]);
        let t = tally_votes(&poll(), &revs, &coms).unwrap();
        assert_eq!((t.yes_count, t.no_count, t.abstain_count), (3, 0, 0));
    }

    #[test]
    fn test_tally_with_abstains() {
        let (coms, revs) =
            build_votes(&[VoteChoice::Abstain, VoteChoice::Abstain, VoteChoice::Yes]);
        let t = tally_votes(&poll(), &revs, &coms).unwrap();
        assert_eq!((t.yes_count, t.no_count, t.abstain_count), (1, 0, 2));
    }

    #[test]
    fn test_double_vote_nullifier_conflict() {
        let c1 = commit_vote(
            &voter_a(),
            &VoteChoice::Yes,
            &nonce_a(),
            &poll(),
            REVEAL_SLOT,
        );
        let c2 = commit_vote(
            &voter_a(),
            &VoteChoice::No,
            &nonce_b(),
            &poll(),
            REVEAL_SLOT,
        );
        assert_eq!(
            c1.voter_nullifier, c2.voter_nullifier,
            "same voter must share nullifier"
        );
        let r1 = reveal_vote(&c1, &VoteChoice::Yes, &nonce_a(), NOW).unwrap();
        let r2 = reveal_vote(&c2, &VoteChoice::No, &nonce_b(), NOW).unwrap();
        assert_eq!(
            tally_votes(&poll(), &[r1, r2], &[c1, c2]).unwrap_err(),
            VoteError::NullifierConflict
        );
    }

    #[test]
    fn test_tally_json_hides_voter_identities() {
        let (coms, revs) = build_votes(&[VoteChoice::Yes, VoteChoice::No, VoteChoice::Yes]);
        let t = tally_votes(&poll(), &revs, &coms).unwrap();
        let json = tally_to_json(&t);
        assert!(json.contains("yes_count"));
        assert!(json.contains("no_count"));
        assert!(json.contains("tally_root"));
        let ha = hex_encode(&voter_a());
        let hb = hex_encode(&voter_b());
        let hc = hex_encode(&voter_c());
        assert!(!json.contains(ha.as_str()), "voter A must not appear");
        assert!(!json.contains(hb.as_str()), "voter B must not appear");
        assert!(!json.contains(hc.as_str()), "voter C must not appear");
        assert!(!json.contains("nonce"));
        assert!(!json.contains("voter_id"));
    }

    #[test]
    fn test_yes_no_choices_differ() {
        let cy = commit_vote(
            &voter_a(),
            &VoteChoice::Yes,
            &nonce_a(),
            &poll(),
            REVEAL_SLOT,
        );
        let cn = commit_vote(
            &voter_a(),
            &VoteChoice::No,
            &nonce_a(),
            &poll(),
            REVEAL_SLOT,
        );
        assert_ne!(cy.vote_commit, cn.vote_commit);
        assert_ne!(VoteChoice::Yes.to_byte(), VoteChoice::No.to_byte());
    }
}
