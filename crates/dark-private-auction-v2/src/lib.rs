use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Auction {
    pub auction_id: [u8; 32],
    pub auctioneer_hash: [u8; 32],
    pub item_hash: [u8; 32],
    pub bid_root: [u8; 32],
    pub bid_count: u32,
    pub reserve_commitment: [u8; 32],
    pub winner_hash: Option<[u8; 32]>,
    pub winning_bid_commitment: Option<[u8; 32]>,
    pub finalized: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BidCommitment {
    pub bid_id: [u8; 32],
    pub commitment: [u8; 32],
}

#[derive(Debug, PartialEq)]
pub enum AuctionError {
    ZeroAuctioneerSecret,
    EmptyItem,
    AlreadyFinalized,
    NoBids,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256_bytes(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

#[allow(dead_code)]
fn xor_fold(ids: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = [0u8; 32];
    for id in ids {
        for i in 0..32 {
            acc[i] ^= id[i];
        }
    }
    acc
}

fn compute_auctioneer_hash(secret: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"auc2-auctioneer-v1");
    d.extend_from_slice(secret);
    sha256_bytes(&d)
}

fn compute_item_hash(item_bytes: &[u8]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"auc2-item-v1");
    d.extend_from_slice(item_bytes);
    sha256_bytes(&d)
}

fn compute_auction_id(auctioneer_hash: &[u8; 32], item_hash: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"auc2-id-v1");
    d.extend_from_slice(auctioneer_hash);
    d.extend_from_slice(item_hash);
    sha256_bytes(&d)
}

fn compute_bidder_hash(bidder_secret: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"auc2-bidder-v1");
    d.extend_from_slice(bidder_secret);
    sha256_bytes(&d)
}

fn compute_bid_commitment(bidder_hash: &[u8; 32], amount: u64, nonce: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"auc2-bid-v1");
    d.extend_from_slice(bidder_hash);
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(nonce);
    sha256_bytes(&d)
}

fn compute_bid_id(auction_id: &[u8; 32], bidder_hash: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"auc2-bid-id-v1");
    d.extend_from_slice(auction_id);
    d.extend_from_slice(bidder_hash);
    sha256_bytes(&d)
}

#[allow(dead_code)]
fn compute_bid_root(bid_ids: &[[u8; 32]], bid_count: u32) -> [u8; 32] {
    let folded = xor_fold(bid_ids);
    let mut d = Vec::new();
    d.extend_from_slice(b"auc2-root-v1");
    d.extend_from_slice(&folded);
    d.extend_from_slice(&bid_count.to_le_bytes());
    sha256_bytes(&d)
}

fn compute_reserve_commitment(reserve_price: u64, blinding: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"auc2-reserve-v1");
    d.extend_from_slice(&reserve_price.to_le_bytes());
    d.extend_from_slice(blinding);
    sha256_bytes(&d)
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn new_auction(
    auctioneer_secret: &[u8; 32],
    item_bytes: &[u8],
    reserve_price: u64,
    reserve_blinding: &[u8; 32],
) -> Result<Auction, AuctionError> {
    if auctioneer_secret == &[0u8; 32] {
        return Err(AuctionError::ZeroAuctioneerSecret);
    }
    if item_bytes.is_empty() {
        return Err(AuctionError::EmptyItem);
    }
    let auctioneer_hash = compute_auctioneer_hash(auctioneer_secret);
    let item_hash = compute_item_hash(item_bytes);
    let auction_id = compute_auction_id(&auctioneer_hash, &item_hash);
    let reserve_commitment = compute_reserve_commitment(reserve_price, reserve_blinding);
    let bid_root = [0u8; 32]; // running XOR accumulator; use get_bid_root() for final hash
    Ok(Auction {
        auction_id,
        auctioneer_hash,
        item_hash,
        bid_root,
        bid_count: 0,
        reserve_commitment,
        winner_hash: None,
        winning_bid_commitment: None,
        finalized: false,
        mainnet_ready: false,
    })
}

