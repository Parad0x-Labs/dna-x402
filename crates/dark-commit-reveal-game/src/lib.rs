use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameSession {
    pub session_id: [u8; 32],
    pub player_a_hash: [u8; 32],
    pub player_b_hash: [u8; 32],
    pub a_commit: Option<[u8; 32]>,
    pub b_commit: Option<[u8; 32]>,
    pub revealed_a: Option<[u8; 32]>,
    pub revealed_b: Option<[u8; 32]>,
    pub winner: Option<u8>, // 0 = player A, 1 = player B, None = draw
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum GameError {
    ZeroPlayerSecret,
    AlreadyCommitted,
    NotBothCommitted,
    AlreadyRevealed,
    CommitMismatch,
}

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

/// player_hash = SHA256("game-player-v1" || player_secret)
fn compute_player_hash(player_secret: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"game-player-v1", player_secret])
}

/// session_id = SHA256("game-session-v1" || player_a_hash || player_b_hash || nonce)
fn compute_session_id(
    player_a_hash: &[u8; 32],
    player_b_hash: &[u8; 32],
    nonce: &[u8; 32],
) -> [u8; 32] {
    sha256_multi(&[b"game-session-v1", player_a_hash, player_b_hash, nonce])
}

/// choice_hash = SHA256("game-choice-v1" || choice_bytes)
fn compute_choice_hash(choice_bytes: &[u8]) -> [u8; 32] {
    sha256_multi(&[b"game-choice-v1", choice_bytes])
}

