use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

pub struct HedgeCommitment {
    /// 0 or 1
    pub party_id: u8,
    /// SHA256("hedge-v1" || [party_id] || outcome_bytes || nonce)
    pub outcome_commitment: [u8; 32],
    pub stake_lamports: u64,
    pub epoch: u64,
    /// Always false — mainnet deployment not yet enabled.
    pub mainnet_ready: bool,
}

pub struct HedgeMatch {
    /// SHA256("match-v1" || party_a.commitment || party_b.commitment || epoch_le)
    pub match_id: [u8; 32],
    pub party_a: HedgeCommitment,
    pub party_b: HedgeCommitment,
    pub epoch: u64,
    pub resolved: bool,
    pub winner_party_id: Option<u8>,
}

pub struct HedgeReceipt {
    pub match_id: [u8; 32],
    pub winner_party_id: u8,
    /// SHA256("hedge-reveal-v1" || outcome_bytes)
    pub winner_outcome_hash: [u8; 32],
    pub stake_lamports: u64,
    pub mainnet_ready: bool,
}

#[derive(Debug)]
pub enum HedgeError {
    SamePartyId,
    EpochMismatch,
    StakeMismatch,
    AlreadyResolved,
    NotWinner { claimed: u8, actual: u8 },
    CommitmentMismatch,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn compute_outcome_commitment(party_id: u8, outcome_bytes: &[u8], nonce: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"hedge-v1");
    h.update([party_id]);
    h.update(outcome_bytes);
    h.update(nonce);
    h.finalize().into()
}

fn compute_match_id(commitment_a: &[u8; 32], commitment_b: &[u8; 32], epoch: u64) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"match-v1");
    h.update(commitment_a);
    h.update(commitment_b);
    h.update(epoch.to_le_bytes());
    h.finalize().into()
}

fn compute_reveal_hash(outcome_bytes: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"hedge-reveal-v1");
    h.update(outcome_bytes);
    h.finalize().into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Create a blinded commitment for one party.
/// `mainnet_ready` is always `false`.
pub fn create_commitment(
    party_id: u8,
    outcome_bytes: &[u8],
    nonce: &[u8; 32],
    stake_lamports: u64,
    epoch: u64,
) -> HedgeCommitment {
    let outcome_commitment = compute_outcome_commitment(party_id, outcome_bytes, nonce);
    HedgeCommitment {
        party_id,
        outcome_commitment,
        stake_lamports,
        epoch,
        mainnet_ready: false,
    }
}

/// Pair two commitments into a match.
///
/// Errors:
/// - `SamePartyId`  — both parties share the same id.
/// - `EpochMismatch` — epochs differ.
/// - `StakeMismatch` — stakes differ.
pub fn create_match(
    party_a: HedgeCommitment,
    party_b: HedgeCommitment,
) -> Result<HedgeMatch, HedgeError> {
    if party_a.party_id == party_b.party_id {
        return Err(HedgeError::SamePartyId);
    }
    if party_a.epoch != party_b.epoch {
        return Err(HedgeError::EpochMismatch);
    }
    if party_a.stake_lamports != party_b.stake_lamports {
        return Err(HedgeError::StakeMismatch);
    }
    let epoch = party_a.epoch;
    let match_id = compute_match_id(
        &party_a.outcome_commitment,
        &party_b.outcome_commitment,
        epoch,
    );
    Ok(HedgeMatch {
        match_id,
        party_a,
        party_b,
        epoch,
        resolved: false,
        winner_party_id: None,
    })
}

