use sha2::{Digest, Sha256};

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct SwapSession {
    /// SHA256("swap-session-v1" || a_hash || b_hash || nonce)
    pub session_id: [u8; 32],
    /// SHA256("swap-party-v1" || secret_a)
    pub party_a_hash: [u8; 32],
    /// SHA256("swap-party-v1" || secret_b)
    pub party_b_hash: [u8; 32],
    pub a_commit: Option<[u8; 32]>,
    pub b_commit: Option<[u8; 32]>,
    /// SHA256("swap-root-v1" || a_commit || b_commit) — set on settle
    pub swap_root: [u8; 32],
    pub settled: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum SwapError {
    ZeroPartySecret,
    AlreadyCommitted,
    NotBothCommitted,
    AlreadySettled,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn sha256_parts(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

// ── Hash formulas ─────────────────────────────────────────────────────────────

pub fn party_hash(secret: &[u8; 32]) -> [u8; 32] {
    sha256_parts(&[b"swap-party-v1", secret.as_ref()])
}

pub fn session_id_hash(a_hash: &[u8; 32], b_hash: &[u8; 32], nonce: &[u8; 32]) -> [u8; 32] {
    sha256_parts(&[
        b"swap-session-v1",
        a_hash.as_ref(),
        b_hash.as_ref(),
        nonce.as_ref(),
    ])
}

pub fn token_hash(token_id: &[u8]) -> [u8; 32] {
    sha256_parts(&[b"swap-token-v1", token_id])
}

pub fn amount_commitment(amount: u64, tok_hash: &[u8; 32], blinding: &[u8; 32]) -> [u8; 32] {
    sha256_parts(&[
        b"swap-commit-v1",
        &amount.to_le_bytes(),
        tok_hash.as_ref(),
        blinding.as_ref(),
    ])
}

pub fn swap_root_hash(a_commit: &[u8; 32], b_commit: &[u8; 32]) -> [u8; 32] {
    sha256_parts(&[b"swap-root-v1", a_commit.as_ref(), b_commit.as_ref()])
}

// ── Public API ────────────────────────────────────────────────────────────────

pub fn new_swap(
    party_a_secret: &[u8; 32],
    party_b_secret: &[u8; 32],
    nonce: &[u8; 32],
) -> Result<SwapSession, SwapError> {
    if party_a_secret == &[0u8; 32] || party_b_secret == &[0u8; 32] {
        return Err(SwapError::ZeroPartySecret);
    }

    let a_hash = party_hash(party_a_secret);
    let b_hash = party_hash(party_b_secret);
    let sid = session_id_hash(&a_hash, &b_hash, nonce);

    Ok(SwapSession {
        session_id: sid,
        party_a_hash: a_hash,
        party_b_hash: b_hash,
        a_commit: None,
        b_commit: None,
        swap_root: [0u8; 32],
        settled: false,
        mainnet_ready: false,
    })
}

pub fn commit_amount(
    session: &mut SwapSession,
    party_idx: u8,
    amount: u64,
    token_id: &[u8],
    blinding: &[u8; 32],
) -> Result<[u8; 32], SwapError> {
    let th = token_hash(token_id);
    let commit = amount_commitment(amount, &th, blinding);

    match party_idx {
        0 => {
            if session.a_commit.is_some() {
                return Err(SwapError::AlreadyCommitted);
            }
            session.a_commit = Some(commit);
        }
        _ => {
            if session.b_commit.is_some() {
                return Err(SwapError::AlreadyCommitted);
            }
            session.b_commit = Some(commit);
        }
    }

    Ok(commit)
}

pub fn settle_swap(session: &mut SwapSession) -> Result<[u8; 32], SwapError> {
    if session.settled {
        return Err(SwapError::AlreadySettled);
    }

    let a = session.a_commit.ok_or(SwapError::NotBothCommitted)?;
    let b = session.b_commit.ok_or(SwapError::NotBothCommitted)?;

    let root = swap_root_hash(&a, &b);
    session.swap_root = root;
    session.settled = true;

    Ok(root)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET_A: [u8; 32] = [0x01u8; 32];
    const SECRET_B: [u8; 32] = [0x02u8; 32];
    const NONCE: [u8; 32] = [0x42u8; 32];
    const BLINDING_A: [u8; 32] = [0xaau8; 32];
    const BLINDING_B: [u8; 32] = [0xbbu8; 32];
    const TOKEN_A: &[u8] = b"USDC";
    const TOKEN_B: &[u8] = b"SOL";

    #[test]
    fn new_swap_correct_hashes() {
        let session = new_swap(&SECRET_A, &SECRET_B, &NONCE).unwrap();
        let expected_a = party_hash(&SECRET_A);
        let expected_b = party_hash(&SECRET_B);
        let expected_sid = session_id_hash(&expected_a, &expected_b, &NONCE);
        assert_eq!(session.party_a_hash, expected_a);
        assert_eq!(session.party_b_hash, expected_b);
        assert_eq!(session.session_id, expected_sid);
        assert!(!session.mainnet_ready);
    }

    #[test]
    fn commit_both_parties() {
        let mut s = new_swap(&SECRET_A, &SECRET_B, &NONCE).unwrap();
        let ca = commit_amount(&mut s, 0, 500_000, TOKEN_A, &BLINDING_A).unwrap();
        let cb = commit_amount(&mut s, 1, 1_000_000, TOKEN_B, &BLINDING_B).unwrap();
        assert_ne!(ca, [0u8; 32]);
        assert_ne!(cb, [0u8; 32]);
        assert_ne!(ca, cb);
        assert_eq!(s.a_commit, Some(ca));
        assert_eq!(s.b_commit, Some(cb));
    }

    #[test]
    fn settle_returns_swap_root() {
        let mut s = new_swap(&SECRET_A, &SECRET_B, &NONCE).unwrap();
        commit_amount(&mut s, 0, 500_000, TOKEN_A, &BLINDING_A).unwrap();
        commit_amount(&mut s, 1, 1_000_000, TOKEN_B, &BLINDING_B).unwrap();
        let root = settle_swap(&mut s).unwrap();
        assert_ne!(root, [0u8; 32]);
        assert_eq!(s.swap_root, root);
        assert!(s.settled);
    }

    #[test]
    fn already_committed_rejected() {
        let mut s = new_swap(&SECRET_A, &SECRET_B, &NONCE).unwrap();
        commit_amount(&mut s, 0, 500_000, TOKEN_A, &BLINDING_A).unwrap();
        let result = commit_amount(&mut s, 0, 999_999, TOKEN_A, &BLINDING_A);
        assert_eq!(result.unwrap_err(), SwapError::AlreadyCommitted);
    }

    #[test]
    fn settle_requires_both_committed() {
        let mut s = new_swap(&SECRET_A, &SECRET_B, &NONCE).unwrap();
        // Only party A commits
        commit_amount(&mut s, 0, 500_000, TOKEN_A, &BLINDING_A).unwrap();
        let result = settle_swap(&mut s);
        assert_eq!(result.unwrap_err(), SwapError::NotBothCommitted);
    }

    #[test]
    fn mainnet_ready_is_false() {
        let s = new_swap(&SECRET_A, &SECRET_B, &NONCE).unwrap();
        assert!(!s.mainnet_ready);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_session_id_deterministic() {
        let s1 = new_swap(&SECRET_A, &SECRET_B, &NONCE).unwrap();
        let s2 = new_swap(&SECRET_A, &SECRET_B, &NONCE).unwrap();
        assert_eq!(s1.session_id, s2.session_id);
    }

    #[test]
    fn test_session_id_nonce_sensitive() {
        let nonce2 = [0x99u8; 32];
        let s1 = new_swap(&SECRET_A, &SECRET_B, &NONCE).unwrap();
        let s2 = new_swap(&SECRET_A, &SECRET_B, &nonce2).unwrap();
        assert_ne!(s1.session_id, s2.session_id);
    }

    #[test]
    fn test_session_id_party_sensitive() {
        let secret_c = [0x03u8; 32];
        let s1 = new_swap(&SECRET_A, &SECRET_B, &NONCE).unwrap();
        let s2 = new_swap(&SECRET_A, &secret_c, &NONCE).unwrap();
        assert_ne!(s1.session_id, s2.session_id);
    }

    #[test]
    fn test_amount_commitment_deterministic() {
        let th = token_hash(TOKEN_A);
        let c1 = amount_commitment(500_000, &th, &BLINDING_A);
        let c2 = amount_commitment(500_000, &th, &BLINDING_A);
        assert_eq!(c1, c2);
    }

    #[test]
    fn test_amount_commitment_amount_sensitive() {
        let th = token_hash(TOKEN_A);
        let c1 = amount_commitment(500_000, &th, &BLINDING_A);
        let c2 = amount_commitment(600_000, &th, &BLINDING_A);
        assert_ne!(c1, c2);
    }

    #[test]
    fn test_swap_root_deterministic() {
        let a = [0xAAu8; 32];
        let b = [0xBBu8; 32];
        let r1 = swap_root_hash(&a, &b);
        let r2 = swap_root_hash(&a, &b);
        assert_eq!(r1, r2);
    }

    #[test]
    fn test_double_settle_rejected() {
        let mut s = new_swap(&SECRET_A, &SECRET_B, &NONCE).unwrap();
        commit_amount(&mut s, 0, 500_000, TOKEN_A, &BLINDING_A).unwrap();
        commit_amount(&mut s, 1, 1_000_000, TOKEN_B, &BLINDING_B).unwrap();
        settle_swap(&mut s).unwrap();
        assert_eq!(settle_swap(&mut s).unwrap_err(), SwapError::AlreadySettled);
    }

    #[test]
    fn test_zero_party_a_rejected() {
        let err = new_swap(&[0u8; 32], &SECRET_B, &NONCE).unwrap_err();
        assert_eq!(err, SwapError::ZeroPartySecret);
    }

    #[test]
    fn test_zero_party_b_rejected() {
        let err = new_swap(&SECRET_A, &[0u8; 32], &NONCE).unwrap_err();
        assert_eq!(err, SwapError::ZeroPartySecret);
    }

    #[test]
    fn test_settled_starts_false() {
        let s = new_swap(&SECRET_A, &SECRET_B, &NONCE).unwrap();
        assert!(!s.settled);
    }
}
