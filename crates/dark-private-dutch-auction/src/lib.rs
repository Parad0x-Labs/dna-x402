// dark-private-dutch-auction — commit-reveal Dutch auction, only winner's amount revealed
// Bids are price-committed; losing bids stay private forever.
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false

use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct AuctionConfig {
    /// SHA256(auction_id_bytes) — never raw
    pub auction_id_hash: [u8; 32],
    pub ceiling_price: u64, // highest price (start)
    pub floor_price: u64,   // lowest price (end)
    pub start_slot: u64,
    pub end_slot: u64,
    pub item_hash: [u8; 32], // SHA256 of item description
    pub mainnet_ready: bool, // always false
}

#[derive(Debug, Clone, PartialEq)]
pub struct BidCommitment {
    /// SHA256("bid-commit-v1" || auction_id_hash || bidder_hash || amount_le8 || nonce)
    pub commit_hash: [u8; 32],
    /// SHA256 of bidder identity — never raw
    pub bidder_hash: [u8; 32],
    pub submitted_at_slot: u64,
    pub mainnet_ready: bool, // always false
}

#[derive(Debug, Clone, PartialEq)]
pub struct BidReveal {
    pub commit_hash: [u8; 32], // must match a BidCommitment
    pub amount: u64,
    pub nonce: [u8; 32],
    pub revealed_at_slot: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AuctionResult {
    /// Winner's bidder_hash (not their identity)
    pub winner_hash: [u8; 32],
    /// Clearing price (current Dutch price at reveal slot)
    pub clearing_price: u64,
    /// Winner paid clearing_price, not their committed amount
    pub amount_paid: u64,
    pub settled_at_slot: u64,
    /// Number of bids submitted (all stay private except winner)
    pub total_bids: u32,
    pub mainnet_ready: bool, // always false
}

#[derive(Debug, PartialEq)]
pub enum AuctionError {
    PriceRangeInvalid, // ceiling <= floor
    SlotRangeInvalid,  // end_slot <= start_slot
    BidOutsideAuctionWindow,
    RevealOutsideAuctionWindow,
    CommitmentMismatch, // reveal doesn't match commit
    PriceTooHigh,       // current price > bid amount
    AuctionExpired,
    NoBids,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// SHA256 of arbitrary bytes.
fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

/// Build the canonical commitment preimage and hash it.
///
/// Preimage layout (all fixed-width to prevent length-extension collisions):
///   "bid-commit-v1" (14 bytes)
///   || auction_id_hash (32 bytes)
///   || bidder_hash     (32 bytes)
///   || amount as little-endian u64 (8 bytes)
///   || nonce           (32 bytes)
fn compute_commit_hash(
    auction_id_hash: &[u8; 32],
    bidder_hash: &[u8; 32],
    amount: u64,
    nonce: &[u8; 32],
) -> [u8; 32] {
    let mut preimage = Vec::with_capacity(14 + 32 + 32 + 8 + 32);
    preimage.extend_from_slice(b"bid-commit-v1");
    preimage.extend_from_slice(auction_id_hash);
    preimage.extend_from_slice(bidder_hash);
    preimage.extend_from_slice(&amount.to_le_bytes());
    preimage.extend_from_slice(nonce);
    sha256(&preimage)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Create a new auction configuration.
pub fn new_auction(
    auction_id: &[u8],
    ceiling_price: u64,
    floor_price: u64,
    start_slot: u64,
    end_slot: u64,
    item_description: &[u8],
) -> Result<AuctionConfig, AuctionError> {
    if ceiling_price <= floor_price {
        return Err(AuctionError::PriceRangeInvalid);
    }
    if end_slot <= start_slot {
        return Err(AuctionError::SlotRangeInvalid);
    }
    Ok(AuctionConfig {
        auction_id_hash: sha256(auction_id),
        ceiling_price,
        floor_price,
        start_slot,
        end_slot,
        item_hash: sha256(item_description),
        mainnet_ready: false,
    })
}

/// Compute the current Dutch price at a given slot (linear descent).
///
/// price = ceiling - (ceiling - floor) * (slot - start) / (end - start)
///
/// Clamped to [floor, ceiling].
pub fn current_price(config: &AuctionConfig, slot: u64) -> u64 {
    if slot <= config.start_slot {
        return config.ceiling_price;
    }
    if slot >= config.end_slot {
        return config.floor_price;
    }
    let elapsed = slot - config.start_slot;
    let duration = config.end_slot - config.start_slot;
    let drop = config.ceiling_price - config.floor_price;
    // Use u128 multiplication to avoid overflow on large values.
    let descent = (drop as u128 * elapsed as u128 / duration as u128) as u64;
    config.ceiling_price.saturating_sub(descent)
}

/// Commit a bid. The amount is hidden inside the commitment.
///
/// Returns `Err(BidOutsideAuctionWindow)` if `slot` is outside `[start_slot, end_slot)`.
pub fn commit_bid(
    config: &AuctionConfig,
    bidder_id: &[u8],
    amount: u64,
    nonce: &[u8; 32],
    slot: u64,
) -> Result<BidCommitment, AuctionError> {
    if slot < config.start_slot || slot >= config.end_slot {
        return Err(AuctionError::BidOutsideAuctionWindow);
    }
    let bidder_hash = sha256(bidder_id);
    let commit_hash = compute_commit_hash(&config.auction_id_hash, &bidder_hash, amount, nonce);
    Ok(BidCommitment {
        commit_hash,
        bidder_hash,
        submitted_at_slot: slot,
        mainnet_ready: false,
    })
}

/// Verify a bid commitment is structurally valid (non-zero hash, mainnet_ready == false).
///
/// This is a lightweight structural check only — it cannot verify the amount
/// without the reveal, which is the whole point of the scheme.
pub fn verify_commitment(commitment: &BidCommitment) -> bool {
    // A zero hash indicates an uninitialised / corrupted commitment.
    commitment.commit_hash != [0u8; 32]
        && commitment.bidder_hash != [0u8; 32]
        && !commitment.mainnet_ready
}

/// Reveal a bid.
///
/// Checks:
/// 1. Slot is within auction window.
/// 2. Commitment hash matches the revealed (amount, nonce, bidder_hash).
/// 3. Current price <= revealed amount (bidder is willing to pay at this price).
///
/// Returns the clearing price on success.
pub fn reveal_bid(
    config: &AuctionConfig,
    commitment: &BidCommitment,
    reveal: &BidReveal,
    slot: u64,
) -> Result<u64, AuctionError> {
    // Window check (allow reveal up to and including end_slot so the final
    // slot is reachable).
    if slot < config.start_slot || slot > config.end_slot {
        return Err(AuctionError::RevealOutsideAuctionWindow);
    }

    // Recompute commitment hash and verify it matches.
    let expected = compute_commit_hash(
        &config.auction_id_hash,
        &commitment.bidder_hash,
        reveal.amount,
        &reveal.nonce,
    );
    if expected != commitment.commit_hash {
        return Err(AuctionError::CommitmentMismatch);
    }

    // Check the reveal commit_hash field also matches (belt-and-suspenders).
    if reveal.commit_hash != commitment.commit_hash {
        return Err(AuctionError::CommitmentMismatch);
    }

    let price = current_price(config, slot);
    if price > reveal.amount {
        return Err(AuctionError::PriceTooHigh);
    }

    Ok(price)
}

/// Settle: given a list of (commitment, reveal) pairs, pick the winner.
///
/// Each pair is validated with `reveal_bid` using `reveal.revealed_at_slot`.
/// The winner is the earliest valid reveal (lowest `revealed_at_slot`).
/// Ties are broken by order in the `bids` slice (first element wins).
///
/// Returns `AuctionResult` — only winner info is public.
pub fn settle_auction(
    config: &AuctionConfig,
    bids: &[(BidCommitment, BidReveal)],
    settle_slot: u64,
) -> Result<AuctionResult, AuctionError> {
    if bids.is_empty() {
        return Err(AuctionError::NoBids);
    }

    let total_bids = bids.len() as u32;

    // Find the earliest valid reveal.
    let mut winner: Option<(&BidCommitment, &BidReveal, u64)> = None; // (commit, reveal, clearing_price)

    for (commitment, reveal) in bids {
        let reveal_slot = reveal.revealed_at_slot;
        if let Ok(clearing_price) = reveal_bid(config, commitment, reveal, reveal_slot) {
            match winner {
                None => {
                    winner = Some((commitment, reveal, clearing_price));
                }
                Some((_, prev_reveal, _)) => {
                    if reveal_slot < prev_reveal.revealed_at_slot {
                        winner = Some((commitment, reveal, clearing_price));
                    }
                }
            }
        }
    }

    match winner {
        None => Err(AuctionError::NoBids),
        Some((win_commit, _win_reveal, clearing_price)) => Ok(AuctionResult {
            winner_hash: win_commit.bidder_hash,
            clearing_price,
            amount_paid: clearing_price,
            settled_at_slot: settle_slot,
            total_bids,
            mainnet_ready: false,
        }),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // Shared fixture helpers.
    fn make_config() -> AuctionConfig {
        new_auction(b"auction-001", 1000, 100, 0, 100, b"rare sword NFT").unwrap()
    }

    fn make_nonce(seed: u8) -> [u8; 32] {
        [seed; 32]
    }

    // 1. mainnet_ready is always false on a new config.
    #[test]
    fn test_auction_config_mainnet_ready_false() {
        let cfg = make_config();
        assert!(!cfg.mainnet_ready);
    }

    // 2. Price at start slot equals ceiling.
    #[test]
    fn test_price_at_start_is_ceiling() {
        let cfg = make_config();
        assert_eq!(current_price(&cfg, cfg.start_slot), cfg.ceiling_price);
    }

    // 3. Price at end slot equals floor.
    #[test]
    fn test_price_at_end_is_floor() {
        let cfg = make_config();
        assert_eq!(current_price(&cfg, cfg.end_slot), cfg.floor_price);
    }

    // 4. Price at midpoint slot is the midpoint of ceiling and floor.
    //    ceiling=1000, floor=100, mid-slot=50, expected=(1000+100)/2=550.
    #[test]
    fn test_price_midpoint_is_midpoint() {
        let cfg = make_config();
        let mid = (cfg.start_slot + cfg.end_slot) / 2;
        let expected = (cfg.ceiling_price + cfg.floor_price) / 2;
        assert_eq!(current_price(&cfg, mid), expected);
    }

    // 5. commit_bid returns a BidCommitment with mainnet_ready = false.
    #[test]
    fn test_commit_bid_returns_commitment() {
        let cfg = make_config();
        let nonce = make_nonce(0xaa);
        let result = commit_bid(&cfg, b"alice", 800, &nonce, 10);
        assert!(result.is_ok());
        let c = result.unwrap();
        assert!(!c.mainnet_ready);
        assert_ne!(c.commit_hash, [0u8; 32]);
    }

    // 6. Same inputs always produce the same commitment hash (deterministic).
    #[test]
    fn test_commitment_hash_deterministic() {
        let cfg = make_config();
        let nonce = make_nonce(0xbb);
        let c1 = commit_bid(&cfg, b"bob", 500, &nonce, 20).unwrap();
        let c2 = commit_bid(&cfg, b"bob", 500, &nonce, 20).unwrap();
        assert_eq!(c1.commit_hash, c2.commit_hash);
    }

    // 7. A valid reveal is accepted and returns the clearing price.
    //    At slot 20: price = 1000 - 900*(20/100) = 1000 - 180 = 820.
    //    Commit 900 (>= 820), reveal at slot 20 => accepted.
    #[test]
    fn test_reveal_valid_bid_accepted() {
        let cfg = make_config();
        let nonce = make_nonce(0x01);
        let commitment = commit_bid(&cfg, b"carol", 900, &nonce, 5).unwrap();
        let reveal = BidReveal {
            commit_hash: commitment.commit_hash,
            amount: 900,
            nonce,
            revealed_at_slot: 20,
        };
        let result = reveal_bid(&cfg, &commitment, &reveal, 20);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), current_price(&cfg, 20));
    }

    // 8. Bid amount (100) below current price (991 at slot 1) is rejected with PriceTooHigh.
    #[test]
    fn test_reveal_bid_below_price_rejected() {
        let cfg = make_config();
        let nonce = make_nonce(0x02);
        // Commit 100 inside the window.
        let commitment = commit_bid(&cfg, b"dave", 100, &nonce, 1).unwrap();
        // At slot 1: price = 1000 - 900*(1/100) = 991. 100 < 991 → PriceTooHigh.
        let reveal = BidReveal {
            commit_hash: commitment.commit_hash,
            amount: 100,
            nonce,
            revealed_at_slot: 1,
        };
        assert_eq!(
            reveal_bid(&cfg, &commitment, &reveal, 1),
            Err(AuctionError::PriceTooHigh)
        );
    }

    // 9. Committing outside the auction window is rejected.
    #[test]
    fn test_commit_outside_window_rejected() {
        let cfg = make_config();
        let nonce = make_nonce(0x03);
        // Slot underflow (before start — wraps on subtract, huge number >= end_slot)
        assert_eq!(
            commit_bid(&cfg, b"eve", 500, &nonce, u64::MAX),
            Err(AuctionError::BidOutsideAuctionWindow)
        );
        // At end_slot (half-open window: [start, end))
        assert_eq!(
            commit_bid(&cfg, b"eve", 500, &nonce, cfg.end_slot),
            Err(AuctionError::BidOutsideAuctionWindow)
        );
        // Past end_slot
        assert_eq!(
            commit_bid(&cfg, b"eve", 500, &nonce, cfg.end_slot + 10),
            Err(AuctionError::BidOutsideAuctionWindow)
        );
    }

    // 10. Tampering the amount before reveal causes CommitmentMismatch.
    #[test]
    fn test_commitment_mismatch_rejected() {
        let cfg = make_config();
        let nonce = make_nonce(0x04);
        let commitment = commit_bid(&cfg, b"frank", 800, &nonce, 5).unwrap();
        // Tamper: different amount in the reveal.
        let reveal = BidReveal {
            commit_hash: commitment.commit_hash,
            amount: 801, // tampered
            nonce,
            revealed_at_slot: 20,
        };
        assert_eq!(
            reveal_bid(&cfg, &commitment, &reveal, 20),
            Err(AuctionError::CommitmentMismatch)
        );
    }

    // 11. Settling with a single valid bid picks that bid as winner.
    //     At slot 50: price = 1000 - 900*(50/100) = 550.
    #[test]
    fn test_settle_single_bid_wins() {
        let cfg = make_config();
        let nonce = make_nonce(0x05);
        let commitment = commit_bid(&cfg, b"grace", 600, &nonce, 10).unwrap();
        let expected_winner_hash = commitment.bidder_hash;
        let reveal = BidReveal {
            commit_hash: commitment.commit_hash,
            amount: 600,
            nonce,
            revealed_at_slot: 50,
        };
        let result = settle_auction(&cfg, &[(commitment, reveal)], 50).unwrap();
        assert_eq!(result.winner_hash, expected_winner_hash);
        assert_eq!(result.clearing_price, current_price(&cfg, 50));
        assert_eq!(result.amount_paid, result.clearing_price);
        assert!(!result.mainnet_ready);
        assert_eq!(result.total_bids, 1);
    }

    // 12. Settling picks the earliest valid reveal when multiple bids exist.
    //     A reveals at slot 60, B reveals at slot 50 — B wins.
    #[test]
    fn test_settle_picks_earliest_valid_reveal() {
        let cfg = make_config();
        let nonce_a = make_nonce(0x06);
        let nonce_b = make_nonce(0x07);

        // Bidder A reveals at slot 60: price = 1000 - 900*(60/100) = 460. 500 >= 460 OK.
        let commit_a = commit_bid(&cfg, b"hank", 500, &nonce_a, 10).unwrap();
        let reveal_a = BidReveal {
            commit_hash: commit_a.commit_hash,
            amount: 500,
            nonce: nonce_a,
            revealed_at_slot: 60,
        };

        // Bidder B reveals at slot 50: price = 550. 600 >= 550 OK. B reveals earlier → B wins.
        let commit_b = commit_bid(&cfg, b"iris", 600, &nonce_b, 10).unwrap();
        let expected_winner = commit_b.bidder_hash;
        let reveal_b = BidReveal {
            commit_hash: commit_b.commit_hash,
            amount: 600,
            nonce: nonce_b,
            revealed_at_slot: 50,
        };

        let result =
            settle_auction(&cfg, &[(commit_a, reveal_a), (commit_b, reveal_b)], 70).unwrap();
        assert_eq!(result.winner_hash, expected_winner);
        assert_eq!(result.total_bids, 2);
    }

    // 13. settle_auction with no bids returns NoBids.
    #[test]
    fn test_settle_no_bids_returns_err() {
        let cfg = make_config();
        assert_eq!(settle_auction(&cfg, &[], 50), Err(AuctionError::NoBids));
    }

    // 14. current_price clamps at floor after end_slot.
    #[test]
    fn test_price_clamps_at_floor_after_end() {
        let cfg = make_config();
        assert_eq!(current_price(&cfg, cfg.end_slot + 1000), cfg.floor_price);
        assert_eq!(current_price(&cfg, u64::MAX), cfg.floor_price);
    }

    // 15. winner_hash equals SHA256(bidder_id), not the raw bidder_id bytes.
    #[test]
    fn test_winner_hash_not_raw_bidder_id() {
        let cfg = make_config();
        let bidder_id = b"winner";
        let nonce = make_nonce(0x08);
        // At slot 90: price = 1000 - 900*(90/100) = 190. 200 >= 190 OK.
        let commitment = commit_bid(&cfg, bidder_id, 200, &nonce, 5).unwrap();
        let reveal = BidReveal {
            commit_hash: commitment.commit_hash,
            amount: 200,
            nonce,
            revealed_at_slot: 90,
        };
        let result = settle_auction(&cfg, &[(commitment, reveal)], 90).unwrap();

        // winner_hash must equal SHA256(bidder_id).
        let expected_hash: [u8; 32] = sha256(bidder_id);
        assert_eq!(result.winner_hash, expected_hash);

        // And must not equal the hash of a different id.
        let wrong_hash: [u8; 32] = sha256(b"loser");
        assert_ne!(result.winner_hash, wrong_hash);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_verify_commitment_valid_returns_true() {
        let cfg = make_config();
        let nonce = make_nonce(0x09);
        let commitment = commit_bid(&cfg, b"judy", 700, &nonce, 10).unwrap();
        assert!(verify_commitment(&commitment));
    }
}
