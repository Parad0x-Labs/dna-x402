use sha2::{Digest, Sha256};
use std::collections::HashSet;

// Domain prefixes — keep distinct so hashes never collide across roles
const DOMAIN_COMMITMENT: u8 = 0x10;
const DOMAIN_NULLIFIER: u8 = 0x11;
const DOMAIN_REDEEM: u8 = 0x12;

#[derive(Clone, Debug)]
pub struct TipNote {
    pub secret: [u8; 32],
    pub amount_bucket: u8,
    pub asset_mint: [u8; 32],
    pub message_hash: [u8; 32],
    pub expires_at_slot: u64,
    pub campaign_hash: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TipError {
    Expired,
    AlreadyRedeemed,
    WrongRecipient,
}

/// SHA256(0x10 || secret || amount_bucket || asset_mint || message_hash || expires_at_slot || campaign_hash)
pub fn note_commitment(note: &TipNote) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([DOMAIN_COMMITMENT]);
    h.update(note.secret);
    h.update([note.amount_bucket]);
    h.update(note.asset_mint);
    h.update(note.message_hash);
    h.update(note.expires_at_slot.to_le_bytes());
    h.update(note.campaign_hash);
    h.finalize().into()
}

/// SHA256(0x11 || secret || amount_bucket || campaign_hash)
/// Uses a different domain AND fewer fields than commitment — unlinkable by construction.
pub fn note_nullifier(note: &TipNote) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([DOMAIN_NULLIFIER]);
    h.update(note.secret);
    h.update([note.amount_bucket]);
    h.update(note.campaign_hash);
    h.finalize().into()
}

/// Stateless redeem check: verifies expiry and returns a receipt hash.
/// Double-redeem detection is handled by TipRedemptionLog.
pub fn redeem(
    note: &TipNote,
    recipient_hash: &[u8; 32],
    current_slot: u64,
) -> Result<[u8; 32], TipError> {
    if current_slot > note.expires_at_slot {
        return Err(TipError::Expired);
    }
    // Bind receipt to recipient so receipts can't be transferred
    let mut h = Sha256::new();
    h.update([DOMAIN_REDEEM]);
    h.update(note_nullifier(note));
    h.update(recipient_hash);
    Ok(h.finalize().into())
}

/// Tracks which nullifiers have already been redeemed.
#[derive(Clone, Debug, Default)]
pub struct TipRedemptionLog {
    pub nullifiers: HashSet<[u8; 32]>,
}

impl TipRedemptionLog {
    pub fn new() -> Self {
        Self {
            nullifiers: HashSet::new(),
        }
    }

    pub fn redeem(
        &mut self,
        note: &TipNote,
        recipient_hash: &[u8; 32],
        current_slot: u64,
    ) -> Result<[u8; 32], TipError> {
        if current_slot > note.expires_at_slot {
            return Err(TipError::Expired);
        }
        let nullifier = note_nullifier(note);
        if self.nullifiers.contains(&nullifier) {
            return Err(TipError::AlreadyRedeemed);
        }
        let receipt = redeem(note, recipient_hash, current_slot)?;
        self.nullifiers.insert(nullifier);
        Ok(receipt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_note() -> TipNote {
        TipNote {
            secret: [1u8; 32],
            amount_bucket: 3,
            asset_mint: [2u8; 32],
            message_hash: [3u8; 32],
            expires_at_slot: 1000,
            campaign_hash: [4u8; 32],
        }
    }

    #[test]
    fn test_redeem_ok() {
        let note = make_note();
        let recipient = [9u8; 32];
        let mut log = TipRedemptionLog::new();
        let receipt = log.redeem(&note, &recipient, 500).unwrap();
        assert_ne!(receipt, [0u8; 32]);
    }

    #[test]
    fn test_expired() {
        let note = make_note(); // expires_at_slot = 1000
        let recipient = [9u8; 32];
        let mut log = TipRedemptionLog::new();
        let err = log.redeem(&note, &recipient, 1001).unwrap_err();
        assert_eq!(err, TipError::Expired);
    }

    #[test]
    fn test_double_redeem() {
        let note = make_note();
        let recipient = [9u8; 32];
        let mut log = TipRedemptionLog::new();
        log.redeem(&note, &recipient, 500).unwrap();
        let err = log.redeem(&note, &recipient, 501).unwrap_err();
        assert_eq!(err, TipError::AlreadyRedeemed);
    }

    #[test]
    fn test_nullifier_unlinkable_from_secret() {
        // Nullifier must NOT be derivable from commitment alone (different hash inputs)
        let note = make_note();
        let commitment = note_commitment(&note);
        let nullifier = note_nullifier(&note);
        // They share the same secret but must differ due to domain + field selection
        assert_ne!(commitment, nullifier);
        // Changing just the message_hash changes commitment but NOT nullifier
        let mut note2 = note.clone();
        note2.message_hash = [0xAAu8; 32];
        let commitment2 = note_commitment(&note2);
        let nullifier2 = note_nullifier(&note2);
        assert_ne!(commitment, commitment2); // commitment changes
        assert_eq!(nullifier, nullifier2); // nullifier unchanged — unlinkable
    }

    #[test]
    fn test_commitment_changes_with_amount_bucket() {
        let note = make_note();
        let mut note2 = note.clone();
        note2.amount_bucket = 7;
        assert_ne!(note_commitment(&note), note_commitment(&note2));
    }

    #[test]
    fn test_campaign_hash_bound() {
        let note = make_note();
        let mut note2 = note.clone();
        note2.campaign_hash = [0xFFu8; 32];
        // Both commitment and nullifier must change when campaign_hash changes
        assert_ne!(note_commitment(&note), note_commitment(&note2));
        assert_ne!(note_nullifier(&note), note_nullifier(&note2));
    }
}