/// Resolve a match by verifying the winning party's revealed outcome.
///
/// Errors:
/// - `AlreadyResolved`     — match was already resolved.
/// - `NotWinner`           — `winner_party_id` does not match either party.
/// - `CommitmentMismatch`  — recomputed commitment does not match stored one.
pub fn resolve_match(
    hedge: &mut HedgeMatch,
    winner_party_id: u8,
    outcome_bytes: &[u8],
    nonce: &[u8; 32],
) -> Result<HedgeReceipt, HedgeError> {
    if hedge.resolved {
        return Err(HedgeError::AlreadyResolved);
    }

    // Find the party that claims to be the winner.
    let winner = if hedge.party_a.party_id == winner_party_id {
        &hedge.party_a
    } else if hedge.party_b.party_id == winner_party_id {
        &hedge.party_b
    } else {
        // Neither party has that id — return NotWinner with party_a's id as
        // the "actual" representative (convention: report party_a's id).
        return Err(HedgeError::NotWinner {
            claimed: winner_party_id,
            actual: hedge.party_a.party_id,
        });
    };

    // Verify the outcome commitment.
    let recomputed = compute_outcome_commitment(winner_party_id, outcome_bytes, nonce);
    if recomputed != winner.outcome_commitment {
        return Err(HedgeError::CommitmentMismatch);
    }

    let stake_lamports = winner.stake_lamports;
    let match_id = hedge.match_id;

    hedge.resolved = true;
    hedge.winner_party_id = Some(winner_party_id);

    Ok(HedgeReceipt {
        match_id,
        winner_party_id,
        winner_outcome_hash: compute_reveal_hash(outcome_bytes),
        stake_lamports,
        mainnet_ready: false,
    })
}

