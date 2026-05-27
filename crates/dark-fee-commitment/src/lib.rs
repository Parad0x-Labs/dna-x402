// dark-fee-commitment — pre-commit to a fee amount without revealing agent identity
// or operation context. Commitment is published; reveal happens at settlement.
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false

use sha2::{Digest, Sha256};

// ── hex helper (no external hex crate) ─────────────────────────────────────

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ── Public types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct FeeCommitment {
    /// SHA256("fee-commit-v1" || amount_le || nonce)
    pub commitment_hash: [u8; 32],
    pub epoch: u64,
    pub expiry_slot: u64,
    /// Always false — devnet design only.
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FeeReveal {
    pub commitment_hash: [u8; 32],
    pub revealed_amount: u64,
    pub nonce: [u8; 32],
    pub settled_at_slot: u64,
}

#[derive(Debug, PartialEq)]
pub enum FeeCommitError {
    ZeroAmount,
    ExpiredCommitment,
    RevealMismatch,
    PrematureReveal {
        earliest_slot: u64,
        current_slot: u64,
    },
}

// ── Internal hash helper ────────────────────────────────────────────────────

fn hash_commitment(amount: u64, nonce: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"fee-commit-v1");
    h.update(amount.to_le_bytes());
    h.update(nonce);
    h.finalize().into()
}

// ── Public API ───────────────────────────────────────────────────────────────

/// Commit to a fee amount.
///
/// Returns ZeroAmount if amount == 0.
/// commitment_hash = SHA256("fee-commit-v1" || amount_le || nonce)
pub fn commit_fee(
    amount: u64,
    nonce: &[u8; 32],
    epoch: u64,
    expiry_slot: u64,
) -> Result<FeeCommitment, FeeCommitError> {
    if amount == 0 {
        return Err(FeeCommitError::ZeroAmount);
    }

    Ok(FeeCommitment {
        commitment_hash: hash_commitment(amount, nonce),
        epoch,
        expiry_slot,
        mainnet_ready: false,
    })
}

/// Reveal the committed fee at settlement time.
///
/// Returns ExpiredCommitment if current_slot > commitment.expiry_slot.
/// Returns RevealMismatch if the recomputed hash doesn't match the stored commitment.
pub fn reveal_fee(
    commitment: &FeeCommitment,
    amount: u64,
    nonce: &[u8; 32],
    current_slot: u64,
) -> Result<FeeReveal, FeeCommitError> {
    if current_slot > commitment.expiry_slot {
        return Err(FeeCommitError::ExpiredCommitment);
    }

    let recomputed = hash_commitment(amount, nonce);
    if recomputed != commitment.commitment_hash {
        return Err(FeeCommitError::RevealMismatch);
    }

    Ok(FeeReveal {
        commitment_hash: commitment.commitment_hash,
        revealed_amount: amount,
        nonce: *nonce,
        settled_at_slot: current_slot,
    })
}

/// Return a JSON representation of the commitment.
///
/// Emits: commitment_hash (hex), epoch, expiry_slot, mainnet_ready.
/// The amount is intentionally omitted — that is the whole point of a commitment.
pub fn commitment_json(commitment: &FeeCommitment) -> String {
    serde_json::json!({
        "commitment_hash": hex_encode(&commitment.commitment_hash),
        "epoch":           commitment.epoch,
        "expiry_slot":     commitment.expiry_slot,
        "mainnet_ready":   commitment.mainnet_ready,
    })
    .to_string()
}

