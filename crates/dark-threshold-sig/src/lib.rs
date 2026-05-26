use serde::Serialize;
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

pub struct SignerShare {
    pub signer_id: u8,
    /// SHA256("thresh-share-v1" || signer_id || message_hash || nonce)
    pub share_commitment: [u8; 32],
    /// SHA256("thresh-psig-v1" || share_commitment || signer_id || secret_hash)
    pub partial_sig_hash: [u8; 32],
}

#[derive(Debug)]
pub struct ThresholdSignature {
    pub message_hash: [u8; 32],
    /// SHA256("thresh-agg-v1" || epoch_le || XOR-fold of sorted partial_sig_hashes)
    pub aggregated_sig: [u8; 32],
    pub threshold: u8,
    pub actual_signers: u8,
    pub epoch: u64,
    /// Always false — not mainnet-ready.
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ThreshSigError {
    ThresholdNotMet { required: u8, present: u8 },
    DuplicateSigner(u8),
    MessageMismatch,
    AlreadyAggregated,
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/// Build a signer share for one participant.
///
/// - `share_commitment` = SHA256("thresh-share-v1" || signer_id || message_hash || nonce)
/// - `partial_sig_hash` = SHA256("thresh-psig-v1" || share_commitment || signer_id || secret_hash)
pub fn generate_signer_share(
    signer_id: u8,
    message_hash: &[u8; 32],
    nonce: &[u8; 32],
    secret_hash: &[u8; 32],
) -> SignerShare {
    // share_commitment
    let share_commitment: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"thresh-share-v1");
        h.update([signer_id]);
        h.update(message_hash);
        h.update(nonce);
        h.finalize().into()
    };

    // partial_sig_hash
    let partial_sig_hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"thresh-psig-v1");
        h.update(share_commitment);
        h.update([signer_id]);
        h.update(secret_hash);
        h.finalize().into()
    };

    SignerShare {
        signer_id,
        share_commitment,
        partial_sig_hash,
    }
}

/// Aggregate shares into a threshold signature.
///
/// Errors:
/// - `ThresholdNotMet`  if `shares.len() < threshold`
/// - `DuplicateSigner`  if any `signer_id` appears more than once
///
/// The `aggregated_sig` is:
///   SHA256("thresh-agg-v1" || epoch_le || XOR-fold of partial_sig_hashes sorted by signer_id)
pub fn aggregate_shares(
    shares: &[SignerShare],
    message_hash: &[u8; 32],
    threshold: u8,
    epoch: u64,
) -> Result<ThresholdSignature, ThreshSigError> {
    let present = shares.len() as u8;

    if present < threshold {
        return Err(ThreshSigError::ThresholdNotMet {
            required: threshold,
            present,
        });
    }

    // Duplicate-signer check — O(n²) is fine for small n (≤ 255 signers)
    for i in 0..shares.len() {
        for j in (i + 1)..shares.len() {
            if shares[i].signer_id == shares[j].signer_id {
                return Err(ThreshSigError::DuplicateSigner(shares[i].signer_id));
            }
        }
    }

    // Sort by signer_id for determinism
    let mut sorted_ids: Vec<usize> = (0..shares.len()).collect();
    sorted_ids.sort_by_key(|&i| shares[i].signer_id);

    // XOR-fold of partial_sig_hashes in sorted order
    let mut xor_fold = [0u8; 32];
    for &idx in &sorted_ids {
        for (byte, &sig_byte) in xor_fold.iter_mut().zip(shares[idx].partial_sig_hash.iter()) {
            *byte ^= sig_byte;
        }
    }

    // aggregated_sig = SHA256("thresh-agg-v1" || epoch_le || xor_fold)
    let aggregated_sig: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"thresh-agg-v1");
        h.update(epoch.to_le_bytes());
        h.update(xor_fold);
        h.finalize().into()
    };

    Ok(ThresholdSignature {
        message_hash: *message_hash,
        aggregated_sig,
        threshold,
        actual_signers: present,
        epoch,
        mainnet_ready: false,
    })
}

/// Verify structural invariants of a threshold signature.
///
/// Returns `false` if:
/// - `message_hash` does not match `sig.message_hash`
/// - `sig.actual_signers < sig.threshold`
///
/// Returns `true` otherwise.  A full cryptographic re-check would require
/// access to the original shares; this verifies the stored invariants only.
pub fn verify_threshold_sig(sig: &ThresholdSignature, message_hash: &[u8; 32]) -> bool {
    if message_hash != &sig.message_hash {
        return false;
    }
    if sig.actual_signers < sig.threshold {
        return false;
    }
    true
}