/// commit = SHA256("game-commit-v1" || choice_hash || nonce_commit)
fn compute_commit(choice_bytes: &[u8], nonce_commit: &[u8; 32]) -> [u8; 32] {
    let choice_hash = compute_choice_hash(choice_bytes);
    sha256_multi(&[b"game-commit-v1", &choice_hash, nonce_commit])
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Create a new two-player game session.
///
/// Errors: ZeroPlayerSecret (if either secret is all-zero)
pub fn new_game(
    player_a_secret: &[u8; 32],
    player_b_secret: &[u8; 32],
    nonce: &[u8; 32],
) -> Result<GameSession, GameError> {
    if *player_a_secret == [0u8; 32] || *player_b_secret == [0u8; 32] {
        return Err(GameError::ZeroPlayerSecret);
    }
    let player_a_hash = compute_player_hash(player_a_secret);
    let player_b_hash = compute_player_hash(player_b_secret);
    let session_id = compute_session_id(&player_a_hash, &player_b_hash, nonce);
    Ok(GameSession {
        session_id,
        player_a_hash,
        player_b_hash,
        a_commit: None,
        b_commit: None,
        revealed_a: None,
        revealed_b: None,
        winner: None,
        mainnet_ready: false,
    })
}

/// Commit a choice for a player (player_idx: 0=A, 1=B).
/// Returns the commit hash.
///
/// Errors: AlreadyCommitted
pub fn commit_choice(
    session: &mut GameSession,
    player_idx: u8,
    choice_bytes: &[u8],
    nonce_commit: &[u8; 32],
) -> Result<[u8; 32], GameError> {
    let commit = compute_commit(choice_bytes, nonce_commit);
    match player_idx {
        0 => {
            if session.a_commit.is_some() {
                return Err(GameError::AlreadyCommitted);
            }
            session.a_commit = Some(commit);
        }
        _ => {
            if session.b_commit.is_some() {
                return Err(GameError::AlreadyCommitted);
            }
            session.b_commit = Some(commit);
        }
    }
    Ok(commit)
}

/// Reveal a choice for a player. Both must have committed first.
/// Returns the choice_hash on success.
/// Determines winner once both revealed (higher choice_hash wins; equal = no winner).
///
/// Errors: NotBothCommitted, AlreadyRevealed, CommitMismatch
pub fn reveal_choice(
    session: &mut GameSession,
    player_idx: u8,
    choice_bytes: &[u8],
    nonce_commit: &[u8; 32],
) -> Result<[u8; 32], GameError> {
    if session.a_commit.is_none() || session.b_commit.is_none() {
        return Err(GameError::NotBothCommitted);
    }

    let recomputed_commit = compute_commit(choice_bytes, nonce_commit);
    let choice_hash = compute_choice_hash(choice_bytes);

    match player_idx {
        0 => {
            if session.revealed_a.is_some() {
                return Err(GameError::AlreadyRevealed);
            }
            if session.a_commit.unwrap() != recomputed_commit {
                return Err(GameError::CommitMismatch);
            }
            session.revealed_a = Some(choice_hash);
        }
        _ => {
            if session.revealed_b.is_some() {
                return Err(GameError::AlreadyRevealed);
            }
            if session.b_commit.unwrap() != recomputed_commit {
                return Err(GameError::CommitMismatch);
            }
            session.revealed_b = Some(choice_hash);
        }
    }

    // Determine winner once both revealed
    if let (Some(ra), Some(rb)) = (session.revealed_a, session.revealed_b) {
        session.winner = if ra > rb {
            Some(0)
        } else if rb > ra {
            Some(1)
        } else {
            None
        };
    }

    Ok(choice_hash)
}

/// Public JSON record: session_id, committed_count, revealed_count, mainnet_ready.
pub fn session_public_record(session: &GameSession) -> String {
    let sid_hex: String = session
        .session_id
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    let committed_count = session.a_commit.is_some() as u8 + session.b_commit.is_some() as u8;
    let revealed_count = session.revealed_a.is_some() as u8 + session.revealed_b.is_some() as u8;
    serde_json::json!({
        "session_id": sid_hex,
        "committed_count": committed_count,
        "revealed_count": revealed_count,
        "mainnet_ready": session.mainnet_ready,
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn secret_a() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xA1;
        s
    }
    fn secret_b() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xB2;
        s
    }
    fn nonce() -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = 0xC3;
        n
    }
    fn nonce_commit_a() -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = 0xD4;
        n
    }
    fn nonce_commit_b() -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = 0xE5;
        n
    }

    #[test]
    fn test_new_commit_reveal_winner_determined() {
        let mut session = new_game(&secret_a(), &secret_b(), &nonce()).unwrap();
        assert!(!session.mainnet_ready);

        // Commit both
        let _ca = commit_choice(&mut session, 0, b"rock", &nonce_commit_a()).unwrap();
        let _cb = commit_choice(&mut session, 1, b"scissors", &nonce_commit_b()).unwrap();
        assert!(session.a_commit.is_some());
        assert!(session.b_commit.is_some());

        // Reveal both
        let choice_hash_a = reveal_choice(&mut session, 0, b"rock", &nonce_commit_a()).unwrap();
        let choice_hash_b = reveal_choice(&mut session, 1, b"scissors", &nonce_commit_b()).unwrap();

        assert_eq!(session.revealed_a, Some(choice_hash_a));
        assert_eq!(session.revealed_b, Some(choice_hash_b));

        // Winner should be determined (whichever choice_hash is larger)
        let expected_winner = if choice_hash_a > choice_hash_b {
            Some(0u8)
        } else if choice_hash_b > choice_hash_a {
            Some(1u8)
        } else {
            None
        };
        assert_eq!(session.winner, expected_winner);
    }

    #[test]
    fn test_commit_mismatch_rejected() {
        let mut session = new_game(&secret_a(), &secret_b(), &nonce()).unwrap();
        commit_choice(&mut session, 0, b"rock", &nonce_commit_a()).unwrap();
        commit_choice(&mut session, 1, b"paper", &nonce_commit_b()).unwrap();

        // Player A tries to reveal with wrong choice
        let err = reveal_choice(&mut session, 0, b"scissors", &nonce_commit_a()).unwrap_err();
        assert_eq!(err, GameError::CommitMismatch);
    }

    #[test]
    fn test_already_committed_rejected() {
        let mut session = new_game(&secret_a(), &secret_b(), &nonce()).unwrap();
        commit_choice(&mut session, 0, b"rock", &nonce_commit_a()).unwrap();
        let err = commit_choice(&mut session, 0, b"scissors", &nonce_commit_a()).unwrap_err();
        assert_eq!(err, GameError::AlreadyCommitted);
    }

    #[test]
    fn test_reveal_before_both_committed_rejected() {
        let mut session = new_game(&secret_a(), &secret_b(), &nonce()).unwrap();
        commit_choice(&mut session, 0, b"rock", &nonce_commit_a()).unwrap();
        // Only A committed, B has not
        let err = reveal_choice(&mut session, 0, b"rock", &nonce_commit_a()).unwrap_err();
        assert_eq!(err, GameError::NotBothCommitted);
    }

    #[test]
    fn test_session_id_deterministic() {
        let s1 = new_game(&secret_a(), &secret_b(), &nonce()).unwrap();
        let s2 = new_game(&secret_a(), &secret_b(), &nonce()).unwrap();
        assert_eq!(s1.session_id, s2.session_id);
        // Different nonce → different session_id
        let mut diff_nonce = nonce();
        diff_nonce[0] = 0xFF;
        let s3 = new_game(&secret_a(), &secret_b(), &diff_nonce).unwrap();
        assert_ne!(s1.session_id, s3.session_id);
    }

    #[test]
    fn test_public_record_correct() {
        let mut session = new_game(&secret_a(), &secret_b(), &nonce()).unwrap();
        commit_choice(&mut session, 0, b"rock", &nonce_commit_a()).unwrap();

        let record = session_public_record(&session);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();

        assert_eq!(v["committed_count"], 1);
        assert_eq!(v["revealed_count"], 0);
        assert_eq!(v["mainnet_ready"], false);
        assert!(v["session_id"].is_string());
        let sid_hex: String = session
            .session_id
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();
        assert_eq!(v["session_id"], sid_hex);
    }
}
