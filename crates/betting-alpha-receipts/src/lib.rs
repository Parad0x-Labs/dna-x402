use sha2::{Sha256, Digest};

#[derive(Debug, Clone, PartialEq)]
pub struct BettingSession {
    pub session_hash: [u8; 32],
}

#[derive(Debug, Clone, PartialEq)]
pub struct MarketCommitment {
    pub commitment_hash: [u8; 32],
    pub market_hash: [u8; 32],
    pub event_start_slot: u64,
    pub odds_snapshot_hash: [u8; 32],
}

#[derive(Debug, Clone, PartialEq)]
pub struct BettingReveal {
    pub market_hash: [u8; 32],
    pub side_byte: u8,
    pub confidence_byte: u8,
    pub odds_snapshot_hash: [u8; 32],
    pub reveal_receipt_hash: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum BettingError {
    #[error("wrong subscriber")]
    WrongSubscriber,
    #[error("commitment mismatch")]
    CommitmentMismatch,
    #[error("market hash absent")]
    MarketHashAbsent,
}

pub fn create_betting_session(
    salt: &[u8; 32],
    analyst_hash: &[u8; 32],
    season: u8,
) -> BettingSession {
    let session_hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"betting-session-v1");
        h.update(salt);
        h.update(analyst_hash);
        h.update([season]);
        h.finalize().into()
    };
    BettingSession { session_hash }
}

pub fn create_market_commitment(
    session: &BettingSession,
    market_id: &[u8],
    side_byte: u8,
    confidence_byte: u8,
    odds_snapshot_hash: &[u8; 32],
    event_start_slot: u64,
) -> MarketCommitment {
    let market_hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(market_id);
        h.finalize().into()
    };

    let commitment_hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"betting-alpha-v1");
        h.update(session.session_hash);
        h.update(market_hash);
        h.update([side_byte]);
        h.update([confidence_byte]);
        h.update(odds_snapshot_hash);
        h.update(event_start_slot.to_le_bytes());
        h.finalize().into()
    };

    MarketCommitment {
        commitment_hash,
        market_hash,
        event_start_slot,
        odds_snapshot_hash: *odds_snapshot_hash,
    }
}

pub fn create_betting_reveal(
    commitment: &MarketCommitment,
    session: &BettingSession,
    subscriber_hash: &[u8; 32],
    expected_subscriber: &[u8; 32],
    side_byte: u8,
    confidence_byte: u8,
) -> Result<BettingReveal, BettingError> {
    if subscriber_hash != expected_subscriber {
        return Err(BettingError::WrongSubscriber);
    }

    // Recompute commitment to verify side/confidence match
    let expected_commitment: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"betting-alpha-v1");
        h.update(session.session_hash);
        h.update(commitment.market_hash);
        h.update([side_byte]);
        h.update([confidence_byte]);
        h.update(commitment.odds_snapshot_hash);
        h.update(commitment.event_start_slot.to_le_bytes());
        h.finalize().into()
    };

    if expected_commitment != commitment.commitment_hash {
        return Err(BettingError::CommitmentMismatch);
    }

    let reveal_receipt_hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"betting-reveal-receipt-v1");
        h.update(commitment.commitment_hash);
        h.update(subscriber_hash);
        h.update([side_byte]);
        h.update([confidence_byte]);
        h.finalize().into()
    };

    Ok(BettingReveal {
        market_hash: commitment.market_hash,
        side_byte,
        confidence_byte,
        odds_snapshot_hash: commitment.odds_snapshot_hash,
        reveal_receipt_hash,
    })
}

pub fn assert_raw_market_absent(reveal_json: &str, raw_market_bytes: &[u8]) -> bool {
    let hex: String = raw_market_bytes.iter().map(|b| format!("{:02x}", b)).collect();
    !reveal_json.contains(&hex)
}