/// Verify a reveal against a commitment by recomputing the hash.
pub fn verify_reveal(commitment: &FeeCommitment, reveal: &FeeReveal) -> bool {
    let recomputed = hash_commitment(reveal.revealed_amount, &reveal.nonce);
    recomputed == commitment.commitment_hash
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const NONCE: [u8; 32] = [0x33; 32];
    const EPOCH: u64 = 5;
    const EXPIRY: u64 = 1_000;

    // ── Test 1: happy path commit → reveal ───────────────────────────────

    #[test]
    fn test_commit_reveal_happy_path() {
        let amount = 1_000_000u64;
        let commitment =
            commit_fee(amount, &NONCE, EPOCH, EXPIRY).expect("commit_fee should succeed");

        assert!(
            !commitment.mainnet_ready,
            "mainnet_ready must always be false"
        );

        let reveal = reveal_fee(&commitment, amount, &NONCE, EXPIRY)
            .expect("reveal_fee should succeed at expiry slot");

        assert_eq!(reveal.revealed_amount, 1_000_000);
        assert_eq!(reveal.commitment_hash, commitment.commitment_hash);
        assert_eq!(reveal.settled_at_slot, EXPIRY);
    }

    // ── Test 2: zero amount rejected at commit time ───────────────────────

    #[test]
    fn test_zero_amount_rejected() {
        let result = commit_fee(0, &NONCE, EPOCH, EXPIRY);
        assert_eq!(result, Err(FeeCommitError::ZeroAmount));
    }

    // ── Test 3: reveal after expiry is rejected ───────────────────────────

    #[test]
    fn test_expired_reveal_rejected() {
        let commitment = commit_fee(1_000_000, &NONCE, EPOCH, EXPIRY).unwrap();
        // Reveal one slot after expiry.
        let result = reveal_fee(&commitment, 1_000_000, &NONCE, EXPIRY + 1);
        assert_eq!(result, Err(FeeCommitError::ExpiredCommitment));
    }

    // ── Test 4: wrong amount at reveal causes RevealMismatch ──────────────

    #[test]
    fn test_wrong_amount_reveal_rejected() {
        let committed_amount = 1_000_000u64;
        let commitment = commit_fee(committed_amount, &NONCE, EPOCH, EXPIRY).unwrap();

        // Attempt to reveal with a different amount.
        let result = reveal_fee(&commitment, committed_amount + 1, &NONCE, EXPIRY);
        assert_eq!(result, Err(FeeCommitError::RevealMismatch));
    }

    // ── Test 5: commitment_json must not contain the committed amount ──────

    #[test]
    fn test_commitment_json_hides_amount() {
        let amount = 1_000_000u64;
        let commitment = commit_fee(amount, &NONCE, EPOCH, EXPIRY).unwrap();
        let json = commitment_json(&commitment);

        // The amount "1000000" must not appear anywhere in the JSON.
        assert!(
            !json.contains("1000000"),
            "commitment_json must not contain the committed amount; got: {json}"
        );

        // Sanity: expected keys must be present.
        assert!(json.contains("commitment_hash"));
        assert!(json.contains("epoch"));
        assert!(json.contains("expiry_slot"));
        assert!(json.contains("mainnet_ready"));
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_commitment_hash_nonzero() {
        let c = commit_fee(100, &NONCE, EPOCH, EXPIRY).unwrap();
        assert_ne!(c.commitment_hash, [0u8; 32]);
    }

    #[test]
    fn test_commitment_hash_deterministic() {
        let c1 = commit_fee(100, &NONCE, EPOCH, EXPIRY).unwrap();
        let c2 = commit_fee(100, &NONCE, EPOCH, EXPIRY).unwrap();
        assert_eq!(c1.commitment_hash, c2.commitment_hash);
    }

    #[test]
    fn test_commitment_hash_amount_sensitive() {
        let c1 = commit_fee(100, &NONCE, EPOCH, EXPIRY).unwrap();
        let c2 = commit_fee(200, &NONCE, EPOCH, EXPIRY).unwrap();
        assert_ne!(c1.commitment_hash, c2.commitment_hash);
    }

    #[test]
    fn test_commitment_hash_nonce_sensitive() {
        let nonce2 = [0x44u8; 32];
        let c1 = commit_fee(100, &NONCE, EPOCH, EXPIRY).unwrap();
        let c2 = commit_fee(100, &nonce2, EPOCH, EXPIRY).unwrap();
        assert_ne!(c1.commitment_hash, c2.commitment_hash);
    }

    #[test]
    fn test_mainnet_ready_always_false() {
        let c = commit_fee(100, &NONCE, EPOCH, EXPIRY).unwrap();
        assert!(!c.mainnet_ready);
    }

    #[test]
    fn test_epoch_stored() {
        let c = commit_fee(100, &NONCE, 99, EXPIRY).unwrap();
        assert_eq!(c.epoch, 99);
    }

    #[test]
    fn test_expiry_slot_stored() {
        let c = commit_fee(100, &NONCE, EPOCH, 5555).unwrap();
        assert_eq!(c.expiry_slot, 5555);
    }

    #[test]
    fn test_verify_reveal_ok() {
        let amount = 777u64;
        let c = commit_fee(amount, &NONCE, EPOCH, EXPIRY).unwrap();
        let reveal = reveal_fee(&c, amount, &NONCE, 1).unwrap();
        assert!(verify_reveal(&c, &reveal));
    }

    #[test]
    fn test_verify_reveal_wrong_amount_fails() {
        let c = commit_fee(100, &NONCE, EPOCH, EXPIRY).unwrap();
        let reveal = FeeReveal {
            commitment_hash: c.commitment_hash,
            revealed_amount: 999, // wrong
            nonce: NONCE,
            settled_at_slot: 1,
        };
        assert!(!verify_reveal(&c, &reveal));
    }

    #[test]
    fn test_reveal_at_exact_expiry_ok() {
        let c = commit_fee(100, &NONCE, EPOCH, EXPIRY).unwrap();
        // current_slot == expiry_slot: check is `current_slot > expiry`, so == is valid
        let result = reveal_fee(&c, 100, &NONCE, EXPIRY);
        assert!(result.is_ok());
    }

    #[test]
    fn test_reveal_nonce_sensitive() {
        let c = commit_fee(100, &NONCE, EPOCH, EXPIRY).unwrap();
        let wrong_nonce = [0x44u8; 32];
        let result = reveal_fee(&c, 100, &wrong_nonce, 1);
        assert_eq!(result, Err(FeeCommitError::RevealMismatch));
    }
}
