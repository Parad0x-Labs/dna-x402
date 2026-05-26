use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Private domain-hashing helper
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
// ConfidenceBucket
// ---------------------------------------------------------------------------

/// Confidence level 1 (low) to 5 (very high).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ConfidenceBucket(pub u8); // 1..=5

impl ConfidenceBucket {
    pub fn new(level: u8) -> Result<Self, CapsuleError> {
        if level >= 1 && level <= 5 {
            Ok(Self(level))
        } else {
            Err(CapsuleError::InvalidConfidence { level })
        }
    }
}

// ---------------------------------------------------------------------------
// AlphaCapsule
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AlphaCapsule {
    pub capsule_id: [u8; 32],
    pub market_hash: [u8; 32],
    /// SHA256("dark_null_v1_alpha_side" || side_bytes || salt)
    pub side_commitment: [u8; 32],
    pub confidence_bucket: ConfidenceBucket,
    pub model_hash: [u8; 32],
    pub odds_snapshot_hash: [u8; 32],
    pub reveal_slot: u64,
    /// Who is authorized to receive the reveal.
    pub buyer_scope_hash: [u8; 32],
    pub transferable_before_reveal: bool,
}

impl AlphaCapsule {
    pub fn capsule_hash(&self) -> [u8; 32] {
        sha256_domain(
            b"dark_null_v1_alpha_capsule",
            &[
                self.capsule_id.as_ref(),
                self.market_hash.as_ref(),
                self.side_commitment.as_ref(),
                &[self.confidence_bucket.0],
                self.model_hash.as_ref(),
                self.odds_snapshot_hash.as_ref(),
                &self.reveal_slot.to_le_bytes(),
                self.buyer_scope_hash.as_ref(),
                &[self.transferable_before_reveal as u8],
            ],
        )
    }
}

// ---------------------------------------------------------------------------
// AlphaReveal
// ---------------------------------------------------------------------------

/// What the buyer provides to prove they know the side.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AlphaReveal {
    pub capsule_hash: [u8; 32],
    /// The actual side bytes (e.g. b"OVER", b"UNDER").
    pub side_preimage: Vec<u8>,
    pub salt: [u8; 32],
}

// ---------------------------------------------------------------------------
// OddsSnapshotCommitment
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct OddsSnapshotCommitment {
    pub market_hash: [u8; 32],
    pub odds_hash: [u8; 32],
    pub snapshot_slot: u64,
}

impl OddsSnapshotCommitment {
    pub fn commit(&self) -> [u8; 32] {
        sha256_domain(
            b"dark_null_v1_odds_snapshot",
            &[
                self.market_hash.as_ref(),
                self.odds_hash.as_ref(),
                &self.snapshot_slot.to_le_bytes(),
            ],
        )
    }
}

// ---------------------------------------------------------------------------
// ModelSignalCommitment
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ModelSignalCommitment {
    pub model_hash: [u8; 32],
    pub signal_hash: [u8; 32],
    pub commit_slot: u64,
}