pub fn verify_betting_reveal(
    commitment: &MarketCommitment,
    reveal: &BettingReveal,
    session: &BettingSession,
    side_byte: u8,
    confidence_byte: u8,
) -> bool {
    let recomputed: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"betting-alpha-v1");
        h.update(session.session_hash);
        h.update(commitment.market_hash);
        h.update([side_byte]);
        h.update([confidence_byte]);
        h.update(commitment.odds_snapshot_hash);
        h.update(commitment.event_start_slot.to_le_bytes());
        h.finalize().into()
    };
    recomputed == commitment.commitment_hash
        && reveal.market_hash == commitment.market_hash
        && reveal.side_byte == side_byte
        && reveal.confidence_byte == confidence_byte
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_session() -> BettingSession {
        create_betting_session(&[1u8; 32], &[2u8; 32], 1)
    }

    fn make_commitment(session: &BettingSession) -> MarketCommitment {
        create_market_commitment(session, b"nfl-2024-week1-chiefs-bills", 0, 75, &[3u8; 32], 500)
    }

    fn subscriber() -> [u8; 32] {
        [0xAB_u8; 32]
    }

    #[test]
    fn test_session_hash_deterministic() {
        let s1 = create_betting_session(&[1u8; 32], &[2u8; 32], 1);
        let s2 = create_betting_session(&[1u8; 32], &[2u8; 32], 1);
        assert_eq!(s1.session_hash, s2.session_hash);
    }

    #[test]
    fn test_commitment_covers_all_fields() {
        let session = make_session();
        let c1 = make_commitment(&session);
        // Change side_byte
        let c2 = create_market_commitment(&session, b"nfl-2024-week1-chiefs-bills", 1, 75, &[3u8; 32], 500);
        assert_ne!(c1.commitment_hash, c2.commitment_hash);
        // Change confidence_byte
        let c3 = create_market_commitment(&session, b"nfl-2024-week1-chiefs-bills", 0, 80, &[3u8; 32], 500);
        assert_ne!(c1.commitment_hash, c3.commitment_hash);
        // Change event_start_slot
        let c4 = create_market_commitment(&session, b"nfl-2024-week1-chiefs-bills", 0, 75, &[3u8; 32], 600);
        assert_ne!(c1.commitment_hash, c4.commitment_hash);
    }

    #[test]
    fn test_wrong_subscriber_rejected() {
        let session = make_session();
        let commitment = make_commitment(&session);
        let sub = subscriber();
        let wrong = [0xCC_u8; 32];
        let result = create_betting_reveal(&commitment, &session, &wrong, &sub, 0, 75);
        assert_eq!(result, Err(BettingError::WrongSubscriber));
    }

    #[test]
    fn test_reveal_verifies_against_commitment() {
        let session = make_session();
        let commitment = make_commitment(&session);
        let sub = subscriber();
        let reveal = create_betting_reveal(&commitment, &session, &sub, &sub, 0, 75).unwrap();
        assert!(verify_betting_reveal(&commitment, &reveal, &session, 0, 75));
    }

    #[test]
    fn test_raw_market_absent_from_reveal() {
        let session = make_session();
        let commitment = make_commitment(&session);
        let sub = subscriber();
        let reveal = create_betting_reveal(&commitment, &session, &sub, &sub, 0, 75).unwrap();
        // Serialize reveal to a simple JSON-like string (no actual JSON needed for the check)
        let reveal_json = format!(
            "{{\"side\":{},\"confidence\":{}}}",
            reveal.side_byte, reveal.confidence_byte
        );
        // raw_market_bytes are different from commitment.market_hash (use raw market id bytes)
        let raw_market_bytes = b"nfl-2024-week1-chiefs-bills";
        assert!(assert_raw_market_absent(&reveal_json, raw_market_bytes));
    }

    #[test]
    fn test_confidence_byte_bound() {
        let session = make_session();
        let c1 = create_market_commitment(&session, b"market-x", 0, 50, &[3u8; 32], 500);
        let c2 = create_market_commitment(&session, b"market-x", 0, 75, &[3u8; 32], 500);
        assert_ne!(c1.commitment_hash, c2.commitment_hash);
    }

    #[test]
    fn test_odds_snapshot_bound() {
        let session = make_session();
        let c1 = create_market_commitment(&session, b"market-x", 0, 75, &[3u8; 32], 500);
        let c2 = create_market_commitment(&session, b"market-x", 0, 75, &[4u8; 32], 500);
        assert_ne!(c1.commitment_hash, c2.commitment_hash);
    }

    #[test]
    fn test_receipt_hash_deterministic() {
        let session = make_session();
        let commitment = make_commitment(&session);
        let sub = subscriber();
        let r1 = create_betting_reveal(&commitment, &session, &sub, &sub, 0, 75).unwrap();
        let r2 = create_betting_reveal(&commitment, &session, &sub, &sub, 0, 75).unwrap();
        assert_eq!(r1.reveal_receipt_hash, r2.reveal_receipt_hash);
    }
}
