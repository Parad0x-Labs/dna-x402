use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Private helper
// ---------------------------------------------------------------------------

fn sha256_domain(domain: &[u8], inputs: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(domain);
    for input in inputs {
        h.update(input);
    }
    h.finalize().into()
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum SoulTransferPolicy {
    Transferable,
    RecipientBound { recipient_hash: [u8; 32] },
    OneHopOnly,
    SoulboundAfterClaim,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum SoulRedemptionPolicy {
    StandardSpend,
    BurnAfterRead,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ReceiptSoul {
    pub soul_id_hash: [u8; 32],
    pub scope_hash: [u8; 32],
    pub amount_bucket: u64, // opaque bucket, not exact amount
    pub issuer_hash: [u8; 32],
    pub expiry_slot: u64,
    pub transfer_policy: SoulTransferPolicy,
    pub redemption_policy: SoulRedemptionPolicy,
    pub current_holder_hash: [u8; 32],
    pub transfer_count: u32,
    pub redeemed: bool,
}

impl ReceiptSoul {
    /// SHA256("dark_null_v1_receipt_soul" || soul_id_hash || scope_hash || issuer_hash)
    /// NOTE: issuer_hash is NOT in the public nullifier, only in soul_hash
    pub fn soul_hash(&self) -> [u8; 32] {
        sha256_domain(
            b"dark_null_v1_receipt_soul",
            &[&self.soul_id_hash, &self.scope_hash, &self.issuer_hash],
        )
    }
}

/// A spend nullifier derived from the soul — does NOT reveal issuer_hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SoulNullifier(pub [u8; 32]);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SoulError {
    AlreadyRedeemed,
    TransferDenied,
    WrongRecipient,
    OneHopExhausted,
    Soulbound,
    Expired,
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/// Check if the soul has expired.
pub fn is_expired(soul: &ReceiptSoul, current_slot: u64) -> bool {
    current_slot > soul.expiry_slot
}

/// Transfer the soul to a new holder.
/// Returns a new ReceiptSoul with updated current_holder_hash and incremented transfer_count.
/// Enforces all transfer policy rules.
pub fn transfer_soul(
    soul: &ReceiptSoul,
    new_holder_hash: [u8; 32],
    current_slot: u64,
) -> Result<ReceiptSoul, SoulError> {
    if is_expired(soul, current_slot) {
        return Err(SoulError::Expired);
    }

    if soul.redeemed {
        return Err(SoulError::AlreadyRedeemed);
    }

    match &soul.transfer_policy {
        SoulTransferPolicy::Transferable => {
            // Always allowed (not expired, not redeemed — already checked above)
        }
        SoulTransferPolicy::RecipientBound { recipient_hash } => {
            if new_holder_hash != *recipient_hash {
                return Err(SoulError::WrongRecipient);
            }
        }
        SoulTransferPolicy::OneHopOnly => {
            if soul.transfer_count != 0 {
                return Err(SoulError::OneHopExhausted);
            }
        }
        SoulTransferPolicy::SoulboundAfterClaim => {
            // If redeemed=true, deny transfer — already checked above (redeemed -> AlreadyRedeemed)
            // If not yet redeemed, transfer is denied unconditionally (soulbound)
            return Err(SoulError::Soulbound);
        }
    }

    let mut new_soul = soul.clone();
    new_soul.current_holder_hash = new_holder_hash;
    new_soul.transfer_count += 1;
    Ok(new_soul)
}

/// Redeem the soul (spend it).
/// Returns a SoulNullifier and the spent soul (with redeemed=true).
/// The nullifier does NOT include issuer_hash — so it cannot reveal issuer identity.
pub fn redeem_soul(
    soul: &ReceiptSoul,
    holder_hash: [u8; 32],
    current_slot: u64,
) -> Result<(SoulNullifier, ReceiptSoul), SoulError> {
    if is_expired(soul, current_slot) {
        return Err(SoulError::Expired);
    }

    if soul.redeemed {
        return Err(SoulError::AlreadyRedeemed);
    }

    // Compute the nullifier — issuer_hash is NOT included
    let nullifier_bytes = sha256_domain(
        b"dark_null_v1_soul_nullifier",
        &[
            &soul.soul_id_hash,
            &holder_hash,
            &soul.expiry_slot.to_le_bytes(),
        ],
    );
    let nullifier = SoulNullifier(nullifier_bytes);

    let mut spent_soul = soul.clone();
    spent_soul.redeemed = true;

    Ok((nullifier, spent_soul))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_soul(policy: SoulTransferPolicy) -> ReceiptSoul {
        ReceiptSoul {
            soul_id_hash: [0x01u8; 32],
            scope_hash: [0x02u8; 32],
            amount_bucket: 1,
            issuer_hash: [0xFFu8; 32], // secret issuer
            expiry_slot: 9999,
            transfer_policy: policy,
            redemption_policy: SoulRedemptionPolicy::StandardSpend,
            current_holder_hash: [0xAAu8; 32],
            transfer_count: 0,
            redeemed: false,
        }
    }

    #[test]
    fn test_transferable_soul_can_move() {
        let soul = make_soul(SoulTransferPolicy::Transferable);
        let new_holder = [0xBBu8; 32];
        let result = transfer_soul(&soul, new_holder, 100);
        assert!(result.is_ok());
        let moved = result.unwrap();
        assert_eq!(moved.current_holder_hash, new_holder);
        assert_eq!(moved.transfer_count, 1);
    }

    #[test]
    fn test_recipient_bound_rejects_wrong() {
        let soul = make_soul(SoulTransferPolicy::RecipientBound {
            recipient_hash: [0xBBu8; 32],
        });
        let result = transfer_soul(&soul, [0xCCu8; 32], 100);
        assert!(matches!(result, Err(SoulError::WrongRecipient)));
    }

    #[test]
    fn test_recipient_bound_accepts_correct() {
        let soul = make_soul(SoulTransferPolicy::RecipientBound {
            recipient_hash: [0xBBu8; 32],
        });
        let result = transfer_soul(&soul, [0xBBu8; 32], 100);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().current_holder_hash, [0xBBu8; 32]);
    }

    #[test]
    fn test_one_hop_rejects_second_transfer() {
        let soul = make_soul(SoulTransferPolicy::OneHopOnly);
        // First transfer: count is 0 → should succeed
        let moved = transfer_soul(&soul, [0xBBu8; 32], 100).unwrap();
        assert_eq!(moved.transfer_count, 1);
        // Second transfer: count is 1 → OneHopExhausted
        let result = transfer_soul(&moved, [0xCCu8; 32], 100);
        assert!(matches!(result, Err(SoulError::OneHopExhausted)));
    }

    #[test]
    fn test_burn_after_read_rejects_second_redeem() {
        let mut soul = make_soul(SoulTransferPolicy::Transferable);
        soul.redemption_policy = SoulRedemptionPolicy::BurnAfterRead;

        // First redeem → Ok
        let holder = [0xAAu8; 32];
        let result = redeem_soul(&soul, holder, 100);
        assert!(result.is_ok());
        let (_, spent_soul) = result.unwrap();
        assert!(spent_soul.redeemed);

        // Second redeem on spent soul → AlreadyRedeemed
        let result2 = redeem_soul(&spent_soul, holder, 100);
        assert!(matches!(result2, Err(SoulError::AlreadyRedeemed)));
    }

    #[test]
    fn test_same_soul_cannot_redeem_twice() {
        let soul = make_soul(SoulTransferPolicy::Transferable);
        let holder = [0xAAu8; 32];

        // First redeem → Ok
        let (_, spent_soul) = redeem_soul(&soul, holder, 100).unwrap();
        assert!(spent_soul.redeemed);

        // Second redeem → AlreadyRedeemed
        let result = redeem_soul(&spent_soul, holder, 100);
        assert!(matches!(result, Err(SoulError::AlreadyRedeemed)));
    }

    #[test]
    fn test_nullifier_does_not_reveal_issuer() {
        let holder = [0xAAu8; 32];
        let expiry = 9999u64;

        // Soul A: issuer = [0xFF; 32]
        let soul_a = ReceiptSoul {
            soul_id_hash: [0x01u8; 32],
            scope_hash: [0x02u8; 32],
            amount_bucket: 1,
            issuer_hash: [0xFFu8; 32],
            expiry_slot: expiry,
            transfer_policy: SoulTransferPolicy::Transferable,
            redemption_policy: SoulRedemptionPolicy::StandardSpend,
            current_holder_hash: holder,
            transfer_count: 0,
            redeemed: false,
        };

        // Soul B: same everything except issuer_hash
        let soul_b = ReceiptSoul {
            issuer_hash: [0x11u8; 32], // different issuer
            ..soul_a.clone()
        };

        let (nullifier_a, _) = redeem_soul(&soul_a, holder, 100).unwrap();
        let (nullifier_b, _) = redeem_soul(&soul_b, holder, 100).unwrap();

        // Nullifiers must be the same — issuer is not in preimage
        assert_eq!(nullifier_a, nullifier_b);

        // The nullifier bytes should not start with the issuer bytes
        let issuer_prefix = &[0xFFu8; 4];
        assert_ne!(&nullifier_a.0[..4], issuer_prefix.as_ref());
    }

    #[test]
    fn test_expired_soul_cannot_transfer() {
        let soul = make_soul(SoulTransferPolicy::Transferable);
        // current_slot > expiry_slot (9999)
        let result = transfer_soul(&soul, [0xBBu8; 32], 10000);
        assert!(matches!(result, Err(SoulError::Expired)));
    }

    #[test]
    fn test_expired_soul_cannot_redeem() {
        let soul = make_soul(SoulTransferPolicy::Transferable);
        // current_slot > expiry_slot (9999)
        let result = redeem_soul(&soul, [0xAAu8; 32], 10000);
        assert!(matches!(result, Err(SoulError::Expired)));
    }
}