pub fn place_bid(
    auction: &mut Auction,
    bidder_secret: &[u8; 32],
    amount: u64,
    nonce: &[u8; 32],
) -> Result<BidCommitment, AuctionError> {
    if auction.finalized {
        return Err(AuctionError::AlreadyFinalized);
    }
    let bidder_hash = compute_bidder_hash(bidder_secret);
    let commitment = compute_bid_commitment(&bidder_hash, amount, nonce);
    let bid_id = compute_bid_id(&auction.auction_id, &bidder_hash);

    // bid_root stores the running XOR accumulator of all bid_ids.
    // get_bid_root() applies sha256("auc2-root-v1" || xor || count_le4) on top.
    for i in 0..32 {
        auction.bid_root[i] ^= bid_id[i];
    }
    auction.bid_count += 1;

    Ok(BidCommitment { bid_id, commitment })
}

/// Returns bid_root as sha256("auc2-root-v1" || xor_accumulator || count_le4)
pub fn get_bid_root(auction: &Auction) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"auc2-root-v1");
    d.extend_from_slice(&auction.bid_root); // bid_root stores the running XOR
    d.extend_from_slice(&auction.bid_count.to_le_bytes());
    sha256_bytes(&d)
}

pub fn finalize_auction(
    auction: &mut Auction,
    winning_bidder_secret: &[u8; 32],
    winning_amount: u64,
    winning_nonce: &[u8; 32],
) -> Result<(), AuctionError> {
    if auction.finalized {
        return Err(AuctionError::AlreadyFinalized);
    }
    if auction.bid_count == 0 {
        return Err(AuctionError::NoBids);
    }
    let winner_hash = compute_bidder_hash(winning_bidder_secret);
    let winning_bid_commit = compute_bid_commitment(&winner_hash, winning_amount, winning_nonce);
    auction.winner_hash = Some(winner_hash);
    auction.winning_bid_commitment = Some(winning_bid_commit);
    auction.finalized = true;
    Ok(())
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn secret(b: u8) -> [u8; 32] {
        [b; 32]
    }
    fn nonce(b: u8) -> [u8; 32] {
        [b; 32]
    }

    // Test 1: new_auction + mainnet_ready=false
    #[test]
    fn test_new_auction_mainnet_ready_false() {
        let auction = new_auction(&secret(0xaa), b"gold-bar", 1000, &nonce(0x55)).unwrap();
        assert!(!auction.mainnet_ready);
        assert!(!auction.finalized);
        assert_eq!(auction.bid_count, 0);
        assert!(auction.winner_hash.is_none());

        // Verify auction_id formula
        let auc_hash = compute_auctioneer_hash(&secret(0xaa));
        let itm_hash = compute_item_hash(b"gold-bar");
        let expected_id = compute_auction_id(&auc_hash, &itm_hash);
        assert_eq!(auction.auction_id, expected_id);

        // Verify reserve_commitment formula
        let expected_reserve = compute_reserve_commitment(1000, &nonce(0x55));
        assert_eq!(auction.reserve_commitment, expected_reserve);
    }

    // Test 2: place_bid updates root
    #[test]
    fn test_place_bid_updates_root() {
        let mut auction = new_auction(&secret(0xaa), b"item", 500, &nonce(0x01)).unwrap();
        let root_before = auction.bid_root;
        place_bid(&mut auction, &secret(0xb1), 100, &nonce(0x0a)).unwrap();
        assert_ne!(auction.bid_root, root_before);
        assert_eq!(auction.bid_count, 1);
    }

    // Test 3: finalize sets winner
    #[test]
    fn test_finalize_sets_winner() {
        let mut auction = new_auction(&secret(0xaa), b"item", 500, &nonce(0x01)).unwrap();
        place_bid(&mut auction, &secret(0xb1), 200, &nonce(0x0a)).unwrap();
        finalize_auction(&mut auction, &secret(0xb1), 200, &nonce(0x0a)).unwrap();
        assert!(auction.finalized);
        let expected_winner = compute_bidder_hash(&secret(0xb1));
        assert_eq!(auction.winner_hash, Some(expected_winner));
        assert!(auction.winning_bid_commitment.is_some());
    }

    // Test 4: bid_after_finalize rejected
    #[test]
    fn test_bid_after_finalize_rejected() {
        let mut auction = new_auction(&secret(0xaa), b"item", 500, &nonce(0x01)).unwrap();
        place_bid(&mut auction, &secret(0xb1), 200, &nonce(0x0a)).unwrap();
        finalize_auction(&mut auction, &secret(0xb1), 200, &nonce(0x0a)).unwrap();
        let err = place_bid(&mut auction, &secret(0xb2), 300, &nonce(0x0b)).unwrap_err();
        assert_eq!(err, AuctionError::AlreadyFinalized);
    }

    // Test 5: zero_auctioneer rejected
    #[test]
    fn test_zero_auctioneer_rejected() {
        let err = new_auction(&[0u8; 32], b"item", 500, &nonce(0x01)).unwrap_err();
        assert_eq!(err, AuctionError::ZeroAuctioneerSecret);
    }

    // Test 6: bid_root is deterministic for same bids
    #[test]
    fn test_bid_root_deterministic() {
        let mut auction1 = new_auction(&secret(0xaa), b"item", 500, &nonce(0x01)).unwrap();
        let mut auction2 = new_auction(&secret(0xaa), b"item", 500, &nonce(0x01)).unwrap();
        place_bid(&mut auction1, &secret(0xb1), 100, &nonce(0x0a)).unwrap();
        place_bid(&mut auction2, &secret(0xb1), 100, &nonce(0x0a)).unwrap();
        let root1 = get_bid_root(&auction1);
        let root2 = get_bid_root(&auction2);
        assert_eq!(root1, root2);
        assert_ne!(root1, [0u8; 32]);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_auction_id_nonzero() {
        let auction = new_auction(&secret(0x01), b"item", 100, &nonce(0x01)).unwrap();
        assert_ne!(auction.auction_id, [0u8; 32]);
    }

    #[test]
    fn test_auctioneer_hash_nonzero() {
        let auction = new_auction(&secret(0x02), b"item", 100, &nonce(0x01)).unwrap();
        assert_ne!(auction.auctioneer_hash, [0u8; 32]);
    }

    #[test]
    fn test_item_hash_nonzero() {
        let auction = new_auction(&secret(0x03), b"item", 100, &nonce(0x01)).unwrap();
        assert_ne!(auction.item_hash, [0u8; 32]);
    }

    #[test]
    fn test_reserve_commitment_nonzero() {
        let auction = new_auction(&secret(0x04), b"item", 100, &nonce(0x01)).unwrap();
        assert_ne!(auction.reserve_commitment, [0u8; 32]);
    }

    #[test]
    fn test_empty_item_rejected() {
        let err = new_auction(&secret(0x05), b"", 100, &nonce(0x01)).unwrap_err();
        assert_eq!(err, AuctionError::EmptyItem);
    }

    #[test]
    fn test_no_bids_finalize_rejected() {
        let mut auction = new_auction(&secret(0x06), b"item", 100, &nonce(0x01)).unwrap();
        let err = finalize_auction(&mut auction, &secret(0xb1), 100, &nonce(0x01)).unwrap_err();
        assert_eq!(err, AuctionError::NoBids);
    }

    #[test]
    fn test_double_finalize_rejected() {
        let mut auction = new_auction(&secret(0x07), b"item", 100, &nonce(0x01)).unwrap();
        place_bid(&mut auction, &secret(0xb1), 100, &nonce(0x0a)).unwrap();
        finalize_auction(&mut auction, &secret(0xb1), 100, &nonce(0x0a)).unwrap();
        let err = finalize_auction(&mut auction, &secret(0xb1), 100, &nonce(0x0a)).unwrap_err();
        assert_eq!(err, AuctionError::AlreadyFinalized);
    }

    #[test]
    fn test_bid_count_increments() {
        let mut auction = new_auction(&secret(0x08), b"item", 100, &nonce(0x01)).unwrap();
        assert_eq!(auction.bid_count, 0);
        place_bid(&mut auction, &secret(0xb1), 50, &nonce(0x0a)).unwrap();
        assert_eq!(auction.bid_count, 1);
        place_bid(&mut auction, &secret(0xb2), 60, &nonce(0x0b)).unwrap();
        assert_eq!(auction.bid_count, 2);
    }

    #[test]
    fn test_bid_commitment_nonzero() {
        let mut auction = new_auction(&secret(0x09), b"item", 100, &nonce(0x01)).unwrap();
        let bc = place_bid(&mut auction, &secret(0xb1), 100, &nonce(0x0a)).unwrap();
        assert_ne!(bc.commitment, [0u8; 32]);
    }

    #[test]
    fn test_bid_id_nonzero() {
        let mut auction = new_auction(&secret(0x0A), b"item", 100, &nonce(0x01)).unwrap();
        let bc = place_bid(&mut auction, &secret(0xb1), 100, &nonce(0x0a)).unwrap();
        assert_ne!(bc.bid_id, [0u8; 32]);
    }
}