/// Return a JSON string safe for public broadcast.
/// Does NOT include `outcome_bytes` or nonces (private until resolution).
pub fn match_public_record(hedge: &HedgeMatch) -> String {
    let winner = match hedge.winner_party_id {
        Some(id) => serde_json::Value::Number(id.into()),
        None => serde_json::Value::Null,
    };
    serde_json::json!({
        "match_id": hex(&hedge.match_id),
        "epoch": hedge.epoch,
        "resolved": hedge.resolved,
        "winner_party_id": winner,
        "mainnet_ready": false,
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const NONCE_A: [u8; 32] = [0x11; 32];
    const NONCE_B: [u8; 32] = [0x22; 32];
    const OUTCOME_A: &[u8] = b"YES";
    const OUTCOME_B: &[u8] = b"NO";
    const STAKE: u64 = 5_000_000_000; // 5 SOL in lamports
    const EPOCH: u64 = 42;

    fn make_pair() -> (HedgeCommitment, HedgeCommitment) {
        let a = create_commitment(0, OUTCOME_A, &NONCE_A, STAKE, EPOCH);
        let b = create_commitment(1, OUTCOME_B, &NONCE_B, STAKE, EPOCH);
        (a, b)
    }

    // 1. Full happy path: commit, match, resolve with party A winning.
    #[test]
    fn test_match_and_resolve_happy_path() {
        let (a, b) = make_pair();
        let mut hedge = create_match(a, b).expect("create_match should succeed");

        let receipt =
            resolve_match(&mut hedge, 0, OUTCOME_A, &NONCE_A).expect("resolve should succeed");

        assert_eq!(receipt.winner_party_id, 0);
        assert_eq!(receipt.stake_lamports, STAKE);
        assert!(!receipt.mainnet_ready);
        assert!(hedge.resolved);
        assert_eq!(hedge.winner_party_id, Some(0));
    }

    // 2. Same party id on both sides is rejected.
    #[test]
    fn test_same_party_id_rejected() {
        let a = create_commitment(0, OUTCOME_A, &NONCE_A, STAKE, EPOCH);
        let b = create_commitment(0, OUTCOME_B, &NONCE_B, STAKE, EPOCH);
        match create_match(a, b) {
            Err(HedgeError::SamePartyId) => {}
            _ => panic!("expected SamePartyId"),
        }
    }

    // 3. Mismatched epochs are rejected.
    #[test]
    fn test_epoch_mismatch_rejected() {
        let a = create_commitment(0, OUTCOME_A, &NONCE_A, STAKE, 1);
        let b = create_commitment(1, OUTCOME_B, &NONCE_B, STAKE, 2);
        match create_match(a, b) {
            Err(HedgeError::EpochMismatch) => {}
            _ => panic!("expected EpochMismatch"),
        }
    }

    // 4. Wrong outcome bytes at resolution returns CommitmentMismatch.
    #[test]
    fn test_wrong_outcome_fails_resolution() {
        let (a, b) = make_pair();
        let mut hedge = create_match(a, b).expect("create_match should succeed");
        match resolve_match(&mut hedge, 0, b"MAYBE", &NONCE_A) {
            Err(HedgeError::CommitmentMismatch) => {}
            _ => panic!("expected CommitmentMismatch"),
        }
    }

    // 5. Resolving an already-resolved match is rejected.
    #[test]
    fn test_double_resolve_rejected() {
        let (a, b) = make_pair();
        let mut hedge = create_match(a, b).expect("create_match should succeed");
        resolve_match(&mut hedge, 0, OUTCOME_A, &NONCE_A).expect("first resolve should succeed");
        match resolve_match(&mut hedge, 0, OUTCOME_A, &NONCE_A) {
            Err(HedgeError::AlreadyResolved) => {}
            _ => panic!("expected AlreadyResolved"),
        }
    }

    // 6. The public record does not leak outcome bytes.
    #[test]
    fn test_public_record_hides_outcomes() {
        let (a, b) = make_pair();
        let hedge = create_match(a, b).expect("create_match should succeed");
        let record = match_public_record(&hedge);

        let outcome_a_hex = hex(OUTCOME_A);
        let outcome_b_hex = hex(OUTCOME_B);

        // Raw UTF-8 forms must be absent.
        assert!(
            !record.contains(std::str::from_utf8(OUTCOME_A).unwrap()),
            "public record must not contain raw outcome A"
        );
        assert!(
            !record.contains(std::str::from_utf8(OUTCOME_B).unwrap()),
            "public record must not contain raw outcome B"
        );
        // Hex-encoded forms must also be absent.
        assert!(
            !record.contains(&outcome_a_hex),
            "public record must not contain hex outcome A"
        );
        assert!(
            !record.contains(&outcome_b_hex),
            "public record must not contain hex outcome B"
        );

        // Sanity: the match_id IS present.
        assert!(record.contains(&hex(&hedge.match_id)));
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_outcome_commitment_nonzero() {
        let c = create_commitment(0, OUTCOME_A, &NONCE_A, STAKE, EPOCH);
        assert_ne!(c.outcome_commitment, [0u8; 32]);
    }

    #[test]
    fn test_mainnet_ready_false_commitment() {
        let c = create_commitment(0, OUTCOME_A, &NONCE_A, STAKE, EPOCH);
        assert!(!c.mainnet_ready);
    }

    #[test]
    fn test_match_id_nonzero() {
        let (a, b) = make_pair();
        let hedge = create_match(a, b).unwrap();
        assert_ne!(hedge.match_id, [0u8; 32]);
    }

    #[test]
    fn test_resolved_false_initially() {
        let (a, b) = make_pair();
        let hedge = create_match(a, b).unwrap();
        assert!(!hedge.resolved);
    }

    #[test]
    fn test_winner_party_id_none_initially() {
        let (a, b) = make_pair();
        let hedge = create_match(a, b).unwrap();
        assert!(hedge.winner_party_id.is_none());
    }

    #[test]
    fn test_receipt_mainnet_ready_false() {
        let (a, b) = make_pair();
        let mut hedge = create_match(a, b).unwrap();
        let receipt = resolve_match(&mut hedge, 0, OUTCOME_A, &NONCE_A).unwrap();
        assert!(!receipt.mainnet_ready);
    }

    #[test]
    fn test_receipt_match_id_matches_hedge() {
        let (a, b) = make_pair();
        let mut hedge = create_match(a, b).unwrap();
        let mid = hedge.match_id;
        let receipt = resolve_match(&mut hedge, 0, OUTCOME_A, &NONCE_A).unwrap();
        assert_eq!(receipt.match_id, mid);
    }

    #[test]
    fn test_stake_mismatch_rejected() {
        let a = create_commitment(0, OUTCOME_A, &NONCE_A, 1_000, EPOCH);
        let b = create_commitment(1, OUTCOME_B, &NONCE_B, 2_000, EPOCH);
        assert!(matches!(create_match(a, b), Err(HedgeError::StakeMismatch)));
    }

    #[test]
    fn test_different_outcomes_different_commitments() {
        let c1 = create_commitment(0, b"OUTCOME_X", &NONCE_A, STAKE, EPOCH);
        let c2 = create_commitment(0, b"OUTCOME_Y", &NONCE_A, STAKE, EPOCH);
        assert_ne!(c1.outcome_commitment, c2.outcome_commitment);
    }

    #[test]
    fn test_match_public_record_fields() {
        let (a, b) = make_pair();
        let hedge = create_match(a, b).unwrap();
        let record = match_public_record(&hedge);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["match_id"].is_string());
        assert_eq!(v["resolved"], false);
        assert_eq!(v["mainnet_ready"], false);
        assert_eq!(v["epoch"], EPOCH);
    }
}
