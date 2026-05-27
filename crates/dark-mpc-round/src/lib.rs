use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MpcSession {
    pub session_id: [u8; 32],
    pub party_count: u8,
    pub round: u8,
    pub round_hash: [u8; 32],
    pub completed: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MpcMessage {
    pub from_party: u8,
    pub to_party: u8,
    pub msg_hash: [u8; 32],
    pub round: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum MpcError {
    InsufficientParties,
    ZeroSessionSecret,
    RoundComplete,
}

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

fn sha256_2(a: &[u8], b: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(a);
    h.update(b);
    h.finalize().into()
}

fn sha256_1(a: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(a);
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

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

/// session_id = SHA256("mpc-session-v1" || session_secret || [party_count])
fn compute_session_id(session_secret: &[u8; 32], party_count: u8) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"mpc-session-v1");
    hasher.update(session_secret);
    hasher.update(&[party_count]);
    hasher.finalize().into()
}

/// round_hash = SHA256("mpc-round-v1" || session_id || [round] || XOR_fold(msg_hashes))
fn compute_round_hash(session_id: &[u8; 32], round: u8, messages: &[MpcMessage]) -> [u8; 32] {
    let msg_hashes: Vec<[u8; 32]> = messages.iter().map(|m| m.msg_hash).collect();
    let folded = xor_fold(&msg_hashes);

    let mut hasher = Sha256::new();
    hasher.update(b"mpc-round-v1");
    hasher.update(session_id);
    hasher.update(&[round]);
    hasher.update(&folded);
    hasher.finalize().into()
}

/// msg_hash = SHA256("mpc-msg-v1" || session_id || [from] || [to] || [round] || payload_hash)
/// payload_hash = SHA256(payload_bytes)
fn compute_msg_hash(
    session_id: &[u8; 32],
    from_party: u8,
    to_party: u8,
    round: u8,
    payload_bytes: &[u8],
) -> [u8; 32] {
    let payload_hash = sha256_1(payload_bytes);
    let mut hasher = Sha256::new();
    hasher.update(b"mpc-msg-v1");
    hasher.update(session_id);
    hasher.update(&[from_party]);
    hasher.update(&[to_party]);
    hasher.update(&[round]);
    hasher.update(&payload_hash);
    hasher.finalize().into()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Create a new MPC session.
///
/// Errors:
/// - ZeroSessionSecret: session_secret is all zeros
/// - InsufficientParties: party_count < 2
pub fn new_session(session_secret: &[u8; 32], party_count: u8) -> Result<MpcSession, MpcError> {
    if *session_secret == [0u8; 32] {
        return Err(MpcError::ZeroSessionSecret);
    }
    if party_count < 2 {
        return Err(MpcError::InsufficientParties);
    }

    let session_id = compute_session_id(session_secret, party_count);

    Ok(MpcSession {
        session_id,
        party_count,
        round: 0,
        round_hash: [0u8; 32],
        completed: false,
        mainnet_ready: false,
    })
}

/// Create an MPC message for this session.
pub fn create_message(
    session: &MpcSession,
    from_party: u8,
    to_party: u8,
    payload_bytes: &[u8],
) -> MpcMessage {
    let msg_hash = compute_msg_hash(
        &session.session_id,
        from_party,
        to_party,
        session.round,
        payload_bytes,
    );
    MpcMessage {
        from_party,
        to_party,
        msg_hash,
        round: session.round,
    }
}

/// Advance the session by one round, computing a new round_hash from messages.
///
/// Errors:
/// - RoundComplete: session is already completed
///
/// Sets round += 1, computes round_hash, sets completed=true if round >= party_count.
pub fn advance_round(
    session: &mut MpcSession,
    messages: &[MpcMessage],
) -> Result<[u8; 32], MpcError> {
    if session.completed {
        return Err(MpcError::RoundComplete);
    }

    let round_hash = compute_round_hash(&session.session_id, session.round, messages);
    session.round_hash = round_hash;
    session.round = session.round.saturating_add(1);
    if session.round >= session.party_count {
        session.completed = true;
    }

    Ok(round_hash)
}

/// Public JSON record for the session.
pub fn session_public_record(session: &MpcSession) -> String {
    let sid_hex: String = session
        .session_id
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    serde_json::json!({
        "session_id": sid_hex,
        "party_count": session.party_count,
        "round": session.round,
        "completed": session.completed,
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

    fn secret() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xAB;
        s[1] = 0xCD;
        s
    }

    #[test]
    fn test_new_session_and_advance_round() {
        let mut session = new_session(&secret(), 3).unwrap();
        assert!(!session.completed);
        assert!(!session.mainnet_ready);
        assert_eq!(session.party_count, 3);

        let msg = create_message(&session, 0, 1, b"payload-a");
        let rh = advance_round(&mut session, &[msg]).unwrap();
        assert_eq!(rh.len(), 32);
        assert_eq!(session.round, 1);
        assert!(!session.completed);

        // advance again
        let msg2 = create_message(&session, 1, 2, b"payload-b");
        advance_round(&mut session, &[msg2]).unwrap();
        assert_eq!(session.round, 2);
        assert!(!session.completed);

        // advance final round
        let msg3 = create_message(&session, 2, 0, b"payload-c");
        advance_round(&mut session, &[msg3]).unwrap();
        assert!(session.completed);
    }

    #[test]
    fn test_insufficient_parties_rejected() {
        let err = new_session(&secret(), 1).unwrap_err();
        assert_eq!(err, MpcError::InsufficientParties);

        let err2 = new_session(&secret(), 0).unwrap_err();
        assert_eq!(err2, MpcError::InsufficientParties);
    }

    #[test]
    fn test_zero_secret_rejected() {
        let err = new_session(&[0u8; 32], 3).unwrap_err();
        assert_eq!(err, MpcError::ZeroSessionSecret);
    }

    #[test]
    fn test_round_hash_deterministic() {
        let mut s1 = new_session(&secret(), 2).unwrap();
        let mut s2 = new_session(&secret(), 2).unwrap();

        let msg1 = create_message(&s1, 0, 1, b"deterministic");
        let msg2 = create_message(&s2, 0, 1, b"deterministic");

        let rh1 = advance_round(&mut s1, &[msg1]).unwrap();
        let rh2 = advance_round(&mut s2, &[msg2]).unwrap();

        assert_eq!(rh1, rh2);
    }

    #[test]
    fn test_messages_affect_round_hash() {
        let mut s1 = new_session(&secret(), 2).unwrap();
        let mut s2 = new_session(&secret(), 2).unwrap();

        let msg1 = create_message(&s1, 0, 1, b"payload-alpha");
        let msg2 = create_message(&s2, 0, 1, b"payload-beta");

        let rh1 = advance_round(&mut s1, &[msg1]).unwrap();
        let rh2 = advance_round(&mut s2, &[msg2]).unwrap();

        assert_ne!(rh1, rh2);
    }

    #[test]
    fn test_completed_after_party_count_rounds() {
        let mut session = new_session(&secret(), 2).unwrap();
        assert!(!session.completed);

        let msg1 = create_message(&session, 0, 1, b"r0");
        advance_round(&mut session, &[msg1]).unwrap();
        assert!(!session.completed);

        let msg2 = create_message(&session, 1, 0, b"r1");
        advance_round(&mut session, &[msg2]).unwrap();
        assert!(session.completed);

        // Further advances are rejected
        let err = advance_round(&mut session, &[]).unwrap_err();
        assert_eq!(err, MpcError::RoundComplete);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_session_id_nonzero() {
        let session = new_session(&secret(), 2).unwrap();
        assert_ne!(session.session_id, [0u8; 32]);
    }

    #[test]
    fn test_session_id_deterministic() {
        let s1 = new_session(&secret(), 3).unwrap();
        let s2 = new_session(&secret(), 3).unwrap();
        assert_eq!(s1.session_id, s2.session_id);
    }

    #[test]
    fn test_session_id_secret_sensitive() {
        let mut sec2 = secret();
        sec2[0] ^= 0xFF;
        let s1 = new_session(&secret(), 2).unwrap();
        let s2 = new_session(&sec2, 2).unwrap();
        assert_ne!(s1.session_id, s2.session_id);
    }

    #[test]
    fn test_mainnet_ready_false() {
        let session = new_session(&secret(), 2).unwrap();
        assert!(!session.mainnet_ready);
    }

    #[test]
    fn test_message_hash_nonzero() {
        let session = new_session(&secret(), 2).unwrap();
        let msg = create_message(&session, 0, 1, b"payload");
        assert_ne!(msg.msg_hash, [0u8; 32]);
    }

    #[test]
    fn test_message_hash_payload_sensitive() {
        let session = new_session(&secret(), 2).unwrap();
        let m1 = create_message(&session, 0, 1, b"payload-alpha");
        let m2 = create_message(&session, 0, 1, b"payload-beta");
        assert_ne!(m1.msg_hash, m2.msg_hash);
    }

    #[test]
    fn test_round_hash_nonzero() {
        let mut session = new_session(&secret(), 2).unwrap();
        let msg = create_message(&session, 0, 1, b"data");
        let rh = advance_round(&mut session, &[msg]).unwrap();
        assert_ne!(rh, [0u8; 32]);
    }

    #[test]
    fn test_public_record_fields() {
        let session = new_session(&secret(), 3).unwrap();
        let json_str = session_public_record(&session);
        let v: serde_json::Value = serde_json::from_str(&json_str).unwrap();
        assert!(v["session_id"].is_string());
        assert_eq!(v["party_count"], 3u8);
        assert_eq!(v["round"], 0u8);
        assert_eq!(v["completed"], false);
        assert_eq!(v["mainnet_ready"], false);
    }

    #[test]
    fn test_min_two_parties_ok() {
        // party_count == 2 is the minimum allowed
        let result = new_session(&secret(), 2);
        assert!(result.is_ok(), "party_count == 2 must succeed");
    }

    #[test]
    fn test_session_starts_incomplete() {
        let session = new_session(&secret(), 4).unwrap();
        assert!(!session.completed);
        assert_eq!(session.round, 0);
    }
}
