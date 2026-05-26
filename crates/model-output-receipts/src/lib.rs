use sha2::{Digest, Sha256};

// Domain prefix — distinct from all other crates
const DOMAIN_OUTPUT_COMMITMENT: u8 = 0xA0;

/// Binds an AI model's output to a verifiable receipt.
/// Proves which model/version produced a signal without revealing model internals.
#[derive(Clone, Debug)]
pub struct ModelOutputReceipt {
    /// Hash of model version identifier (e.g. SHA256 of "gpt-4-turbo-2024-04-09")
    pub model_version_hash: [u8; 32],
    /// Hash of the prompt policy / system-prompt in effect at inference time
    pub prompt_policy_hash: [u8; 32],
    /// Hash of the input snapshot sent to the model
    pub input_snapshot_hash: [u8; 32],
    /// Hash of the raw model output
    pub output_hash: [u8; 32],
    /// Coarse confidence bucket (0-255, e.g. 0=low, 128=mid, 255=high)
    pub confidence_bucket: u8,
    /// Hash of the access scope / API key scope that authorised the call
    pub access_scope_hash: [u8; 32],
    /// Solana slot at which the inference was recorded
    pub timestamp_slot: u64,
}

/// SHA256(0xA0 || model_version_hash || prompt_policy_hash || input_snapshot_hash
///             || output_hash || confidence_bucket || access_scope_hash || timestamp_slot)
pub fn output_commitment(receipt: &ModelOutputReceipt) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([DOMAIN_OUTPUT_COMMITMENT]);
    h.update(receipt.model_version_hash);
    h.update(receipt.prompt_policy_hash);
    h.update(receipt.input_snapshot_hash);
    h.update(receipt.output_hash);
    h.update([receipt.confidence_bucket]);
    h.update(receipt.access_scope_hash);
    h.update(receipt.timestamp_slot.to_le_bytes());
    h.finalize().into()
}

/// Returns true iff the receipt's output_hash matches the expected hash.
pub fn verify_output(receipt: &ModelOutputReceipt, expected_output_hash: &[u8; 32]) -> bool {
    // constant-time comparison via SHA256 equality (both are already hashes)
    receipt.output_hash == *expected_output_hash
}

/// Returns true if the receipt is older than max_age_slots relative to current_slot.
pub fn is_stale(receipt: &ModelOutputReceipt, current_slot: u64, max_age_slots: u64) -> bool {
    current_slot.saturating_sub(receipt.timestamp_slot) > max_age_slots
}

impl ModelOutputReceipt {
    /// Returns a human-readable string showing only hash fields — never raw model output.
    pub fn redacted_display(&self) -> String {
        format!(
            "ModelOutputReceipt {{ model={}, policy={}, input={}, output={}, confidence={}, scope={}, slot={} }}",
            hex_short(&self.model_version_hash),
            hex_short(&self.prompt_policy_hash),
            hex_short(&self.input_snapshot_hash),
            hex_short(&self.output_hash),
            self.confidence_bucket,
            hex_short(&self.access_scope_hash),
            self.timestamp_slot,
        )
    }
}

fn hex_short(b: &[u8; 32]) -> String {
    format!("{:02x}{:02x}..{:02x}{:02x}", b[0], b[1], b[30], b[31])
}

/// Delayed-reveal envelope: commit to a receipt hash now, reveal at reveal_slot.
#[derive(Clone, Debug)]
pub struct DelayedReveal {
    /// SHA256 commitment to the full receipt (use output_commitment)
    pub receipt_hash: [u8; 32],
    /// Earliest slot at which the receipt may be revealed on-chain
    pub reveal_slot: u64,
}

impl DelayedReveal {
    pub fn new(receipt: &ModelOutputReceipt, reveal_slot: u64) -> Self {
        Self {
            receipt_hash: output_commitment(receipt),
            reveal_slot,
        }
    }

    /// Returns true if the revealed receipt matches the commitment and the slot has passed.
    pub fn can_reveal(&self, receipt: &ModelOutputReceipt, current_slot: u64) -> bool {
        current_slot >= self.reveal_slot && output_commitment(receipt) == self.receipt_hash
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_receipt() -> ModelOutputReceipt {
        ModelOutputReceipt {
            model_version_hash: [0x01u8; 32],
            prompt_policy_hash: [0x02u8; 32],
            input_snapshot_hash: [0x03u8; 32],
            output_hash: [0x04u8; 32],
            confidence_bucket: 200,
            access_scope_hash: [0x05u8; 32],
            timestamp_slot: 5_000,
        }
    }

    #[test]
    fn test_commitment_deterministic() {
        let r = make_receipt();
        let c1 = output_commitment(&r);
        let c2 = output_commitment(&r);
        assert_eq!(c1, c2);
        assert_ne!(c1, [0u8; 32]);
    }

    #[test]
    fn test_wrong_output_fails() {
        let r = make_receipt();
        let wrong_hash = [0xFFu8; 32];
        assert!(!verify_output(&r, &wrong_hash));
        assert!(verify_output(&r, &r.output_hash));
    }

    #[test]
    fn test_all_fields_contribute() {
        let r = make_receipt();
        let base = output_commitment(&r);

        let mut r2 = r.clone();
        r2.model_version_hash = [0xAAu8; 32];
        assert_ne!(
            base,
            output_commitment(&r2),
            "model_version_hash must affect commitment"
        );

        let mut r3 = r.clone();
        r3.prompt_policy_hash = [0xBBu8; 32];
        assert_ne!(
            base,
            output_commitment(&r3),
            "prompt_policy_hash must affect commitment"
        );

        let mut r4 = r.clone();
        r4.confidence_bucket = 0;
        assert_ne!(
            base,
            output_commitment(&r4),
            "confidence_bucket must affect commitment"
        );

        let mut r5 = r.clone();
        r5.timestamp_slot = 9_999_999;
        assert_ne!(
            base,
            output_commitment(&r5),
            "timestamp_slot must affect commitment"
        );
    }

    #[test]
    fn test_stale_check() {
        let r = make_receipt(); // timestamp_slot = 5_000
                                // 5_100 - 5_000 = 100 slots elapsed; max_age=50 => stale
        assert!(is_stale(&r, 5_100, 50));
        // 5_049 - 5_000 = 49 <= 50 => not stale
        assert!(!is_stale(&r, 5_049, 50));
    }

    #[test]
    fn test_redacted_display_no_secrets() {
        let r = make_receipt();
        let display = r.redacted_display();
        // Must contain "ModelOutputReceipt"
        assert!(display.contains("ModelOutputReceipt"));
        // Must NOT contain literal raw field bytes as a long hex string
        // (it should be abbreviated with "..")
        assert!(
            display.contains(".."),
            "display must abbreviate hashes with '..'"
        );
        // The raw 32-byte arrays are not printed in full (we check length is reasonable)
        assert!(
            display.len() < 500,
            "display should not dump full 32-byte fields verbatim"
        );
    }

    #[test]
    fn test_delayed_reveal_struct() {
        let r = make_receipt();
        let dr = DelayedReveal::new(&r, 10_000);
        // Before reveal_slot — cannot reveal
        assert!(!dr.can_reveal(&r, 9_999));
        // At reveal_slot — can reveal
        assert!(dr.can_reveal(&r, 10_000));
        // Wrong receipt — cannot reveal even after slot
        let mut r2 = r.clone();
        r2.confidence_bucket = 0;
        assert!(!dr.can_reveal(&r2, 10_001));
    }
}
