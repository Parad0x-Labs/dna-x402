use serde::Serialize;
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

pub struct SessionCommitment {
    /// `SHA256("session-id-v1" || agent_secret || session_nonce)`
    pub session_id: [u8; 32],
    /// Starts as `session_id`; ratchets forward with every message.
    pub chain_root: [u8; 32],
    pub message_count: u32,
    /// Always `false` — mainnet hardening not yet complete.
    pub mainnet_ready: bool,
}

#[derive(Debug)]
pub struct MessageLink {
    pub prev_chain_root: [u8; 32],
    /// `SHA256("msg-v1" || message_bytes)`
    pub message_hash: [u8; 32],
    /// `SHA256("chain-v1" || prev_chain_root || message_hash || counter_le)`
    pub next_chain_root: [u8; 32],
    pub counter: u32,
}

#[derive(Debug, PartialEq)]
pub enum SessionError {
    ChainBroken { expected: [u8; 32], got: [u8; 32] },
    EmptyMessage,
    CounterMismatch,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Begin a new session.
///
/// `session_id = SHA256("session-id-v1" || agent_secret || nonce)`
/// `chain_root` is initialised to `session_id`.
/// `mainnet_ready` is always `false`.
pub fn new_session(agent_secret: &[u8; 32], nonce: &[u8; 32]) -> SessionCommitment {
    let mut h = Sha256::new();
    h.update(b"session-id-v1");
    h.update(agent_secret);
    h.update(nonce);
    let session_id: [u8; 32] = h.finalize().into();

    SessionCommitment {
        session_id,
        chain_root: session_id,
        message_count: 0,
        mainnet_ready: false,
    }
}

/// Append a message to the session chain.
///
/// Returns `EmptyMessage` if `message_bytes` is empty.
/// Otherwise advances `chain_root` and increments `message_count`.
pub fn advance_session(
    session: &mut SessionCommitment,
    message_bytes: &[u8],
) -> Result<MessageLink, SessionError> {
    if message_bytes.is_empty() {
        return Err(SessionError::EmptyMessage);
    }

    // message_hash = SHA256("msg-v1" || message_bytes)
    let message_hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"msg-v1");
        h.update(message_bytes);
        h.finalize().into()
    };

    let prev_chain_root = session.chain_root;
    let counter = session.message_count;

    // next_chain_root = SHA256("chain-v1" || prev_chain_root || message_hash || counter_le)
    let next_chain_root: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"chain-v1");
        h.update(prev_chain_root);
        h.update(message_hash);
        h.update(counter.to_le_bytes());
        h.finalize().into()
    };

    let link = MessageLink {
        prev_chain_root,
        message_hash,
        next_chain_root,
        counter,
    };

    session.chain_root = next_chain_root;
    session.message_count += 1;

    Ok(link)
}

/// Verify that `link` is internally consistent and corresponds to the last
/// message appended to `session`.
///
/// Checks:
/// - Recomputed `next_chain_root` matches `link.next_chain_root` → `ChainBroken` otherwise.
/// - `link.counter == session.message_count - 1` → `CounterMismatch` otherwise.
pub fn verify_link(session: &SessionCommitment, link: &MessageLink) -> Result<(), SessionError> {
    // Guard against underflow when message_count == 0
    if session.message_count == 0 {
        return Err(SessionError::CounterMismatch);
    }

    if link.counter != session.message_count - 1 {
        return Err(SessionError::CounterMismatch);
    }

    // Recompute next_chain_root
    let recomputed: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"chain-v1");
        h.update(link.prev_chain_root);
        h.update(link.message_hash);
        h.update(link.counter.to_le_bytes());
        h.finalize().into()
    };

    if recomputed != link.next_chain_root {
        return Err(SessionError::ChainBroken {
            expected: recomputed,
            got: link.next_chain_root,
        });
    }

    Ok(())
}

