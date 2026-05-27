use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct SealedBid {
    /// SHA256("bid-commit-v1" || bidder_hash || amount_le || nonce)
    pub bid_commitment: [u8; 32],
    /// SHA256("bidder-hash-v1" || bidder_secret)
    pub bidder_hash: [u8; 32],
    pub auction_id: u64,
    pub committed_at_unix: i64,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone)]
pub struct RevealedBid {
    pub bid_commitment: [u8; 32],
    pub bidder_hash: [u8; 32],
    pub amount: u64,
    pub committed_at_unix: i64,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone)]
pub struct AuctionResult {
    pub auction_id: u64,
    pub winner_hash: [u8; 32], // bidder_hash of winner
    pub winning_amount: u64,
    /// SHA256("auction-result-v1" || auction_id_le || winner_hash || winning_amount_le)
    pub result_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum AuctionError {
    BidderSecretZero,
    ZeroBid,
    CommitmentMismatch,
    NoBids,
    NonceZero,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn bidder_hash_from_secret(bidder_secret: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"bidder-hash-v1");
    h.update(bidder_secret);
    h.finalize().into()
}

fn bid_commitment_from_parts(bidder_hash: &[u8; 32], amount: u64, nonce: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"bid-commit-v1");
    h.update(bidder_hash);
    h.update(amount.to_le_bytes());
    h.update(nonce);
    h.finalize().into()
}

fn result_hash_from_parts(
    auction_id: u64,
    winner_hash: &[u8; 32],
    winning_amount: u64,
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"auction-result-v1");
    h.update(auction_id.to_le_bytes());
    h.update(winner_hash);
    h.update(winning_amount.to_le_bytes());
    h.finalize().into()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Create a sealed (committed) bid.
///
/// Returns `BidderSecretZero` if `bidder_secret` is all-zero,
/// `ZeroBid` if `amount == 0`, `NonceZero` if `nonce` is all-zero.
pub fn commit_bid(
    bidder_secret: &[u8; 32],
    amount: u64,
    nonce: &[u8; 32],
    auction_id: u64,
    committed_at_unix: i64,
) -> Result<SealedBid, AuctionError> {
    if bidder_secret == &[0u8; 32] {
        return Err(AuctionError::BidderSecretZero);
    }
    if amount == 0 {
        return Err(AuctionError::ZeroBid);
    }
    if nonce == &[0u8; 32] {
        return Err(AuctionError::NonceZero);
    }

    let bidder_hash = bidder_hash_from_secret(bidder_secret);
    let bid_commitment = bid_commitment_from_parts(&bidder_hash, amount, nonce);

    Ok(SealedBid {
        bid_commitment,
        bidder_hash,
        auction_id,
        committed_at_unix,
        mainnet_ready: false,
    })
}

/// Reveal a sealed bid by re-deriving the commitment and checking it matches.
///
/// Returns `CommitmentMismatch` if the recomputed commitment differs from the
/// one stored in `sealed`.
pub fn reveal_bid(
    sealed: &SealedBid,
    bidder_secret: &[u8; 32],
    amount: u64,
    nonce: &[u8; 32],
) -> Result<RevealedBid, AuctionError> {
    let bidder_hash = bidder_hash_from_secret(bidder_secret);
    let recomputed = bid_commitment_from_parts(&bidder_hash, amount, nonce);

    if recomputed != sealed.bid_commitment {
        return Err(AuctionError::CommitmentMismatch);
    }

    Ok(RevealedBid {
        bid_commitment: sealed.bid_commitment,
        bidder_hash,
        amount,
        committed_at_unix: sealed.committed_at_unix,
        mainnet_ready: sealed.mainnet_ready,
    })
}

/// Finalize an auction from a slice of revealed bids.
///
/// Winner is the highest `amount`. Ties are broken by earliest
/// `committed_at_unix` (lower value wins). Returns `NoBids` if the slice
/// is empty.
pub fn finalize_auction(
    revealed_bids: &[RevealedBid],
    auction_id: u64,
) -> Result<AuctionResult, AuctionError> {
    if revealed_bids.is_empty() {
        return Err(AuctionError::NoBids);
    }

    // Find winner: highest amount; ties go to earliest committed_at_unix.
    let winner = revealed_bids
        .iter()
        .reduce(|best, bid| {
            if bid.amount > best.amount {
                bid
            } else if bid.amount == best.amount && bid.committed_at_unix < best.committed_at_unix {
                bid
            } else {
                best
            }
        })
        .expect("slice is non-empty");

    let result_hash = result_hash_from_parts(auction_id, &winner.bidder_hash, winner.amount);

    Ok(AuctionResult {
        auction_id,
        winner_hash: winner.bidder_hash,
        winning_amount: winner.amount,
        result_hash,
        mainnet_ready: winner.mainnet_ready,
    })
}

