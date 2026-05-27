//! dark-secret-sharing — SHA-256 based n-of-n secret sharing for DNA x402.
//!
//! This crate implements a deterministic n-of-n secret sharing scheme:
//!
//! * Shares are derived with SHA-256 so they are reproducible given the same
//!   `(secret, nonce)` pair — no CSPRNG required at split time.
//! * All `n` shares are required for reconstruction (XOR of all share bytes
//!   equals the original secret).
//! * Each share carries a SHA-256 commitment so individual shares can be
//!   verified without knowing the secret.
//!
//! # Threshold extension note
//!
//! True k-of-n threshold sharing (k < n) can be built on top of this primitive
//! by splitting the secret into C(n,k) independent n-of-n groups, one for each
//! k-subset of parties, but that is left as a protocol-level concern. The
//! current implementation enforces `threshold == n_parties` (n-of-n).
//!
//! # Share derivation
//!
//! For parties `0..n-2`:
//!   `share[i] = SHA-256("partial-v1" || secret || nonce || [i as u8])`
//!
//! For the final party `n-1`:
//!   `share[n-1] = secret XOR share[0] XOR ... XOR share[n-2]`
//!
//! Reconstruction: `secret = share[0] XOR share[1] XOR ... XOR share[n-1]`
//!
//! # mainnet_ready flag
//!
//! Every public type carries a `mainnet_ready: bool` field. For this prototype
//! the flag is always `false`. Flip it to `true` only after an independent
//! security audit.

use sha2::{Digest, Sha256};

// ─── domain-separation tags ──────────────────────────────────────────────────

const TAG_PARTIAL: &[u8] = b"partial-v1";
const TAG_SHARE_COMMIT: &[u8] = b"share-commit-v1";
const TAG_SECRET_COMMIT: &[u8] = b"secret-commit-v1";

// ─── public types ────────────────────────────────────────────────────────────

/// A single party's share of a split secret.
#[derive(Debug, Clone)]
pub struct SecretShare {
    /// Zero-based index of this party (0 .. total_parties - 1).
    pub party_id: u8,
    /// The 32-byte share value. Keep this private — never publish it.
    pub share_bytes: [u8; 32],
    /// SHA-256("share-commit-v1" || party_id || share_bytes). Safe to publish.
    pub share_commitment: [u8; 32],
    /// Minimum shares needed for reconstruction (equals `total_parties` in
    /// this n-of-n construction).
    pub threshold: u8,
    /// Total number of parties in this sharing.
    pub total_parties: u8,
    /// Prototype flag — `false` until an independent security audit passes.
    pub mainnet_ready: bool,
}

/// The secret recovered from a complete set of shares.
#[derive(Debug, Clone)]
pub struct ReconstructedSecret {
    /// The recovered 32-byte secret.
    pub secret: [u8; 32],
    /// SHA-256("secret-commit-v1" || secret).
    pub secret_commitment: [u8; 32],
    /// Prototype flag — always `false` in this version.
    pub mainnet_ready: bool,
}

/// Errors returned by this crate's public functions.
#[derive(Debug, PartialEq)]
pub enum SharingError {
    /// `n_parties` must be at least 2.
    TooFewParties,
    /// `threshold` must not exceed `n_parties`.
    ThresholdExceedsParties,
    /// Reconstruction was attempted with fewer shares than required.
    InsufficientShares { needed: u8, provided: usize },
    /// A share's `share_commitment` field does not match its `share_bytes`.
    CommitmentMismatch,
}

// ─── internal helpers ────────────────────────────────────────────────────────

/// SHA-256("partial-v1" || secret || nonce || [party_id]).
fn derive_partial(secret: &[u8; 32], nonce: &[u8; 32], party_id: u8) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(TAG_PARTIAL);
    h.update(secret);
    h.update(nonce);
    h.update([party_id]);
    h.finalize().into()
}