/// Serialise session metadata to JSON.
///
/// Privacy guarantee: `agent_secret` and `session_nonce` are **never** included.
pub fn session_proof_json(session: &SessionCommitment) -> String {
    #[derive(Serialize)]
    struct Proof<'a> {
        session_id: &'a str,
        chain_root: &'a str,
        message_count: u32,
        mainnet_ready: bool,
    }

    let session_id_hex = hex_encode(&session.session_id);
    let chain_root_hex = hex_encode(&session.chain_root);

    let proof = Proof {
        session_id: &session_id_hex,
        chain_root: &chain_root_hex,
        message_count: session.message_count,
        mainnet_ready: session.mainnet_ready,
    };

    serde_json::to_string(&proof).expect("proof serialization is infallible")
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

    fn make_session() -> SessionCommitment {
        let secret = [0x11u8; 32];
        let nonce = [0x22u8; 32];
        new_session(&secret, &nonce)
    }

    // 1 -----------------------------------------------------------------------
    #[test]
    fn test_session_advance_chain() {
        let mut session = make_session();
        let root0 = session.chain_root;

        let link1 = advance_session(&mut session, b"hello").unwrap();
        let root1 = session.chain_root;

        let link2 = advance_session(&mut session, b"world").unwrap();
        let root2 = session.chain_root;

        let _link3 = advance_session(&mut session, b"three").unwrap();
        let root3 = session.chain_root;

        // Each advance must produce a distinct chain root
        assert_ne!(root0, root1);
        assert_ne!(root1, root2);
        assert_ne!(root2, root3);

        // next_chain_root in the link must equal what session.chain_root became
        assert_eq!(link1.next_chain_root, root1);
        assert_eq!(link2.next_chain_root, root2);

        assert_eq!(session.message_count, 3);
    }

    // 2 -----------------------------------------------------------------------
    #[test]
    fn test_link_verification_passes() {
        let mut session = make_session();
        let link = advance_session(&mut session, b"verify me").unwrap();
        verify_link(&session, &link).expect("link verification must pass");
    }

    // 3 -----------------------------------------------------------------------
    #[test]
    fn test_empty_message_rejected() {
        let mut session = make_session();
        let err = advance_session(&mut session, b"").unwrap_err();
        assert_eq!(err, SessionError::EmptyMessage);
        // message_count must be unchanged
        assert_eq!(session.message_count, 0);
    }

    // 4 -----------------------------------------------------------------------
    #[test]
    fn test_chain_root_sensitive_to_content() {
        let secret = [0xAAu8; 32];
        let nonce = [0xBBu8; 32];

        let mut session_a = new_session(&secret, &nonce);
        let mut session_b = new_session(&secret, &nonce);

        advance_session(&mut session_a, b"message alpha").unwrap();
        advance_session(&mut session_b, b"message beta").unwrap();

        // Different content must yield different chain roots
        assert_ne!(
            session_a.chain_root, session_b.chain_root,
            "chain roots must diverge for different message content"
        );
    }

    // 5 -----------------------------------------------------------------------
    #[test]
    fn test_session_json_hides_secret() {
        let secret = [0xDEu8; 32];
        let nonce = [0xADu8; 32];
        let session = new_session(&secret, &nonce);

        let secret_hex = hex_encode(&secret);
        let nonce_hex = hex_encode(&nonce);

        let json = session_proof_json(&session);

        assert!(
            !json.contains(&secret_hex),
            "JSON must not contain agent_secret hex: {}",
            secret_hex
        );
        assert!(
            !json.contains(&nonce_hex),
            "JSON must not contain session_nonce hex: {}",
            nonce_hex
        );

        // Sanity: expected fields are present
        assert!(json.contains("\"message_count\":0"));
        assert!(json.contains("\"mainnet_ready\":false"));
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_mainnet_ready_always_false() {
        let session = make_session();
        assert!(!session.mainnet_ready);
    }

    #[test]
    fn test_session_id_deterministic() {
        let s1 = make_session();
        let s2 = make_session();
        assert_eq!(s1.session_id, s2.session_id);
    }

    #[test]
    fn test_different_secrets_different_sessions() {
        let s1 = new_session(&[0x11u8; 32], &[0x22u8; 32]);
        let s2 = new_session(&[0x33u8; 32], &[0x22u8; 32]);
        assert_ne!(s1.session_id, s2.session_id);
    }

    #[test]
    fn test_message_count_increments() {
        let mut session = make_session();
        assert_eq!(session.message_count, 0);
        advance_session(&mut session, b"a").unwrap();
        assert_eq!(session.message_count, 1);
        advance_session(&mut session, b"b").unwrap();
        assert_eq!(session.message_count, 2);
    }

    #[test]
    fn test_chain_root_starts_at_session_id() {
        let session = make_session();
        assert_eq!(session.chain_root, session.session_id);
    }

    #[test]
    fn test_counter_starts_at_zero_in_link() {
        let mut session = make_session();
        let link = advance_session(&mut session, b"first").unwrap();
        assert_eq!(link.counter, 0);
    }

    #[test]
    fn test_verify_link_fails_tampered_next_root() {
        let mut session = make_session();
        let mut link = advance_session(&mut session, b"tamper test").unwrap();
        link.next_chain_root[0] ^= 0xFF;
        let err = verify_link(&session, &link).unwrap_err();
        match err {
            SessionError::ChainBroken { .. } => {}
            _ => panic!("expected ChainBroken"),
        }
    }

    #[test]
    fn test_verify_link_fails_counter_mismatch() {
        let mut session = make_session();
        let mut link = advance_session(&mut session, b"counter test").unwrap();
        link.counter += 1; // tamper counter
        let err = verify_link(&session, &link).unwrap_err();
        assert_eq!(err, SessionError::CounterMismatch);
    }

    #[test]
    fn test_session_proof_json_has_expected_fields() {
        let session = make_session();
        let json = session_proof_json(&session);
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(v["session_id"].is_string());
        assert!(v["chain_root"].is_string());
        assert_eq!(v["message_count"], 0u32);
        assert_eq!(v["mainnet_ready"], false);
    }

    #[test]
    fn test_multiple_links_all_verify() {
        let mut session = make_session();
        let l1 = advance_session(&mut session, b"msg1").unwrap();
        let l2 = advance_session(&mut session, b"msg2").unwrap();
        // l1 counter=0, session.message_count=2 → l1 is no longer the "last" link
        // verify_link checks link.counter == message_count - 1
        verify_link(&session, &l2).expect("last link must verify");
        // l1 is stale — counter=0 but message_count=2, so CounterMismatch
        let err = verify_link(&session, &l1).unwrap_err();
        assert_eq!(err, SessionError::CounterMismatch);
    }

    #[test]
    fn test_same_message_different_nonce_different_session_id() {
        let s1 = new_session(&[0xFFu8; 32], &[0x01u8; 32]);
        let s2 = new_session(&[0xFFu8; 32], &[0x02u8; 32]);
        assert_ne!(s1.session_id, s2.session_id);
    }
}