/// Build a JSON public record for an auction result.
///
/// Intentionally omits `winner_hash` to preserve bidder privacy.
pub fn auction_public_record(result: &AuctionResult) -> String {
    let result_hash_hex: String = result
        .result_hash
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();

    serde_json::json!({
        "auction_id": result.auction_id,
        "winning_amount": result.winning_amount,
        "result_hash": result_hash_hex,
        "mainnet_ready": result.mainnet_ready,
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_secret(byte: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = byte;
        s
    }

    fn make_nonce(byte: u8) -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = byte;
        n
    }

    // 1. Happy path: 3 bidders, highest bid wins.
    #[test]
    fn test_commit_reveal_finalize_happy_path() {
        let auction_id = 42u64;

        let secret_a = make_secret(1);
        let secret_b = make_secret(2);
        let secret_c = make_secret(3);

        let nonce_a = make_nonce(10);
        let nonce_b = make_nonce(11);
        let nonce_c = make_nonce(12);

        let sealed_a = commit_bid(&secret_a, 100, &nonce_a, auction_id, 1000).unwrap();
        let sealed_b = commit_bid(&secret_b, 300, &nonce_b, auction_id, 1001).unwrap();
        let sealed_c = commit_bid(&secret_c, 200, &nonce_c, auction_id, 1002).unwrap();

        let revealed_a = reveal_bid(&sealed_a, &secret_a, 100, &nonce_a).unwrap();
        let revealed_b = reveal_bid(&sealed_b, &secret_b, 300, &nonce_b).unwrap();
        let revealed_c = reveal_bid(&sealed_c, &secret_c, 200, &nonce_c).unwrap();

        let result =
            finalize_auction(&[revealed_a, revealed_b.clone(), revealed_c], auction_id).unwrap();

        assert_eq!(result.winning_amount, 300);
        assert_eq!(result.winner_hash, revealed_b.bidder_hash);
        assert_eq!(result.auction_id, auction_id);
        assert!(!result.mainnet_ready);
    }

    // 2. Tie goes to the earlier commitment timestamp.
    #[test]
    fn test_tie_goes_to_earlier_commitment() {
        let auction_id = 7u64;

        let secret_early = make_secret(1);
        let secret_late = make_secret(2);

        let nonce_early = make_nonce(1);
        let nonce_late = make_nonce(2);

        // Both bid 500 but early bid comes first (lower timestamp).
        let sealed_early = commit_bid(&secret_early, 500, &nonce_early, auction_id, 900).unwrap();
        let sealed_late = commit_bid(&secret_late, 500, &nonce_late, auction_id, 901).unwrap();

        let revealed_early = reveal_bid(&sealed_early, &secret_early, 500, &nonce_early).unwrap();
        let revealed_late = reveal_bid(&sealed_late, &secret_late, 500, &nonce_late).unwrap();

        // Pass late first so the tie-break logic is exercised regardless of slice order.
        let result =
            finalize_auction(&[revealed_late, revealed_early.clone()], auction_id).unwrap();

        assert_eq!(result.winning_amount, 500);
        assert_eq!(result.winner_hash, revealed_early.bidder_hash);
    }

    // 3. Revealing with a wrong amount causes CommitmentMismatch.
    #[test]
    fn test_commitment_mismatch_rejected() {
        let secret = make_secret(5);
        let nonce = make_nonce(5);
        let sealed = commit_bid(&secret, 250, &nonce, 1, 0).unwrap();

        let err = reveal_bid(&sealed, &secret, 999, &nonce).unwrap_err();
        assert_eq!(err, AuctionError::CommitmentMismatch);
    }

    // 4. A zero-amount bid is rejected at commit time.
    #[test]
    fn test_zero_bid_rejected() {
        let secret = make_secret(1);
        let nonce = make_nonce(1);
        let err = commit_bid(&secret, 0, &nonce, 1, 0).unwrap_err();
        assert_eq!(err, AuctionError::ZeroBid);
    }

    // 5. Finalizing with no bids returns NoBids.
    #[test]
    fn test_no_bids_rejected() {
        let err = finalize_auction(&[], 1).unwrap_err();
        assert_eq!(err, AuctionError::NoBids);
    }

    // 6. The public record does NOT contain the winner_hash hex string.
    #[test]
    fn test_public_record_hides_winner_hash() {
        let secret = make_secret(9);
        let nonce = make_nonce(9);
        let sealed = commit_bid(&secret, 777, &nonce, 55, 5000).unwrap();
        let revealed = reveal_bid(&sealed, &secret, 777, &nonce).unwrap();
        let result = finalize_auction(&[revealed.clone()], 55).unwrap();

        let record = auction_public_record(&result);

        // The public record must contain these fields.
        assert!(record.contains("auction_id"));
        assert!(record.contains("winning_amount"));
        assert!(record.contains("result_hash"));
        assert!(record.contains("mainnet_ready"));

        // The winner_hash hex must NOT appear in the public record.
        let winner_hash_hex: String = result
            .winner_hash
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();
        assert!(
            !record.contains(&winner_hash_hex),
            "public record must not expose winner_hash"
        );
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_sealed_bid_mainnet_ready_false() {
        let s = commit_bid(&make_secret(1), 100, &make_nonce(1), 1, 0).unwrap();
        assert!(!s.mainnet_ready);
    }

    #[test]
    fn test_bid_commitment_nonzero() {
        let s = commit_bid(&make_secret(2), 100, &make_nonce(2), 1, 0).unwrap();
        assert_ne!(s.bid_commitment, [0u8; 32]);
    }

    #[test]
    fn test_bidder_hash_nonzero() {
        let s = commit_bid(&make_secret(3), 100, &make_nonce(1), 1, 0).unwrap();
        assert_ne!(s.bidder_hash, [0u8; 32]);
    }

    #[test]
    fn test_result_hash_nonzero() {
        let secret = make_secret(4);
        let nonce = make_nonce(4);
        let sealed = commit_bid(&secret, 50, &nonce, 1, 0).unwrap();
        let revealed = reveal_bid(&sealed, &secret, 50, &nonce).unwrap();
        let result = finalize_auction(&[revealed], 1).unwrap();
        assert_ne!(result.result_hash, [0u8; 32]);
    }

    #[test]
    fn test_bidder_secret_zero_rejected() {
        let err = commit_bid(&[0u8; 32], 100, &make_nonce(1), 1, 0).unwrap_err();
        assert_eq!(err, AuctionError::BidderSecretZero);
    }

    #[test]
    fn test_nonce_zero_rejected() {
        let err = commit_bid(&make_secret(5), 100, &[0u8; 32], 1, 0).unwrap_err();
        assert_eq!(err, AuctionError::NonceZero);
    }

    #[test]
    fn test_result_mainnet_ready_false() {
        let secret = make_secret(6);
        let nonce = make_nonce(6);
        let sealed = commit_bid(&secret, 50, &nonce, 1, 0).unwrap();
        let revealed = reveal_bid(&sealed, &secret, 50, &nonce).unwrap();
        let result = finalize_auction(&[revealed], 1).unwrap();
        assert!(!result.mainnet_ready);
    }

    #[test]
    fn test_commit_deterministic() {
        let s1 = commit_bid(&make_secret(7), 200, &make_nonce(7), 1, 0).unwrap();
        let s2 = commit_bid(&make_secret(7), 200, &make_nonce(7), 1, 0).unwrap();
        assert_eq!(s1.bid_commitment, s2.bid_commitment);
    }

    #[test]
    fn test_different_amounts_different_commitments() {
        let s1 = commit_bid(&make_secret(8), 100, &make_nonce(1), 1, 0).unwrap();
        let s2 = commit_bid(&make_secret(8), 200, &make_nonce(1), 1, 0).unwrap();
        assert_ne!(s1.bid_commitment, s2.bid_commitment);
    }

    #[test]
    fn test_auction_record_has_correct_fields() {
        let secret = make_secret(9);
        let nonce = make_nonce(9);
        let sealed = commit_bid(&secret, 999, &nonce, 77, 0).unwrap();
        let revealed = reveal_bid(&sealed, &secret, 999, &nonce).unwrap();
        let result = finalize_auction(&[revealed], 77).unwrap();
        let v: serde_json::Value = serde_json::from_str(&auction_public_record(&result)).unwrap();
        assert_eq!(v["auction_id"], 77u64);
        assert_eq!(v["winning_amount"], 999u64);
        assert!(v["result_hash"].is_string());
        assert_eq!(v["mainnet_ready"], false);
    }
}
