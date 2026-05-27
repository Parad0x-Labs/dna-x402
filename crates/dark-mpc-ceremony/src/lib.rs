// dark-mpc-ceremony — simplified multi-party key generation ceremony
// Demonstrates a working n-of-m threshold commitment scheme using Ed25519-style
// domain-separated hashes.  Directly counters Paraloom's incomplete MPC ceremony
// (their repo has open TODOs).
//
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false

use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A single party's contribution to the MPC ceremony.
#[derive(Debug, Clone)]
pub struct PartyShare {
    pub party_id: u8,
    /// SHA256("mpc-share-v1" || party_id || epoch_le || entropy)
    pub commitment: [u8; 32],
    /// SHA256("mpc-pubkey-v1" || commitment)
    pub public_key_hash: [u8; 32],
}

/// The running state of one ceremony instance.
#[derive(Debug)]
pub struct CeremonyState {
    pub threshold: u8,
    pub n_parties: u8,
    pub epoch: u64,
    pub contributions: Vec<PartyShare>,
    pub final_key_hash: Option<[u8; 32]>,
    /// Always false — ceremony is for devnet/testnet only.
    pub mainnet_ready: bool,
}

/// Errors that can occur during a ceremony.
#[derive(Debug, PartialEq)]
pub enum CeremonyError {
    ThresholdNotMet { required: u8, present: u8 },
    DuplicateParty(u8),
    InvalidContribution,
    AlreadyFinalized,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Create a fresh ceremony state.  `mainnet_ready` is always `false`.
pub fn new_ceremony(threshold: u8, n_parties: u8, epoch: u64) -> CeremonyState {
    CeremonyState {
        threshold,
        n_parties,
        epoch,
        contributions: Vec::new(),
        final_key_hash: None,
        mainnet_ready: false,
    }
}

/// Generate a `PartyShare` from a party ID, the ceremony epoch, and 32 bytes of
/// private entropy.
///
/// * `commitment`      = `SHA256("mpc-share-v1"  || party_id || epoch_le || entropy)`
/// * `public_key_hash` = `SHA256("mpc-pubkey-v1" || commitment)`
///
/// The raw `entropy` is never stored; only the derived commitments are returned.
pub fn generate_party_share(party_id: u8, epoch: u64, entropy: &[u8; 32]) -> PartyShare {
    let commitment = {
        let mut h = Sha256::new();
        h.update(b"mpc-share-v1");
        h.update([party_id]);
        h.update(epoch.to_le_bytes());
        h.update(entropy);
        h.finalize().into()
    };

    let public_key_hash = {
        let mut h = Sha256::new();
        h.update(b"mpc-pubkey-v1");
        h.update(commitment);
        h.finalize().into()
    };

    PartyShare {
        party_id,
        commitment,
        public_key_hash,
    }
}

/// Add a party's share to the ceremony.
///
/// Returns `DuplicateParty` if the same `party_id` has already contributed.
pub fn contribute(state: &mut CeremonyState, share: PartyShare) -> Result<(), CeremonyError> {
    if state
        .contributions
        .iter()
        .any(|c| c.party_id == share.party_id)
    {
        return Err(CeremonyError::DuplicateParty(share.party_id));
    }
    state.contributions.push(share);
    Ok(())
}

/// Finalize the ceremony once the threshold has been reached.
///
/// Returns `ThresholdNotMet` if fewer than `threshold` contributions are present.
/// Returns `AlreadyFinalized` if the ceremony has already been finalized.
///
/// The final key hash is computed as:
/// `SHA256("mpc-final-v1" || epoch_le || XOR-fold of sorted commitments)`
///
/// Sorting the commitments before folding makes the result order-independent
/// (contributions may arrive in any order).
pub fn finalize_ceremony(state: &mut CeremonyState) -> Result<[u8; 32], CeremonyError> {
    if state.final_key_hash.is_some() {
        return Err(CeremonyError::AlreadyFinalized);
    }

    let present = state.contributions.len() as u8;
    if present < state.threshold {
        return Err(CeremonyError::ThresholdNotMet {
            required: state.threshold,
            present,
        });
    }

    // Collect and sort commitments for determinism.
    let mut sorted: Vec<[u8; 32]> = state.contributions.iter().map(|c| c.commitment).collect();
    sorted.sort_unstable();

    // XOR-fold the sorted commitments into a single 32-byte value.
    let mut xor_fold = [0u8; 32];
    for c in &sorted {
        for (a, b) in xor_fold.iter_mut().zip(c.iter()) {
            *a ^= b;
        }
    }

    let hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"mpc-final-v1");
        h.update(state.epoch.to_le_bytes());
        h.update(xor_fold);
        h.finalize().into()
    };

    state.final_key_hash = Some(hash);
    Ok(hash)
}

