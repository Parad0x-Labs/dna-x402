use sha2::{Digest, Sha256};
use std::collections::HashSet;

// Domain prefixes
const DOMAIN_NULLIFIER: u8 = 0x30;
const DOMAIN_CLAIM: u8 = 0x31;
const DOMAIN_CLAWBACK: u8 = 0x32;

#[derive(Clone, Debug)]
pub struct GiftNote {
    pub gift_id: [u8; 32],
    pub amount_lamports: u64,
    pub asset_mint: [u8; 32],
    pub message_hash: [u8; 32],
    pub expires_at_slot: u64,
    pub sender_commitment: [u8; 32],
    /// When Some, only this hash can claim.
    pub recipient_binding: Option<[u8; 32]>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GiftError {
    Expired,
    NotYetExpired,
    AlreadyClaimed,
    WrongRecipient,
}

/// SHA256(0x30 || gift_id || amount_lamports || asset_mint)
pub fn gift_nullifier(note: &GiftNote) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([DOMAIN_NULLIFIER]);
    h.update(note.gift_id);
    h.update(note.amount_lamports.to_le_bytes());
    h.update(note.asset_mint);
    h.finalize().into()
}

/// Stateless claim: checks expiry + optional recipient binding, returns claim receipt.
pub fn claim(
    note: &GiftNote,
    claimer_hash: &[u8; 32],
    current_slot: u64,
) -> Result<[u8; 32], GiftError> {
    if current_slot > note.expires_at_slot {
        return Err(GiftError::Expired);
    }
    if let Some(bound) = note.recipient_binding {
        if *claimer_hash != bound {
            return Err(GiftError::WrongRecipient);
        }
    }
    let mut h = Sha256::new();
    h.update([DOMAIN_CLAIM]);
    h.update(gift_nullifier(note));
    h.update(claimer_hash);
    Ok(h.finalize().into())
}

/// Stateless clawback: allowed only after expiry. Returns clawback receipt.
pub fn clawback(
    note: &GiftNote,
    sender_secret: &[u8; 32],
    current_slot: u64,
) -> Result<[u8; 32], GiftError> {
    if current_slot <= note.expires_at_slot {
        return Err(GiftError::NotYetExpired);
    }
    let mut h = Sha256::new();
    h.update([DOMAIN_CLAWBACK]);
    h.update(gift_nullifier(note));
    h.update(sender_secret);
    Ok(h.finalize().into())
}

/// Tracks which gift nullifiers have been claimed.
#[derive(Clone, Debug, Default)]
pub struct GiftRedemptionLog {
    pub claimed: HashSet<[u8; 32]>,
}

impl GiftRedemptionLog {
    pub fn new() -> Self {
        Self {
            claimed: HashSet::new(),
        }
    }

    pub fn claim(
        &mut self,
        note: &GiftNote,
        claimer_hash: &[u8; 32],
        current_slot: u64,
    ) -> Result<[u8; 32], GiftError> {
        let nullifier = gift_nullifier(note);
        if self.claimed.contains(&nullifier) {
            return Err(GiftError::AlreadyClaimed);
        }
        let receipt = claim(note, claimer_hash, current_slot)?;
        self.claimed.insert(nullifier);
        Ok(receipt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_note() -> GiftNote {
        GiftNote {
            gift_id: [0x10u8; 32],
            amount_lamports: 1_000_000,
            asset_mint: [0x20u8; 32],
            message_hash: [0x30u8; 32],
            expires_at_slot: 2000,
            sender_commitment: [0x40u8; 32],
            recipient_binding: None,
        }
    }

    #[test]
    fn test_claim_ok() {
        let note = make_note();
        let mut log = GiftRedemptionLog::new();
        let claimer = [0xBBu8; 32];
        let receipt = log.claim(&note, &claimer, 1000).unwrap();
        assert_ne!(receipt, [0u8; 32]);
    }

    #[test]
    fn test_clawback_after_expiry() {
        let note = make_note(); // expires_at_slot = 2000
        let sender_secret = [0xCCu8; 32];
        let receipt = clawback(&note, &sender_secret, 2001).unwrap();
        assert_ne!(receipt, [0u8; 32]);
    }

    #[test]
    fn test_clawback_before_expiry_fails() {
        let note = make_note();
        let sender_secret = [0xCCu8; 32];
        let err = clawback(&note, &sender_secret, 2000).unwrap_err();
        assert_eq!(err, GiftError::NotYetExpired);
    }

    #[test]
    fn test_double_claim_rejected() {
        let note = make_note();
        let mut log = GiftRedemptionLog::new();
        let claimer = [0xBBu8; 32];
        log.claim(&note, &claimer, 1000).unwrap();
        let err = log.claim(&note, &claimer, 1001).unwrap_err();
        assert_eq!(err, GiftError::AlreadyClaimed);
    }

    #[test]
    fn test_wrong_recipient() {
        let mut note = make_note();
        let bound_recipient = [0xAAu8; 32];
        note.recipient_binding = Some(bound_recipient);
        let wrong_claimer = [0xBBu8; 32];
        let err = claim(&note, &wrong_claimer, 1000).unwrap_err();
        assert_eq!(err, GiftError::WrongRecipient);
    }

    #[test]
    fn test_gift_nullifier_unique() {
        let note1 = make_note();
        let mut note2 = make_note();
        note2.gift_id = [0x11u8; 32];
        assert_ne!(gift_nullifier(&note1), gift_nullifier(&note2));
    }
}