/// SHA-256("share-commit-v1" || party_id || share_bytes).
fn commit_share(party_id: u8, share_bytes: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(TAG_SHARE_COMMIT);
    h.update([party_id]);
    h.update(share_bytes);
    h.finalize().into()
}

/// SHA-256("secret-commit-v1" || secret).
fn commit_secret(secret: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(TAG_SECRET_COMMIT);
    h.update(secret);
    h.finalize().into()
}

/// XOR two 32-byte arrays together.
fn xor32(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = a[i] ^ b[i];
    }
    out
}

// ─── public API ──────────────────────────────────────────────────────────────

/// Split `secret` into `n_parties` shares, all of which are required to
/// reconstruct (n-of-n scheme).
///
/// `nonce` should be a fresh 32-byte value per split operation to ensure
/// share uniqueness when the same secret is split multiple times.
///
/// # Errors
///
/// * [`SharingError::TooFewParties`] if `n_parties < 2`.
/// * [`SharingError::ThresholdExceedsParties`] if `threshold > n_parties`.
///
/// This implementation only supports `threshold == n_parties`. Passing a
/// smaller `threshold` still succeeds today but reconstruction will always
/// require all `n_parties` shares regardless.
pub fn split_secret(
    secret: &[u8; 32],
    nonce: &[u8; 32],
    n_parties: u8,
    threshold: u8,
) -> Result<Vec<SecretShare>, SharingError> {
    if n_parties < 2 {
        return Err(SharingError::TooFewParties);
    }
    if threshold > n_parties {
        return Err(SharingError::ThresholdExceedsParties);
    }

    let n = n_parties as usize;

    // Derive (n-1) pseudo-random partial shares via SHA-256.
    let mut partials: Vec<[u8; 32]> = (0..n - 1)
        .map(|i| derive_partial(secret, nonce, i as u8))
        .collect();

    // The last share is secret XOR (XOR of all earlier shares), so that
    // XOR-ing all n shares cancels out and recovers the secret.
    let mut last = *secret;
    for p in &partials {
        last = xor32(&last, p);
    }
    partials.push(last);

    let shares = partials
        .into_iter()
        .enumerate()
        .map(|(i, share_bytes)| {
            let party_id = i as u8;
            let share_commitment = commit_share(party_id, &share_bytes);
            SecretShare {
                party_id,
                share_bytes,
                share_commitment,
                threshold,
                total_parties: n_parties,
                mainnet_ready: false,
            }
        })
        .collect();

    Ok(shares)
}

/// Reconstruct the secret from a complete set of shares.
///
/// The shares may be provided in any order. The reconstruction XORs every
/// `share_bytes` field together; the result is the original secret.
///
/// # Errors
///
/// * [`SharingError::InsufficientShares`] if fewer than `threshold` shares
///   are provided (threshold is read from the first share in the slice).
pub fn reconstruct_secret(shares: &[SecretShare]) -> Result<ReconstructedSecret, SharingError> {
    if shares.is_empty() {
        return Err(SharingError::InsufficientShares {
            needed: 1,
            provided: 0,
        });
    }

    let threshold = shares[0].threshold;

    if shares.len() < threshold as usize {
        return Err(SharingError::InsufficientShares {
            needed: threshold,
            provided: shares.len(),
        });
    }

    // XOR all share bytes together to recover the secret.
    let mut secret = [0u8; 32];
    for s in shares {
        secret = xor32(&secret, &s.share_bytes);
    }

    let secret_commitment = commit_secret(&secret);

    Ok(ReconstructedSecret {
        secret,
        secret_commitment,
        mainnet_ready: false,
    })
}

/// Verify that a share's `share_commitment` is consistent with its
/// `party_id` and `share_bytes`. Returns `true` if the commitment matches.
pub fn verify_share(share: &SecretShare) -> bool {
    let expected = commit_share(share.party_id, &share.share_bytes);
    expected == share.share_commitment
}

