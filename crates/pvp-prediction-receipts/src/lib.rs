use sha2::{Digest, Sha256};

// Domain prefixes
const DOMAIN_COMMIT: u8 = 0x20;
const DOMAIN_REVEAL: u8 = 0x21;

#[derive(Clone, Debug)]
pub struct PredictionCommitment {
    pub market_hash: [u8; 32],
    pub side_hash: [u8; 32],
    pub confidence_bucket: u8,
    pub committed_at_slot: u64,
    pub user_salt: [u8; 32],
}

/// SHA256(0x20 || market_hash || side_hash || confidence_bucket || committed_at_slot || user_salt)
pub fn commit_hash(pred: &PredictionCommitment) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([DOMAIN_COMMIT]);
    h.update(pred.market_hash);
    h.update(pred.side_hash);
    h.update([pred.confidence_bucket]);
    h.update(pred.committed_at_slot.to_le_bytes());
    h.update(pred.user_salt);
    h.finalize().into()
}

#[derive(Clone, Debug)]
pub struct PredictionReveal {
    pub market_hash: [u8; 32],
    pub side_hash: [u8; 32],
    pub confidence_bucket: u8,
    pub user_salt: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PredictionError {
    HashMismatch,
    LateReveal,
}

/// Recompute the commitment from the reveal + original slot and compare.
pub fn verify_reveal(
    commitment_hash: &[u8; 32],
    reveal: &PredictionReveal,
    committed_at_slot: u64,
) -> Result<(), PredictionError> {
    let reconstructed = PredictionCommitment {
        market_hash: reveal.market_hash,
        side_hash: reveal.side_hash,
        confidence_bucket: reveal.confidence_bucket,
        committed_at_slot,
        user_salt: reveal.user_salt,
    };
    if commit_hash(&reconstructed) != *commitment_hash {
        return Err(PredictionError::HashMismatch);
    }
    Ok(())
}

/// Returns true when committed_at_slot is strictly before event_slot.
pub fn is_pre_event(committed_at_slot: u64, event_slot: u64) -> bool {
    committed_at_slot < event_slot
}

#[derive(Clone, Debug)]
pub struct LeaderboardEntry {
    pub commitment_hash: [u8; 32],
    pub revealed: bool,
    pub score_points: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_commitment() -> PredictionCommitment {
        PredictionCommitment {
            market_hash: [0x01u8; 32],
            side_hash: [0x02u8; 32],
            confidence_bucket: 5,
            committed_at_slot: 200,
            user_salt: [0xAAu8; 32],
        }
    }

    fn reveal_from(c: &PredictionCommitment) -> PredictionReveal {
        PredictionReveal {
            market_hash: c.market_hash,
            side_hash: c.side_hash,
            confidence_bucket: c.confidence_bucket,
            user_salt: c.user_salt,
        }
    }

    #[test]
    fn test_commit_reveal_roundtrip() {
        let c = make_commitment();
        let h = commit_hash(&c);
        let r = reveal_from(&c);
        verify_reveal(&h, &r, c.committed_at_slot).unwrap();
    }

    #[test]
    fn test_wrong_side_fails() {
        let c = make_commitment();
        let h = commit_hash(&c);
        let mut r = reveal_from(&c);
        r.side_hash = [0xFFu8; 32]; // wrong side
        let err = verify_reveal(&h, &r, c.committed_at_slot).unwrap_err();
        assert_eq!(err, PredictionError::HashMismatch);
    }

    #[test]
    fn test_late_commit_not_scored() {
        // A commit at slot 1000 is NOT pre-event if event is at slot 999
        let event_slot = 999u64;
        let late_slot = 1000u64;
        assert!(!is_pre_event(late_slot, event_slot));
    }

    #[test]
    fn test_commitment_deterministic() {
        let c = make_commitment();
        assert_eq!(commit_hash(&c), commit_hash(&c));
    }

    #[test]
    fn test_confidence_bucket_preserved() {
        let c = make_commitment();
        let h = commit_hash(&c);
        let r = reveal_from(&c);
        // Verify succeeds only if confidence_bucket matches
        let mut r_bad = r.clone();
        r_bad.confidence_bucket = 99;
        assert!(verify_reveal(&h, &r_bad, c.committed_at_slot).is_err());
        assert!(verify_reveal(&h, &r, c.committed_at_slot).is_ok());
    }

    #[test]
    fn test_pre_event_check() {
        assert!(is_pre_event(100, 500));
        assert!(!is_pre_event(500, 500));
        assert!(!is_pre_event(600, 500));
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_commit_hash_nonzero() {
        let c = make_commitment();
        assert_ne!(commit_hash(&c), [0u8; 32]);
    }

    #[test]
    fn test_different_market_hash_different_commit() {
        let c = make_commitment();
        let mut c2 = c.clone();
        c2.market_hash = [0xFFu8; 32];
        assert_ne!(commit_hash(&c), commit_hash(&c2));
    }

    #[test]
    fn test_different_user_salt_different_commit() {
        let c = make_commitment();
        let mut c2 = c.clone();
        c2.user_salt = [0xBBu8; 32];
        assert_ne!(commit_hash(&c), commit_hash(&c2));
    }

    #[test]
    fn test_wrong_market_fails_reveal() {
        let c = make_commitment();
        let h = commit_hash(&c);
        let mut r = reveal_from(&c);
        r.market_hash = [0xEEu8; 32];
        assert_eq!(
            verify_reveal(&h, &r, c.committed_at_slot),
            Err(PredictionError::HashMismatch)
        );
    }

    #[test]
    fn test_wrong_salt_fails_reveal() {
        let c = make_commitment();
        let h = commit_hash(&c);
        let mut r = reveal_from(&c);
        r.user_salt = [0xCCu8; 32];
        assert_eq!(
            verify_reveal(&h, &r, c.committed_at_slot),
            Err(PredictionError::HashMismatch)
        );
    }

    #[test]
    fn test_wrong_slot_fails_reveal() {
        let c = make_commitment();
        let h = commit_hash(&c);
        let r = reveal_from(&c);
        // Wrong committed_at_slot
        assert_eq!(
            verify_reveal(&h, &r, 999),
            Err(PredictionError::HashMismatch)
        );
    }

    #[test]
    fn test_pre_event_well_before_true() {
        assert!(is_pre_event(0, 1_000_000));
    }

    #[test]
    fn test_leaderboard_entry_fields() {
        let h = [0xAAu8; 32];
        let entry = LeaderboardEntry {
            commitment_hash: h,
            revealed: false,
            score_points: 100,
        };
        assert!(!entry.revealed);
        assert_eq!(entry.score_points, 100);
        assert_eq!(entry.commitment_hash, h);
    }

    #[test]
    fn test_commit_hash_confidence_sensitive() {
        let c = make_commitment();
        let mut c2 = c.clone();
        c2.confidence_bucket = 99;
        assert_ne!(commit_hash(&c), commit_hash(&c2));
    }

    #[test]
    fn test_commit_hash_slot_sensitive() {
        let c = make_commitment();
        let mut c2 = c.clone();
        c2.committed_at_slot = 9999;
        assert_ne!(commit_hash(&c), commit_hash(&c2));
    }
}
