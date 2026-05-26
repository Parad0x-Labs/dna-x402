use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Human-readable intent that the user, wallet, and program all commit to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct IntentCapsule {
    /// Plain-English action (e.g. "buy 100 API calls").
    pub action: String,
    /// Maximum spend in lamports.
    pub max_spend_lamports: u64,
    /// SHA-256 of the x402 service scope string.
    pub service_scope_hash: [u8; 32],
    /// Solana slot after which this intent is invalid.
    pub expiry_slot: u64,
    /// Whether the agent may withdraw to arbitrary wallets.
    pub no_withdraw: bool,
    /// Optional receipt root after the action executes.
    pub receipt_root_after: Option<[u8; 32]>,
}

/// Canonical digest of the intent for on-chain verification.
pub fn intent_hash(c: &IntentCapsule) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(c.action.as_bytes());
    h.update(&c.max_spend_lamports.to_le_bytes());
    h.update(&c.service_scope_hash);
    h.update(&c.expiry_slot.to_le_bytes());
    h.update(&[c.no_withdraw as u8]);
    if let Some(root) = &c.receipt_root_after {
        h.update(root);
    }
    h.finalize().into()
}

/// Render the capsule as a human-readable JSON string (for wallet display).
pub fn render(c: &IntentCapsule) -> String {
    serde_json::to_string_pretty(c).unwrap()
}

/// Parse capsule from JSON; verify its hash matches `expected_hash`.
pub fn verify_from_json(
    json: &str,
    expected_hash: &[u8; 32],
) -> Result<IntentCapsule, &'static str> {
    let c: IntentCapsule = serde_json::from_str(json).map_err(|_| "parse error")?;
    if &intent_hash(&c) != expected_hash {
        return Err("hash mismatch");
    }
    Ok(c)
}

/// Check if an intent has expired.
pub fn is_expired(c: &IntentCapsule, current_slot: u64) -> bool {
    current_slot > c.expiry_slot
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> IntentCapsule {
        IntentCapsule {
            action: "buy 100 API calls".to_string(),
            max_spend_lamports: 500_000,
            service_scope_hash: [0xAAu8; 32],
            expiry_slot: 9999,
            no_withdraw: false,
            receipt_root_after: None,
        }
    }

    #[test]
    fn test_hash_deterministic() {
        let c = sample();
        assert_eq!(intent_hash(&c), intent_hash(&c));
    }

    #[test]
    fn test_hash_changes_on_field_mutation() {
        let base = sample();
        let base_hash = intent_hash(&base);

        let cases = [
            IntentCapsule {
                action: "other".to_string(),
                ..base.clone()
            },
            IntentCapsule {
                max_spend_lamports: 1,
                ..base.clone()
            },
            IntentCapsule {
                service_scope_hash: [0xBBu8; 32],
                ..base.clone()
            },
            IntentCapsule {
                expiry_slot: 1,
                ..base.clone()
            },
            IntentCapsule {
                no_withdraw: true,
                ..base.clone()
            },
            IntentCapsule {
                receipt_root_after: Some([0xCCu8; 32]),
                ..base.clone()
            },
        ];
        for c in &cases {
            assert_ne!(
                base_hash,
                intent_hash(c),
                "hash did not change for mutated capsule: {:?}",
                c
            );
        }
    }

    #[test]
    fn test_render_is_valid_json() {
        let c = sample();
        let json = render(&c);
        let parsed: serde_json::Value =
            serde_json::from_str(&json).expect("render output is not valid JSON");
        assert!(parsed.is_object());
    }

    #[test]
    fn test_verify_from_json_ok() {
        let c = sample();
        let hash = intent_hash(&c);
        let json = render(&c);
        let result = verify_from_json(&json, &hash);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), c);
    }

    #[test]
    fn test_verify_from_json_tampered() {
        let c = sample();
        let hash = intent_hash(&c);
        // Replace action in the JSON with a different value
        let json = render(&c);
        let tampered = json.replace("buy 100 API calls", "buy 999 API calls");
        let result = verify_from_json(&tampered, &hash);
        assert_eq!(result, Err("hash mismatch"));
    }

    #[test]
    fn test_is_expired_before_slot() {
        let c = sample(); // expiry_slot = 9999
        assert!(!is_expired(&c, 9999)); // at expiry exactly → not expired
        assert!(!is_expired(&c, 100));
    }

    #[test]
    fn test_is_expired_after_slot() {
        let c = sample(); // expiry_slot = 9999
        assert!(is_expired(&c, 10_000));
    }
}