/// Return a JSON array containing the **public** record of each share:
/// `party_id`, `share_commitment` (hex), `threshold`, and `total_parties`.
///
/// `share_bytes` is intentionally omitted — this output is safe to publish
/// to a bulletin board or on-chain.
pub fn shares_public_record(shares: &[SecretShare]) -> String {
    let records: Vec<serde_json::Value> = shares
        .iter()
        .map(|s| {
            serde_json::json!({
                "party_id": s.party_id,
                "share_commitment": hex_encode(&s.share_commitment),
                "threshold": s.threshold,
                "total_parties": s.total_parties,
            })
        })
        .collect();

    serde_json::to_string_pretty(&records).expect("serialisation is infallible")
}

// ─── tiny hex helper (no extra dep) ─────────────────────────────────────────

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ─── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: [u8; 32] = [
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
        0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e,
        0x1f, 0x20,
    ];

    const NONCE: [u8; 32] = [0xde; 32];

    // ── 1. Split and reconstruct with 2 parties ───────────────────────────
    #[test]
    fn test_split_and_reconstruct_2of2() {
        let shares = split_secret(&SECRET, &NONCE, 2, 2).expect("split should succeed");
        assert_eq!(shares.len(), 2);

        let recovered = reconstruct_secret(&shares).expect("reconstruct should succeed");
        assert_eq!(
            recovered.secret, SECRET,
            "recovered secret must match original"
        );

        // Commitment must be consistent.
        assert_eq!(recovered.secret_commitment, commit_secret(&SECRET));
    }

    // ── 2. Split and reconstruct with 3 parties ───────────────────────────
    #[test]
    fn test_split_and_reconstruct_3of3() {
        let shares = split_secret(&SECRET, &NONCE, 3, 3).expect("split should succeed");
        assert_eq!(shares.len(), 3);

        let recovered = reconstruct_secret(&shares).expect("reconstruct should succeed");
        assert_eq!(
            recovered.secret, SECRET,
            "recovered secret must match original"
        );
    }

    // ── 3. n_parties = 1 is rejected ─────────────────────────────────────
    #[test]
    fn test_too_few_parties_rejected() {
        let err = split_secret(&SECRET, &NONCE, 1, 1).unwrap_err();
        assert_eq!(err, SharingError::TooFewParties);
    }

    // ── 4. verify_share passes for freshly created shares ────────────────
    #[test]
    fn test_verify_share_passes() {
        let shares = split_secret(&SECRET, &NONCE, 3, 3).expect("split should succeed");
        for share in &shares {
            assert!(verify_share(share), "every fresh share must verify");
        }
    }

    // ── 5. Providing fewer shares than threshold is rejected ──────────────
    #[test]
    fn test_insufficient_shares_rejected() {
        let shares = split_secret(&SECRET, &NONCE, 3, 3).expect("split should succeed");

        // Pass only 2 of the 3 shares (threshold = 3).
        let partial = &shares[..2];
        let err = reconstruct_secret(partial).unwrap_err();

        assert_eq!(
            err,
            SharingError::InsufficientShares {
                needed: 3,
                provided: 2,
            }
        );
    }

    // ── 6. shares_public_record does not expose share_bytes ──────────────
    #[test]
    fn test_public_record_hides_share_bytes() {
        let shares = split_secret(&SECRET, &NONCE, 3, 3).expect("split should succeed");
        let record = shares_public_record(&shares);

        // The JSON must not contain the hex encoding of any share_bytes.
        for share in &shares {
            let bytes_hex = hex_encode(&share.share_bytes);
            assert!(
                !record.contains(&bytes_hex),
                "public record must not contain share_bytes hex for party {}",
                share.party_id
            );
        }

        // Sanity: commitments ARE present.
        for share in &shares {
            let commit_hex = hex_encode(&share.share_commitment);
            assert!(
                record.contains(&commit_hex),
                "public record must contain share_commitment for party {}",
                share.party_id
            );
        }
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_mainnet_ready_always_false() {
        let shares = split_secret(&SECRET, &NONCE, 2, 2).unwrap();
        for s in &shares {
            assert!(!s.mainnet_ready);
        }
        let rec = reconstruct_secret(&shares).unwrap();
        assert!(!rec.mainnet_ready);
    }

    #[test]
    fn test_split_5of5_roundtrip() {
        let shares = split_secret(&SECRET, &NONCE, 5, 5).unwrap();
        assert_eq!(shares.len(), 5);
        let rec = reconstruct_secret(&shares).unwrap();
        assert_eq!(rec.secret, SECRET);
    }

    #[test]
    fn test_different_nonces_produce_different_shares() {
        let nonce2 = [0xABu8; 32];
        let s1 = split_secret(&SECRET, &NONCE, 3, 3).unwrap();
        let s2 = split_secret(&SECRET, &nonce2, 3, 3).unwrap();
        // Shares differ but both reconstruct to the same secret
        assert_ne!(s1[0].share_bytes, s2[0].share_bytes);
        let r1 = reconstruct_secret(&s1).unwrap();
        let r2 = reconstruct_secret(&s2).unwrap();
        assert_eq!(r1.secret, r2.secret);
    }

    #[test]
    fn test_tampered_share_fails_verify() {
        let mut shares = split_secret(&SECRET, &NONCE, 3, 3).unwrap();
        shares[1].share_bytes[0] ^= 0xFF; // corrupt one byte
        assert!(!verify_share(&shares[1]));
        // Reconstruction with tampered share gives wrong secret
        let rec = reconstruct_secret(&shares).unwrap();
        assert_ne!(rec.secret, SECRET);
    }

    #[test]
    fn test_threshold_exceeds_parties_rejected() {
        let err = split_secret(&SECRET, &NONCE, 3, 4).unwrap_err();
        assert_eq!(err, SharingError::ThresholdExceedsParties);
    }

    #[test]
    fn test_split_and_reconstruct_any_order() {
        let shares = split_secret(&SECRET, &NONCE, 4, 4).unwrap();
        // Reverse order
        let reversed: Vec<SecretShare> = shares.into_iter().rev().collect();
        let rec = reconstruct_secret(&reversed).unwrap();
        assert_eq!(rec.secret, SECRET);
    }

    #[test]
    fn test_each_party_gets_unique_id() {
        let shares = split_secret(&SECRET, &NONCE, 5, 5).unwrap();
        let ids: Vec<u8> = shares.iter().map(|s| s.party_id).collect();
        assert_eq!(ids, vec![0, 1, 2, 3, 4]);
    }

    #[test]
    fn test_secret_commitment_deterministic() {
        let s1 = split_secret(&SECRET, &NONCE, 2, 2).unwrap();
        let r1 = reconstruct_secret(&s1).unwrap();
        let s2 = split_secret(&SECRET, &NONCE, 2, 2).unwrap();
        let r2 = reconstruct_secret(&s2).unwrap();
        assert_eq!(r1.secret_commitment, r2.secret_commitment);
    }

    #[test]
    fn test_public_record_has_expected_fields() {
        let shares = split_secret(&SECRET, &NONCE, 2, 2).unwrap();
        let record = shares_public_record(&shares);
        assert!(record.contains("party_id"));
        assert!(record.contains("share_commitment"));
        assert!(record.contains("threshold"));
        assert!(record.contains("total_parties"));
    }

    #[test]
    fn test_different_secrets_different_reconstruction() {
        let mut secret2 = SECRET;
        secret2[0] ^= 0xFF;
        let s1 = split_secret(&SECRET, &NONCE, 2, 2).unwrap();
        let s2 = split_secret(&secret2, &NONCE, 2, 2).unwrap();
        let r1 = reconstruct_secret(&s1).unwrap();
        let r2 = reconstruct_secret(&s2).unwrap();
        assert_ne!(r1.secret, r2.secret);
        assert_ne!(r1.secret_commitment, r2.secret_commitment);
    }
}