// ---------------------------------------------------------------------------
// Public record (privacy-preserving serialisation)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct ThresholdSigRecord {
    message_hash: String,
    aggregated_sig: String,
    threshold: u8,
    actual_signers: u8,
    epoch: u64,
    mainnet_ready: bool,
}

/// Produce a JSON record that intentionally omits signer identities.
///
/// Fields: `message_hash`, `aggregated_sig`, `threshold`, `actual_signers`,
/// `epoch`, `mainnet_ready`.
///
/// Deliberately absent: `signer_id`, `share_commitment`, `partial_sig_hash`.
pub fn sig_public_record(sig: &ThresholdSignature) -> String {
    let record = ThresholdSigRecord {
        message_hash: hex_encode(&sig.message_hash),
        aggregated_sig: hex_encode(&sig.aggregated_sig),
        threshold: sig.threshold,
        actual_signers: sig.actual_signers,
        epoch: sig.epoch,
        mainnet_ready: sig.mainnet_ready,
    };
    serde_json::to_string(&record).expect("serialisation is infallible")
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

    // Fixed test vectors — deterministic across all runs
    const MSG: [u8; 32] = [0xde; 32];
    const NONCE_A: [u8; 32] = [0x01; 32];
    const NONCE_B: [u8; 32] = [0x02; 32];
    const NONCE_C: [u8; 32] = [0x03; 32];
    const SECRET: [u8; 32] = [0xaa; 32];

    fn share(id: u8, nonce: &[u8; 32]) -> SignerShare {
        generate_signer_share(id, &MSG, nonce, &SECRET)
    }

    // Test 1: 3 shares, threshold 2 → Ok, actual_signers == 3
    #[test]
    fn test_threshold_met_aggregates() {
        let shares = vec![share(0, &NONCE_A), share(1, &NONCE_B), share(2, &NONCE_C)];
        let result = aggregate_shares(&shares, &MSG, 2, 1);
        assert!(result.is_ok());
        let sig = result.unwrap();
        assert_eq!(sig.actual_signers, 3);
        assert_eq!(sig.threshold, 2);
        assert!(!sig.mainnet_ready);
    }

    // Test 2: 1 share, threshold 2 → ThresholdNotMet
    #[test]
    fn test_threshold_not_met() {
        let shares = vec![share(0, &NONCE_A)];
        let result = aggregate_shares(&shares, &MSG, 2, 1);
        assert_eq!(
            result.unwrap_err(),
            ThreshSigError::ThresholdNotMet {
                required: 2,
                present: 1
            }
        );
    }

    // Test 3: two shares with same signer_id → DuplicateSigner
    #[test]
    fn test_duplicate_signer_rejected() {
        let shares = vec![share(5, &NONCE_A), share(5, &NONCE_B)];
        let result = aggregate_shares(&shares, &MSG, 2, 1);
        assert_eq!(result.unwrap_err(), ThreshSigError::DuplicateSigner(5));
    }

    // Test 4: same inputs → identical aggregated_sig (deterministic)
    #[test]
    fn test_aggregated_sig_deterministic() {
        let shares_a = vec![share(0, &NONCE_A), share(1, &NONCE_B)];
        let shares_b = vec![share(0, &NONCE_A), share(1, &NONCE_B)];
        let sig_a = aggregate_shares(&shares_a, &MSG, 2, 42).unwrap();
        let sig_b = aggregate_shares(&shares_b, &MSG, 2, 42).unwrap();
        assert_eq!(sig_a.aggregated_sig, sig_b.aggregated_sig);
    }

    // Test 5: aggregate then verify → true
    #[test]
    fn test_verify_passes_valid_sig() {
        let shares = vec![share(0, &NONCE_A), share(1, &NONCE_B)];
        let sig = aggregate_shares(&shares, &MSG, 2, 7).unwrap();
        assert!(verify_threshold_sig(&sig, &MSG));
    }

    // Test 6: public record must not expose signer identity fields
    #[test]
    fn test_public_record_hides_signers() {
        let shares = vec![share(0, &NONCE_A), share(1, &NONCE_B)];
        let sig = aggregate_shares(&shares, &MSG, 2, 1).unwrap();
        let json = sig_public_record(&sig);

        // Must NOT contain signer identity keys
        assert!(!json.contains("signer_id"));
        assert!(!json.contains("share_commitment"));
        assert!(!json.contains("partial_sig_hash"));

        // Must contain the expected public fields
        assert!(json.contains("message_hash"));
        assert!(json.contains("aggregated_sig"));
        assert!(json.contains("threshold"));
        assert!(json.contains("actual_signers"));
        assert!(json.contains("epoch"));
        assert!(json.contains("mainnet_ready"));
    }
}