/// Serialize a summary of the ceremony state to JSON.
///
/// Raw entropy and secret shares are NEVER included.  Only public, derived
/// fields are exposed.
pub fn ceremony_to_json(state: &CeremonyState) -> String {
    let final_key_hex = state
        .final_key_hash
        .map(|h| hex_encode(&h))
        .unwrap_or_else(|| "pending".to_string());

    serde_json::json!({
        "threshold": state.threshold,
        "n_parties": state.n_parties,
        "epoch": state.epoch,
        "contribution_count": state.contributions.len(),
        "final_key_hash": final_key_hex,
        "mainnet_ready": state.mainnet_ready,
    })
    .to_string()
}

/// Verify that a `PartyShare` was produced from the given `party_id`, `epoch`,
/// and `entropy`.  Recomputes both derived fields and compares them.
pub fn verify_contribution(
    share: &PartyShare,
    party_id: u8,
    epoch: u64,
    entropy: &[u8; 32],
) -> bool {
    let expected = generate_party_share(party_id, epoch, entropy);
    share.commitment == expected.commitment && share.public_key_hash == expected.public_key_hash
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn entropy(byte: u8) -> [u8; 32] {
        [byte; 32]
    }

    // 1. Happy path: 3-of-5 ceremony, contribute 3 parties, finalize succeeds.
    #[test]
    fn test_ceremony_threshold_met() {
        let mut state = new_ceremony(3, 5, 1);

        for party_id in 0u8..3 {
            let share = generate_party_share(party_id, 1, &entropy(party_id + 1));
            contribute(&mut state, share).expect("contribute should succeed");
        }

        let result = finalize_ceremony(&mut state);
        assert!(result.is_ok(), "finalize should succeed with threshold met");
        assert!(state.final_key_hash.is_some());
        assert!(!state.mainnet_ready, "mainnet_ready must remain false");
    }

    // 2. Contribute 2 out of 3 required → ThresholdNotMet.
    #[test]
    fn test_threshold_not_met() {
        let mut state = new_ceremony(3, 5, 2);

        for party_id in 0u8..2 {
            let share = generate_party_share(party_id, 2, &entropy(party_id + 1));
            contribute(&mut state, share).unwrap();
        }

        let result = finalize_ceremony(&mut state);
        assert_eq!(
            result,
            Err(CeremonyError::ThresholdNotMet {
                required: 3,
                present: 2
            })
        );
    }

    // 3. Same party_id submitted twice → DuplicateParty.
    #[test]
    fn test_duplicate_party_rejected() {
        let mut state = new_ceremony(2, 3, 3);

        let share_a = generate_party_share(0, 3, &entropy(0xAA));
        contribute(&mut state, share_a).unwrap();

        let share_b = generate_party_share(0, 3, &entropy(0xBB)); // different entropy, same id
        let result = contribute(&mut state, share_b);
        assert_eq!(result, Err(CeremonyError::DuplicateParty(0)));
    }

    // 4. Same inputs always produce the same final_key_hash (determinism).
    #[test]
    fn test_final_key_deterministic() {
        let run = |epoch: u64| -> [u8; 32] {
            let mut state = new_ceremony(2, 3, epoch);
            for party_id in 0u8..2 {
                let share = generate_party_share(party_id, epoch, &entropy(party_id + 1));
                contribute(&mut state, share).unwrap();
            }
            finalize_ceremony(&mut state).unwrap()
        };

        let key1 = run(42);
        let key2 = run(42);
        assert_eq!(key1, key2, "same inputs must yield same final key hash");
    }

    // 5. JSON output must not contain the raw entropy bytes (hex-encoded or otherwise).
    #[test]
    fn test_ceremony_json_hides_entropy() {
        let ep: [u8; 32] = entropy(0xDE);
        let ep_hex = hex_encode(&ep); // 64-char hex string of the entropy bytes

        let mut state = new_ceremony(1, 2, 5);
        let share = generate_party_share(0, 5, &ep);
        contribute(&mut state, share).unwrap();
        finalize_ceremony(&mut state).unwrap();

        let json = ceremony_to_json(&state);

        assert!(
            !json.contains(&ep_hex),
            "ceremony JSON must not expose hex-encoded entropy"
        );
        // Also check the raw decimal representation of the first byte cannot appear
        // in a way that leaks the pattern (entropy is uniform 0xDE = 222 decimally).
        // The real check is the hex one above; this is belt-and-suspenders.
        assert!(
            !json.contains("\"entropy\""),
            "JSON must not have an 'entropy' key"
        );
    }

    // 6. Same parties with a different epoch produce a different final_key_hash.
    #[test]
    fn test_different_epochs_different_keys() {
        let run = |epoch: u64| -> [u8; 32] {
            let mut state = new_ceremony(2, 2, epoch);
            for party_id in 0u8..2 {
                let share = generate_party_share(party_id, epoch, &entropy(party_id + 5));
                contribute(&mut state, share).unwrap();
            }
            finalize_ceremony(&mut state).unwrap()
        };

        let key_epoch_1 = run(1);
        let key_epoch_2 = run(2);
        assert_ne!(
            key_epoch_1, key_epoch_2,
            "different epochs must produce different final key hashes"
        );
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_mainnet_ready_always_false() {
        let state = new_ceremony(2, 3, 1);
        assert!(!state.mainnet_ready);
    }

    #[test]
    fn test_commitment_nonzero() {
        let share = generate_party_share(0, 1, &entropy(0xAB));
        assert_ne!(share.commitment, [0u8; 32]);
    }

    #[test]
    fn test_public_key_hash_nonzero() {
        let share = generate_party_share(1, 2, &entropy(0xCD));
        assert_ne!(share.public_key_hash, [0u8; 32]);
    }

    #[test]
    fn test_commitment_deterministic() {
        let s1 = generate_party_share(0, 10, &entropy(0x42));
        let s2 = generate_party_share(0, 10, &entropy(0x42));
        assert_eq!(s1.commitment, s2.commitment);
    }

    #[test]
    fn test_commitment_entropy_sensitive() {
        let s1 = generate_party_share(0, 1, &entropy(0x01));
        let s2 = generate_party_share(0, 1, &entropy(0x02));
        assert_ne!(s1.commitment, s2.commitment);
    }

    #[test]
    fn test_commitment_party_id_sensitive() {
        let s1 = generate_party_share(0, 1, &entropy(0xFF));
        let s2 = generate_party_share(1, 1, &entropy(0xFF));
        assert_ne!(s1.commitment, s2.commitment);
    }

    #[test]
    fn test_verify_contribution_passes() {
        let ep = entropy(0x77);
        let share = generate_party_share(3, 99, &ep);
        assert!(verify_contribution(&share, 3, 99, &ep));
    }

    #[test]
    fn test_verify_contribution_fails_wrong_entropy() {
        let ep = entropy(0x77);
        let wrong_ep = entropy(0x78);
        let share = generate_party_share(3, 99, &ep);
        assert!(!verify_contribution(&share, 3, 99, &wrong_ep));
    }

    #[test]
    fn test_ceremony_json_keys() {
        let mut state = new_ceremony(1, 1, 7);
        let share = generate_party_share(0, 7, &entropy(0x11));
        contribute(&mut state, share).unwrap();
        finalize_ceremony(&mut state).unwrap();
        let json = ceremony_to_json(&state);
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(v["threshold"].is_number());
        assert!(v["n_parties"].is_number());
        assert!(v["final_key_hash"].is_string());
        assert_eq!(v["mainnet_ready"], false);
    }

    #[test]
    fn test_already_finalized_rejected() {
        let mut state = new_ceremony(1, 1, 5);
        let share = generate_party_share(0, 5, &entropy(0x55));
        contribute(&mut state, share).unwrap();
        finalize_ceremony(&mut state).unwrap();
        // Second finalize must fail
        let err = finalize_ceremony(&mut state).unwrap_err();
        assert_eq!(err, CeremonyError::AlreadyFinalized);
    }
}
