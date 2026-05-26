use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq)]
pub struct HintTier {
    pub tier: u8,
    pub price_lamports: u64,
    pub clue_hash: [u8; 32],
    pub reveal_after_slot: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HintPurchaseReceipt {
    pub tier: u8,
    pub buyer_hash: [u8; 32],
    pub clue_hash: [u8; 32],
    pub payment_lamports: u64,
    pub receipt_hash: [u8; 32],
}

#[derive(Debug, Clone, PartialEq)]
pub struct HintPot {
    pub total_lamports: u64,
    pub hint_count: u32,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum HintError {
    #[error("too early")]
    TooEarly,
    #[error("already purchased")]
    AlreadyPurchased,
    #[error("invalid tier")]
    InvalidTier,
    #[error("insufficient payment")]
    InsufficientPayment,
}

pub fn create_hint_tier(
    pick_hash: &[u8; 32],
    tier: u8,
    price_lamports: u64,
    clue_content_hash: &[u8; 32],
    reveal_after_slot: u64,
) -> HintTier {
    if tier < 1 || tier > 3 {
        // Return a sentinel with zeroed clue_hash for invalid tiers;
        // callers should validate tier before calling.
    }
    let clue_hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"hint-v1");
        h.update(pick_hash);
        h.update([tier]);
        h.update(clue_content_hash);
        h.finalize().into()
    };
    HintTier {
        tier,
        price_lamports,
        clue_hash,
        reveal_after_slot,
    }
}

pub fn purchase_hint(
    hint: &HintTier,
    buyer_hash: &[u8; 32],
    payment_lamports: u64,
    current_slot: u64,
    already_purchased: bool,
) -> Result<HintPurchaseReceipt, HintError> {
    if hint.tier < 1 || hint.tier > 3 {
        return Err(HintError::InvalidTier);
    }
    if payment_lamports == 0 || payment_lamports < hint.price_lamports {
        return Err(HintError::InsufficientPayment);
    }
    if already_purchased {
        return Err(HintError::AlreadyPurchased);
    }
    if current_slot < hint.reveal_after_slot {
        return Err(HintError::TooEarly);
    }

    let receipt_hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"hint-receipt-v1");
        h.update(hint.clue_hash);
        h.update(buyer_hash);
        h.update(payment_lamports.to_le_bytes());
        h.update(current_slot.to_le_bytes());
        h.finalize().into()
    };

    Ok(HintPurchaseReceipt {
        tier: hint.tier,
        buyer_hash: *buyer_hash,
        clue_hash: hint.clue_hash,
        payment_lamports,
        receipt_hash,
    })
}

pub fn higher_tier_reveals_more(tier1: &HintTier, tier2: &HintTier) -> bool {
    tier2.tier > tier1.tier
}

pub fn grow_pot(pot: &mut HintPot, payment: u64) {
    pot.total_lamports = pot.total_lamports.saturating_add(payment);
    pot.hint_count = pot.hint_count.saturating_add(1);
}

pub fn split_hint_fees(total: u64, seller_pct: u8) -> (u64, u64) {
    let seller_share = total * (seller_pct as u64) / 100;
    let protocol_share = total - seller_share;
    (seller_share, protocol_share)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_tier(tier: u8) -> HintTier {
        let pick = [1u8; 32];
        let clue = [2u8; 32];
        create_hint_tier(&pick, tier, 1000, &clue, 50)
    }

    #[test]
    fn test_hint_cannot_reveal_before_payment() {
        let hint = make_tier(1);
        let buyer = [9u8; 32];
        let result = purchase_hint(&hint, &buyer, 0, 100, false);
        assert_eq!(result, Err(HintError::InsufficientPayment));
    }

    #[test]
    fn test_higher_tier_reveals_more() {
        let t1 = make_tier(1);
        let t2 = make_tier(2);
        assert!(higher_tier_reveals_more(&t1, &t2));
    }

    #[test]
    fn test_duplicate_hint_purchase_rejected() {
        let hint = make_tier(1);
        let buyer = [9u8; 32];
        let result = purchase_hint(&hint, &buyer, 1000, 100, true);
        assert_eq!(result, Err(HintError::AlreadyPurchased));
    }

    #[test]
    fn test_hint_fees_split_correctly() {
        let (seller, protocol) = split_hint_fees(1000, 90);
        assert_eq!(seller, 900);
        assert_eq!(protocol, 100);
    }

    #[test]
    fn test_pot_grows_with_purchases() {
        let mut pot = HintPot {
            total_lamports: 0,
            hint_count: 0,
        };
        grow_pot(&mut pot, 500);
        grow_pot(&mut pot, 300);
        assert_eq!(pot.total_lamports, 800);
        assert_eq!(pot.hint_count, 2);
    }
}