// ---------------------------------------------------------------------------
// CapsuleError
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CapsuleError {
    TooEarly { reveal_at: u64, current: u64 },
    WrongReveal,
    WrongBuyerScope,
    InvalidConfidence { level: u8 },
    NotTransferableAfterReveal,
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/// Commit to a side: SHA256("dark_null_v1_alpha_side" || side_bytes || salt)
pub fn commit_side(side_bytes: &[u8], salt: &[u8; 32]) -> [u8; 32] {
    sha256_domain(b"dark_null_v1_alpha_side", &[side_bytes, salt.as_ref()])
}

/// Create a new capsule.
///
/// `capsule_id = SHA256("dark_null_v1_capsule_id" || market_hash || side_commitment || reveal_slot_le)`
pub fn new_capsule(
    market_hash: [u8; 32],
    side_commitment: [u8; 32],
    confidence_bucket: ConfidenceBucket,
    model_hash: [u8; 32],
    odds_snapshot_hash: [u8; 32],
    reveal_slot: u64,
    buyer_scope_hash: [u8; 32],
    transferable_before_reveal: bool,
) -> AlphaCapsule {
    let capsule_id = sha256_domain(
        b"dark_null_v1_capsule_id",
        &[
            market_hash.as_ref(),
            side_commitment.as_ref(),
            &reveal_slot.to_le_bytes(),
        ],
    );
    AlphaCapsule {
        capsule_id,
        market_hash,
        side_commitment,
        confidence_bucket,
        model_hash,
        odds_snapshot_hash,
        reveal_slot,
        buyer_scope_hash,
        transferable_before_reveal,
    }
}

/// Verify a reveal. Returns `Ok(())` if:
/// 1. `current_slot >= capsule.reveal_slot`
/// 2. `SHA256("dark_null_v1_alpha_side" || reveal.side_preimage || reveal.salt) == capsule.side_commitment`
pub fn verify_reveal(
    capsule: &AlphaCapsule,
    reveal: &AlphaReveal,
    current_slot: u64,
) -> Result<(), CapsuleError> {
    if current_slot < capsule.reveal_slot {
        return Err(CapsuleError::TooEarly {
            reveal_at: capsule.reveal_slot,
            current: current_slot,
        });
    }
    let computed = commit_side(&reveal.side_preimage, &reveal.salt);
    if computed != capsule.side_commitment {
        return Err(CapsuleError::WrongReveal);
    }
    Ok(())
}

/// Whether the capsule can be transferred at `current_slot`.
///
/// Returns `true` iff `transferable_before_reveal == true` AND `current_slot < reveal_slot`.
pub fn is_transferable(capsule: &AlphaCapsule, current_slot: u64) -> bool {
    capsule.transferable_before_reveal && current_slot < capsule.reveal_slot
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_capsule(reveal_slot: u64) -> (AlphaCapsule, [u8; 32], [u8; 32]) {
        let side = b"OVER";
        let salt = [0x99u8; 32];
        let side_commitment = commit_side(side, &salt);
        let capsule = new_capsule(
            [0x01u8; 32], // market_hash
            side_commitment,
            ConfidenceBucket(4),
            [0x02u8; 32], // model_hash
            [0x03u8; 32], // odds_snapshot_hash
            reveal_slot,
            [0x04u8; 32], // buyer_scope_hash
            true,
        );
        (capsule, side_commitment, salt)
    }

    fn make_reveal(capsule: &AlphaCapsule, side: &[u8], salt: &[u8; 32]) -> AlphaReveal {
        AlphaReveal {
            capsule_hash: capsule.capsule_hash(),
            side_preimage: side.to_vec(),
            salt: *salt,
        }
    }

    // 1. Reveal before slot is rejected.
    #[test]
    fn test_reveal_before_slot_rejected() {
        let (capsule, _, salt) = make_capsule(1000);
        let reveal = make_reveal(&capsule, b"OVER", &salt);
        let result = verify_reveal(&capsule, &reveal, 500);
        assert!(matches!(
            result,
            Err(CapsuleError::TooEarly {
                reveal_at: 1000,
                current: 500
            })
        ));
    }

    // 2. Correct reveal accepted at or after reveal_slot.
    #[test]
    fn test_correct_reveal_accepted() {
        let (capsule, _, salt) = make_capsule(1000);
        let reveal = make_reveal(&capsule, b"OVER", &salt);
        // Exactly at reveal_slot.
        assert!(verify_reveal(&capsule, &reveal, 1000).is_ok());
        // After reveal_slot.
        assert!(verify_reveal(&capsule, &reveal, 9999).is_ok());
    }

    // 3. Wrong side preimage is rejected.
    #[test]
    fn test_wrong_side_reveal_rejected() {
        let (capsule, _, salt) = make_capsule(1000);
        let reveal = make_reveal(&capsule, b"UNDER", &salt); // wrong side
        let result = verify_reveal(&capsule, &reveal, 1000);
        assert!(matches!(result, Err(CapsuleError::WrongReveal)));
    }

    // 4. Correct side but wrong salt is rejected.
    #[test]
    fn test_wrong_salt_rejected() {
        let (capsule, _, _) = make_capsule(1000);
        let bad_salt = [0x00u8; 32];
        let reveal = make_reveal(&capsule, b"OVER", &bad_salt);
        let result = verify_reveal(&capsule, &reveal, 1000);
        assert!(matches!(result, Err(CapsuleError::WrongReveal)));
    }

    // 5. OddsSnapshotCommitment.commit() changes when odds_hash changes.
    #[test]
    fn test_odds_snapshot_bound() {
        let base = OddsSnapshotCommitment {
            market_hash: [0x01u8; 32],
            odds_hash: [0xAAu8; 32],
            snapshot_slot: 500,
        };
        let changed = OddsSnapshotCommitment {
            odds_hash: [0xBBu8; 32],
            ..base.clone()
        };
        assert_ne!(base.commit(), changed.commit());
    }

    // 6. capsule_hash changes when model_hash changes.
    #[test]
    fn test_model_hash_bound() {
        let (capsule_a, side_commitment, _) = make_capsule(1000);
        let capsule_b = new_capsule(
            [0x01u8; 32],
            side_commitment,
            ConfidenceBucket(4),
            [0xFFu8; 32], // different model_hash
            [0x03u8; 32],
            1000,
            [0x04u8; 32],
            true,
        );
        assert_ne!(capsule_a.capsule_hash(), capsule_b.capsule_hash());
    }

    // 7. ConfidenceBucket(4) survives round-trip through capsule.
    #[test]
    fn test_confidence_bucket_preserved() {
        let (capsule, _, _) = make_capsule(1000);
        assert_eq!(capsule.confidence_bucket, ConfidenceBucket(4));
    }

    // 8. is_transferable returns true before reveal_slot and false at/after.
    #[test]
    fn test_transferable_before_reveal() {
        let (capsule, _, _) = make_capsule(1000);
        assert!(is_transferable(&capsule, 999));
        assert!(!is_transferable(&capsule, 1000));
        assert!(!is_transferable(&capsule, 1001));
    }

    // 9. ConfidenceBucket::new(6) returns Err(InvalidConfidence).
    #[test]
    fn test_invalid_confidence_rejected() {
        let result = ConfidenceBucket::new(6);
        assert!(matches!(
            result,
            Err(CapsuleError::InvalidConfidence { level: 6 })
        ));
        // Also check 0 is invalid.
        let result2 = ConfidenceBucket::new(0);
        assert!(matches!(
            result2,
            Err(CapsuleError::InvalidConfidence { level: 0 })
        ));
        // Valid boundary values.
        assert!(ConfidenceBucket::new(1).is_ok());
        assert!(ConfidenceBucket::new(5).is_ok());
    }

    // 10. Same inputs produce the same capsule_hash.
    #[test]
    fn test_capsule_hash_deterministic() {
        let (capsule_a, _, _) = make_capsule(1000);
        let (capsule_b, _, _) = make_capsule(1000);
        assert_eq!(capsule_a.capsule_hash(), capsule_b.capsule_hash());
    }
}
