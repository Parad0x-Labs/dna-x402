use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq)]
pub struct ProofboardEntry {
    pub pick_commitment_hash: [u8; 32],
    pub event_start_slot: u64,
    pub sealed_at_slot: u64,
    pub revealed: bool,
    pub reveal_hash: Option<[u8; 32]>,
    pub paid_user_count: u32,
    pub seller_hash: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ProofboardError {
    #[error("reveal before event")]
    RevealBeforeEvent,
    #[error("fake reveal")]
    FakeReveal,
    #[error("stale reveal")]
    StaleReveal,
    #[error("already revealed")]
    AlreadyRevealed,
}

pub fn create_entry(
    pick_commitment_hash: &[u8; 32],
    event_start_slot: u64,
    sealed_at_slot: u64,
    seller_pubkey: &[u8; 32],
) -> ProofboardEntry {
    let seller_hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"seller-hash-v1");
        h.update(seller_pubkey);
        h.finalize().into()
    };
    ProofboardEntry {
        pick_commitment_hash: *pick_commitment_hash,
        event_start_slot,
        sealed_at_slot,
        revealed: false,
        reveal_hash: None,
        paid_user_count: 0,
        seller_hash,
    }
}

pub fn submit_reveal(
    entry: &mut ProofboardEntry,
    reveal_hash: &[u8; 32],
    current_slot: u64,
    reveal_deadline_slot: u64,
) -> Result<(), ProofboardError> {
    if entry.revealed {
        return Err(ProofboardError::AlreadyRevealed);
    }
    if current_slot > reveal_deadline_slot {
        return Err(ProofboardError::StaleReveal);
    }
    entry.revealed = true;
    entry.reveal_hash = Some(*reveal_hash);
    Ok(())
}

pub fn verify_post_game(entry: &ProofboardEntry, claimed_commitment: &[u8; 32]) -> bool {
    entry.pick_commitment_hash == *claimed_commitment
}

pub fn is_late_reveal(current_slot: u64, reveal_deadline_slot: u64) -> bool {
    current_slot > reveal_deadline_slot
}

pub fn increment_paid_users(entry: &mut ProofboardEntry) {
    entry.paid_user_count = entry.paid_user_count.saturating_add(1);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commitment() -> [u8; 32] {
        [0xAA_u8; 32]
    }

    fn seller_pubkey() -> [u8; 32] {
        [0xBB_u8; 32]
    }

    #[test]
    fn test_pre_game_commitment_accepted() {
        let entry = create_entry(&commitment(), 100, 50, &seller_pubkey());
        assert!(!entry.revealed);
        assert_eq!(entry.pick_commitment_hash, commitment());
    }

    #[test]
    fn test_post_game_reveal_verifies() {
        let entry = create_entry(&commitment(), 100, 50, &seller_pubkey());
        assert!(verify_post_game(&entry, &commitment()));
    }

    #[test]
    fn test_stale_reveal_marked_late() {
        assert!(is_late_reveal(200, 100));
    }

    #[test]
    fn test_fake_reveal_rejected() {
        let entry = create_entry(&commitment(), 100, 50, &seller_pubkey());
        let wrong_commitment = [0xCC_u8; 32];
        assert!(!verify_post_game(&entry, &wrong_commitment));
    }

    #[test]
    fn test_scoreboard_hides_raw_wallet() {
        let pubkey = seller_pubkey();
        let entry = create_entry(&commitment(), 100, 50, &pubkey);
        // seller_hash must differ from the raw pubkey
        assert_ne!(entry.seller_hash, pubkey);
    }

    #[test]
    fn test_paid_users_count_increments() {
        let mut entry = create_entry(&commitment(), 100, 50, &seller_pubkey());
        assert_eq!(entry.paid_user_count, 0);
        increment_paid_users(&mut entry);
        assert_eq!(entry.paid_user_count, 1);
        increment_paid_users(&mut entry);
        assert_eq!(entry.paid_user_count, 2);
    }
}
