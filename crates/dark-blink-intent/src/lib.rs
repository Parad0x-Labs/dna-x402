use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const DOMAIN_BLINK: u8 = 0x50;

fn short_hex(b: &[u8]) -> String {
    b.iter().take(4).map(|x| format!("{:02x}", x)).collect()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum BlinkActionType {
    GrantAgentPermission,
    MintReceiptNote,
    JoinShapePool,
    CloseChaffForBounty,
    DecodeShardRitual,
    BuyApiCalls,
    ClaimComputeCoupon,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DarkBlinkIntent {
    pub blink_id: [u8; 32],
    pub action_type: BlinkActionType,
    pub human_title: String,
    pub human_description: String,
    pub max_spend_lamports: u64,
    pub expires_at_slot: u64,
    pub receipt_hash: [u8; 32],
    pub intent_capsule_hash: [u8; 32],
}

impl DarkBlinkIntent {
    pub fn intent_hash(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update([DOMAIN_BLINK]);
        h.update(&self.blink_id);
        let ab: u8 = match &self.action_type {
            BlinkActionType::GrantAgentPermission => 0,
            BlinkActionType::MintReceiptNote => 1,
            BlinkActionType::JoinShapePool => 2,
            BlinkActionType::CloseChaffForBounty => 3,
            BlinkActionType::DecodeShardRitual => 4,
            BlinkActionType::BuyApiCalls => 5,
            BlinkActionType::ClaimComputeCoupon => 6,
        };
        h.update([ab]);
        h.update(self.human_title.as_bytes());
        h.update(self.human_description.as_bytes());
        h.update(self.max_spend_lamports.to_le_bytes());
        h.update(self.expires_at_slot.to_le_bytes());
        h.update(&self.receipt_hash);
        h.update(&self.intent_capsule_hash);
        h.finalize().into()
    }

    pub fn is_expired(&self, current_slot: u64) -> bool {
        current_slot >= self.expires_at_slot
    }

    pub fn redacted_display(&self) -> String {
        format!(
            "[DarkBlink id={}... action={:?} expires={} max_spend={}]",
            short_hex(&self.blink_id),
            self.action_type,
            self.expires_at_slot,
            self.max_spend_lamports
        )
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_default()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum BlinkError {
    Expired,
    SpendExceedsMax,
    IntentHashMismatch,
}

pub fn validate_blink(
    intent: &DarkBlinkIntent,
    current_slot: u64,
    proposed_spend: u64,
) -> Result<[u8; 32], BlinkError> {
    if intent.is_expired(current_slot) {
        return Err(BlinkError::Expired);
    }
    if proposed_spend > intent.max_spend_lamports {
        return Err(BlinkError::SpendExceedsMax);
    }
    Ok(intent.intent_hash())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_intent() -> DarkBlinkIntent {
        DarkBlinkIntent {
            blink_id: [1u8; 32],
            action_type: BlinkActionType::BuyApiCalls,
            human_title: "Buy 100 API calls".to_string(),
            human_description: "Purchase a batch of 100 API calls for the Dark Null agent"
                .to_string(),
            max_spend_lamports: 1_000_000,
            expires_at_slot: 1000,
            receipt_hash: [2u8; 32],
            intent_capsule_hash: [3u8; 32],
        }
    }

    #[test]
    fn test_intent_hash_stable() {
        let intent = make_intent();
        let h1 = intent.intent_hash();
        let h2 = intent.intent_hash();
        assert_eq!(h1, h2);
        assert_ne!(h1, [0u8; 32]);
    }

    #[test]
    fn test_title_change_changes_hash() {
        let intent1 = make_intent();
        let mut intent2 = make_intent();
        intent2.human_title = "Different title".to_string();
        assert_ne!(intent1.intent_hash(), intent2.intent_hash());
    }

    #[test]
    fn test_expired() {
        let intent = make_intent(); // expires_at_slot = 1000
        assert!(!intent.is_expired(999));
        assert!(intent.is_expired(1000));
        assert!(intent.is_expired(1001));

        let result = validate_blink(&intent, 1000, 500_000);
        assert_eq!(result, Err(BlinkError::Expired));
    }

    #[test]
    fn test_spend_exceeds_max() {
        let intent = make_intent(); // max_spend_lamports = 1_000_000
        let result = validate_blink(&intent, 500, 1_000_001);
        assert_eq!(result, Err(BlinkError::SpendExceedsMax));
    }

    #[test]
    fn test_json_roundtrip() {
        let intent = make_intent();
        let json = intent.to_json();
        assert!(!json.is_empty());
        let decoded: DarkBlinkIntent = serde_json::from_str(&json).expect("JSON roundtrip failed");
        assert_eq!(decoded.blink_id, intent.blink_id);
        assert_eq!(decoded.action_type, intent.action_type);
        assert_eq!(decoded.max_spend_lamports, intent.max_spend_lamports);
        assert_eq!(decoded.intent_hash(), intent.intent_hash());
    }

    #[test]
    fn test_redacted_display_no_secrets() {
        let intent = make_intent();
        let display = intent.redacted_display();
        // Should contain partial id, action, slot, spend — not raw 32-byte arrays
        assert!(display.contains("DarkBlink"));
        assert!(display.contains("BuyApiCalls"));
        assert!(display.contains("1000"));
        assert!(display.contains("1000000"));
        // Must not contain full 32-byte hex of blink_id
        let full_hex: String = intent
            .blink_id
            .iter()
            .map(|x| format!("{:02x}", x))
            .collect();
        assert!(!display.contains(&full_hex));
    }

    #[test]
    fn test_action_type_affects_hash() {
        let mut intent_a = make_intent();
        let mut intent_b = make_intent();
        intent_a.action_type = BlinkActionType::GrantAgentPermission;
        intent_b.action_type = BlinkActionType::ClaimComputeCoupon;
        assert_ne!(intent_a.intent_hash(), intent_b.intent_hash());
    }

    #[test]
    fn test_validate_blink_ok() {
        let intent = make_intent();
        let result = validate_blink(&intent, 500, 500_000);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), intent.intent_hash());
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_blink_id_change_changes_hash() {
        let intent1 = make_intent();
        let mut intent2 = make_intent();
        intent2.blink_id = [0xFFu8; 32];
        assert_ne!(intent1.intent_hash(), intent2.intent_hash());
    }

    #[test]
    fn test_description_change_changes_hash() {
        let intent1 = make_intent();
        let mut intent2 = make_intent();
        intent2.human_description = "Totally different description".to_string();
        assert_ne!(intent1.intent_hash(), intent2.intent_hash());
    }

    #[test]
    fn test_max_spend_change_changes_hash() {
        let intent1 = make_intent();
        let mut intent2 = make_intent();
        intent2.max_spend_lamports = 999_999;
        assert_ne!(intent1.intent_hash(), intent2.intent_hash());
    }

    #[test]
    fn test_receipt_hash_sensitive() {
        let intent1 = make_intent();
        let mut intent2 = make_intent();
        intent2.receipt_hash = [0xFFu8; 32];
        assert_ne!(intent1.intent_hash(), intent2.intent_hash());
    }

    #[test]
    fn test_capsule_hash_sensitive() {
        let intent1 = make_intent();
        let mut intent2 = make_intent();
        intent2.intent_capsule_hash = [0xFFu8; 32];
        assert_ne!(intent1.intent_hash(), intent2.intent_hash());
    }

    #[test]
    fn test_not_expired_one_before_slot() {
        let intent = make_intent(); // expires_at_slot = 1000
        assert!(!intent.is_expired(999));
        assert!(validate_blink(&intent, 999, 100_000).is_ok());
    }

    #[test]
    fn test_validate_exact_spend_ok() {
        let intent = make_intent(); // max_spend_lamports = 1_000_000
        let result = validate_blink(&intent, 500, 1_000_000);
        assert!(result.is_ok());
    }

    #[test]
    fn test_all_action_types_distinct_hashes() {
        let types = [
            BlinkActionType::GrantAgentPermission,
            BlinkActionType::MintReceiptNote,
            BlinkActionType::JoinShapePool,
            BlinkActionType::CloseChaffForBounty,
            BlinkActionType::DecodeShardRitual,
            BlinkActionType::BuyApiCalls,
            BlinkActionType::ClaimComputeCoupon,
        ];
        let hashes: Vec<[u8; 32]> = types
            .iter()
            .map(|t| {
                let mut i = make_intent();
                i.action_type = t.clone();
                i.intent_hash()
            })
            .collect();
        // All hashes should be unique
        for i in 0..hashes.len() {
            for j in (i + 1)..hashes.len() {
                assert_ne!(hashes[i], hashes[j], "types {i} and {j} collide");
            }
        }
    }
}
