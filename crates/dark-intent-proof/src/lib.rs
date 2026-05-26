use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum IntentType {
    Trade = 1,
    Vote = 2,
    Claim = 3,
    Abstain = 4,
}

impl IntentType {
    fn as_str(self) -> &'static str {
        match self {
            IntentType::Trade => "Trade",
            IntentType::Vote => "Vote",
            IntentType::Claim => "Claim",
            IntentType::Abstain => "Abstain",
        }
    }
}

pub struct IntentCommitment {
    /// SHA256("intent-commit-v1" || intent_bytes || nonce || committed_at_unix as i64 le)
    pub commitment_hash: [u8; 32],
    pub intent_type: IntentType,
    pub committed_at_unix: i64,
    pub reveal_after_unix: i64,
    /// Always false — mainnet deployment not yet enabled.
    pub mainnet_ready: bool,
}

pub struct IntentReveal {
    pub commitment_hash: [u8; 32],
    pub intent_bytes: Vec<u8>,
    pub nonce: [u8; 32],
    pub revealed_at_unix: i64,
}

#[derive(Debug)]
pub enum IntentError {
    TooEarlyToReveal { reveal_after: i64, current: i64 },
    RevealMismatch,
    EmptyIntent,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn compute_commitment(intent_bytes: &[u8], nonce: &[u8; 32], committed_at_unix: i64) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"intent-commit-v1");
    h.update(intent_bytes);
    h.update(nonce);
    h.update(committed_at_unix.to_le_bytes());
    h.finalize().into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Commit to an intent without revealing its contents.
///
/// Returns `Err(IntentError::EmptyIntent)` when `intent_bytes` is empty.
/// `mainnet_ready` is always set to `false`.
pub fn commit_intent(
    intent_bytes: &[u8],
    nonce: &[u8; 32],
    intent_type: IntentType,
    committed_at_unix: i64,
    reveal_after_unix: i64,
) -> Result<IntentCommitment, IntentError> {
    if intent_bytes.is_empty() {
        return Err(IntentError::EmptyIntent);
    }
    let commitment_hash = compute_commitment(intent_bytes, nonce, committed_at_unix);
    Ok(IntentCommitment {
        commitment_hash,
        intent_type,
        committed_at_unix,
        reveal_after_unix,
        mainnet_ready: false,
    })
}

/// Reveal a previously committed intent.
///
/// Returns `Err(IntentError::TooEarlyToReveal)` if `current_unix` is before
/// `commitment.reveal_after_unix`.  Returns `Err(IntentError::RevealMismatch)`
/// when the recomputed hash does not match the stored commitment.
pub fn reveal_intent(
    commitment: &IntentCommitment,
    intent_bytes: &[u8],
    nonce: &[u8; 32],
    current_unix: i64,
) -> Result<IntentReveal, IntentError> {
    if current_unix < commitment.reveal_after_unix {
        return Err(IntentError::TooEarlyToReveal {
            reveal_after: commitment.reveal_after_unix,
            current: current_unix,
        });
    }
    let recomputed = compute_commitment(intent_bytes, nonce, commitment.committed_at_unix);
    if recomputed != commitment.commitment_hash {
        return Err(IntentError::RevealMismatch);
    }
    Ok(IntentReveal {
        commitment_hash: commitment.commitment_hash,
        intent_bytes: intent_bytes.to_vec(),
        nonce: *nonce,
        revealed_at_unix: current_unix,
    })
}

/// Verify that a reveal matches its original commitment.
pub fn verify_reveal(commitment: &IntentCommitment, reveal: &IntentReveal) -> bool {
    let recomputed = compute_commitment(
        &reveal.intent_bytes,
        &reveal.nonce,
        commitment.committed_at_unix,
    );
    recomputed == commitment.commitment_hash
}

/// Return a JSON string safe for public broadcast.
/// Does NOT include `intent_bytes` (secret until after reveal window).
pub fn commitment_public_record(commitment: &IntentCommitment) -> String {
    serde_json::json!({
        "commitment_hash": hex(&commitment.commitment_hash),
        "intent_type": commitment.intent_type.as_str(),
        "committed_at_unix": commitment.committed_at_unix,
        "reveal_after_unix": commitment.reveal_after_unix,
        "mainnet_ready": commitment.mainnet_ready,
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const NONCE: [u8; 32] = [0xab; 32];
    const INTENT: &[u8] = b"buy 100 SOL at market";
    const T0: i64 = 1_700_000_000;
    const REVEAL_AFTER: i64 = T0 + 3600; // 1 hour later

    // 1. Happy path: commit then reveal after window.
    #[test]
    fn test_commit_reveal_happy_path() {
        let commitment = commit_intent(INTENT, &NONCE, IntentType::Trade, T0, REVEAL_AFTER)
            .expect("commit should succeed");
        assert!(!commitment.mainnet_ready);

        let reveal = reveal_intent(&commitment, INTENT, &NONCE, REVEAL_AFTER)
            .expect("reveal at exactly reveal_after_unix should succeed");
        assert_eq!(reveal.revealed_at_unix, REVEAL_AFTER);

        assert!(verify_reveal(&commitment, &reveal));
    }

    // 2. Reveal before reveal_after_unix is rejected.
    #[test]
    fn test_too_early_reveal_rejected() {
        let commitment = commit_intent(INTENT, &NONCE, IntentType::Trade, T0, REVEAL_AFTER)
            .expect("commit should succeed");

        let result = reveal_intent(&commitment, INTENT, &NONCE, REVEAL_AFTER - 1);
        match result {
            Err(IntentError::TooEarlyToReveal {
                reveal_after,
                current,
            }) => {
                assert_eq!(reveal_after, REVEAL_AFTER);
                assert_eq!(current, REVEAL_AFTER - 1);
            }
            _ => panic!("expected TooEarlyToReveal"),
        }
    }

    // 3. Reveal with tampered intent_bytes returns RevealMismatch.
    #[test]
    fn test_wrong_intent_fails_verify() {
        let commitment = commit_intent(INTENT, &NONCE, IntentType::Trade, T0, REVEAL_AFTER)
            .expect("commit should succeed");

        let result = reveal_intent(&commitment, b"sell 100 SOL at market", &NONCE, REVEAL_AFTER);
        match result {
            Err(IntentError::RevealMismatch) => {}
            _ => panic!("expected RevealMismatch"),
        }
    }

    // 4. Committing an empty intent returns EmptyIntent.
    #[test]
    fn test_empty_intent_rejected() {
        let result = commit_intent(b"", &NONCE, IntentType::Trade, T0, REVEAL_AFTER);
        match result {
            Err(IntentError::EmptyIntent) => {}
            _ => panic!("expected EmptyIntent"),
        }
    }

    // 5. The public record JSON does not leak the intent_bytes.
    #[test]
    fn test_commitment_hides_intent() {
        let commitment = commit_intent(INTENT, &NONCE, IntentType::Trade, T0, REVEAL_AFTER)
            .expect("commit should succeed");

        let record = commitment_public_record(&commitment);
        let intent_hex = hex(INTENT);

        // The raw UTF-8 string and the hex-encoded form must both be absent.
        assert!(
            !record.contains(std::str::from_utf8(INTENT).unwrap()),
            "public record must not contain raw intent bytes"
        );
        assert!(
            !record.contains(&intent_hex),
            "public record must not contain hex-encoded intent bytes"
        );

        // Sanity: the commitment hash IS present.
        assert!(record.contains(&hex(&commitment.commitment_hash)));
    }
}
