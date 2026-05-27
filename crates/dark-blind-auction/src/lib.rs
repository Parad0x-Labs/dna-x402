use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlindAuction {
    pub auction_id: [u8; 32],
    pub item_hash: [u8; 32],
    pub sealed_bids: Vec<[u8; 32]>,
    pub highest_bid_commitment: [u8; 32],
    pub winner_hash: [u8; 32],
    pub finalized: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SealedBid {
    pub bid_id: [u8; 32],
    pub bidder_hash: [u8; 32],
    pub bid_commitment: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum AuctionError {
    ZeroAuctioneerSecret,
    EmptyItem,
    AlreadyFinalized,
    NoBids,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

fn hex(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn compute_auctioneer_hash(auctioneer_secret: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"auction-auctioneer-v1");
    d.extend_from_slice(auctioneer_secret);
    sha256(&d)
}

fn compute_item_hash(item_bytes: &[u8]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"auction-item-v1");
    d.extend_from_slice(item_bytes);
    sha256(&d)
}

fn compute_auction_id(
    auctioneer_hash: &[u8; 32],
    item_hash: &[u8; 32],
    nonce: &[u8; 32],
) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"auction-id-v1");
    d.extend_from_slice(auctioneer_hash);
    d.extend_from_slice(item_hash);
    d.extend_from_slice(nonce);
    sha256(&d)
}

fn compute_bidder_hash(bidder_secret: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"auction-bidder-v1");
    d.extend_from_slice(bidder_secret);
    sha256(&d)
}

fn compute_bid_commitment(bidder_hash: &[u8; 32], amount: u64, nonce_bid: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"auction-bid-v1");
    d.extend_from_slice(bidder_hash);
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(nonce_bid);
    sha256(&d)
}

fn compute_bid_id(auction_id: &[u8; 32], bid_commitment: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"auction-bid-id-v1");
    d.extend_from_slice(auction_id);
    d.extend_from_slice(bid_commitment);
    sha256(&d)
}

fn compute_highest_bid_commitment(bid_id_winner: &[u8; 32], amount: u64) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"auction-winner-v1");
    d.extend_from_slice(bid_id_winner);
    d.extend_from_slice(&amount.to_le_bytes());
    sha256(&d)
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn create_auction(
    auctioneer_secret: &[u8; 32],
    item_bytes: &[u8],
    nonce: &[u8; 32],
) -> Result<BlindAuction, AuctionError> {
    if auctioneer_secret == &[0u8; 32] {
        return Err(AuctionError::ZeroAuctioneerSecret);
    }
    if item_bytes.is_empty() {
        return Err(AuctionError::EmptyItem);
    }
    let auctioneer_hash = compute_auctioneer_hash(auctioneer_secret);
    let item_hash = compute_item_hash(item_bytes);
    let auction_id = compute_auction_id(&auctioneer_hash, &item_hash, nonce);
    Ok(BlindAuction {
        auction_id,
        item_hash,
        sealed_bids: Vec::new(),
        highest_bid_commitment: [0u8; 32],
        winner_hash: [0u8; 32],
        finalized: false,
        mainnet_ready: false,
    })
}

pub fn submit_bid(
    auction: &mut BlindAuction,
    bidder_secret: &[u8; 32],
    amount: u64,
    nonce_bid: &[u8; 32],
) -> Result<SealedBid, AuctionError> {
    if auction.finalized {
        return Err(AuctionError::AlreadyFinalized);
    }
    let bidder_hash = compute_bidder_hash(bidder_secret);
    let bid_commitment = compute_bid_commitment(&bidder_hash, amount, nonce_bid);
    let bid_id = compute_bid_id(&auction.auction_id, &bid_commitment);
    auction.sealed_bids.push(bid_id);
    Ok(SealedBid {
        bid_id,
        bidder_hash,
        bid_commitment,
        mainnet_ready: false,
    })
}

pub fn finalize_auction(
    auction: &mut BlindAuction,
    bids_with_amounts: &[(SealedBid, u64)],
) -> Result<[u8; 32], AuctionError> {
    if auction.finalized {
        return Err(AuctionError::AlreadyFinalized);
    }
    if bids_with_amounts.is_empty() {
        return Err(AuctionError::NoBids);
    }

    let (winner_bid, winner_amount) = bids_with_amounts
        .iter()
        .max_by_key(|(_, amt)| *amt)
        .unwrap();

    auction.highest_bid_commitment =
        compute_highest_bid_commitment(&winner_bid.bid_id, *winner_amount);
    auction.winner_hash = winner_bid.bidder_hash;
    auction.finalized = true;

    Ok(auction.winner_hash)
}

pub fn auction_public_record(auction: &BlindAuction) -> String {
    serde_json::json!({
        "auction_id":  hex(&auction.auction_id),
        "item_hash":   hex(&auction.item_hash),
        "bid_count":   auction.sealed_bids.len(),
        "finalized":   auction.finalized,
        "mainnet_ready": auction.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn auctioneer() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xaa;
        s
    }
    fn nonce() -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = 0x01;
        n
    }
    fn bidder(b: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = b;
        s
    }
    fn nonce_bid(b: u8) -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = b;
        n
    }

    // Test 1: create + 3 bidders + finalize (correct winner)
    #[test]
    fn test_create_bid_finalize_correct_winner() {
        let mut auction = create_auction(&auctioneer(), b"rare NFT", &nonce()).unwrap();
        assert!(!auction.finalized);
        assert!(!auction.mainnet_ready);

        let bid1 = submit_bid(&mut auction, &bidder(0x11), 100, &nonce_bid(0x01)).unwrap();
        let bid2 = submit_bid(&mut auction, &bidder(0x22), 300, &nonce_bid(0x02)).unwrap();
        let bid3 = submit_bid(&mut auction, &bidder(0x33), 200, &nonce_bid(0x03)).unwrap();

        let bids_with_amounts = [(bid1, 100u64), (bid2.clone(), 300u64), (bid3, 200u64)];
        let winner = finalize_auction(&mut auction, &bids_with_amounts).unwrap();

        // bidder 0x22 bid highest (300)
        let expected_winner = compute_bidder_hash(&bidder(0x22));
        assert_eq!(winner, expected_winner);
        assert_eq!(auction.winner_hash, expected_winner);
        assert!(auction.finalized);
        assert!(!auction.mainnet_ready);
    }

    // Test 2: no bids rejected
    #[test]
    fn test_no_bids_rejected() {
        let mut auction = create_auction(&auctioneer(), b"item", &nonce()).unwrap();
        let err = finalize_auction(&mut auction, &[]).unwrap_err();
        assert_eq!(err, AuctionError::NoBids);
    }

    // Test 3: already finalized rejected
    #[test]
    fn test_already_finalized_rejected() {
        let mut auction = create_auction(&auctioneer(), b"item", &nonce()).unwrap();
        let bid = submit_bid(&mut auction, &bidder(0x11), 100, &nonce_bid(0x01)).unwrap();
        finalize_auction(&mut auction, &[(bid.clone(), 100)]).unwrap();

        // Submit after finalized
        let err_bid = submit_bid(&mut auction, &bidder(0x22), 200, &nonce_bid(0x02)).unwrap_err();
        assert_eq!(err_bid, AuctionError::AlreadyFinalized);

        // Finalize again
        let err_fin = finalize_auction(&mut auction, &[(bid, 100)]).unwrap_err();
        assert_eq!(err_fin, AuctionError::AlreadyFinalized);
    }

    // Test 4: zero auctioneer secret rejected
    #[test]
    fn test_zero_auctioneer_rejected() {
        let err = create_auction(&[0u8; 32], b"item", &nonce()).unwrap_err();
        assert_eq!(err, AuctionError::ZeroAuctioneerSecret);
    }

    // Test 5: bid_commitment unique per bidder (same amount, different secret)
    #[test]
    fn test_bid_commitment_unique_per_bidder() {
        let bidder_hash_1 = compute_bidder_hash(&bidder(0x11));
        let bidder_hash_2 = compute_bidder_hash(&bidder(0x22));
        let nonce_b = nonce_bid(0x01);
        let bc1 = compute_bid_commitment(&bidder_hash_1, 100, &nonce_b);
        let bc2 = compute_bid_commitment(&bidder_hash_2, 100, &nonce_b);
        assert_ne!(bc1, bc2);
    }

    // Test 6: public record hides winner until finalized
    #[test]
    fn test_public_record_hides_winner() {
        let mut auction = create_auction(&auctioneer(), b"item", &nonce()).unwrap();
        let bid = submit_bid(&mut auction, &bidder(0x11), 100, &nonce_bid(0x01)).unwrap();

        let record_before = auction_public_record(&auction);
        let v_before: serde_json::Value = serde_json::from_str(&record_before).unwrap();
        assert_eq!(v_before["finalized"], false);
        // winner_hash not in public record
        assert!(v_before.get("winner_hash").is_none());

        finalize_auction(&mut auction, &[(bid, 100)]).unwrap();
        let record_after = auction_public_record(&auction);
        let v_after: serde_json::Value = serde_json::from_str(&record_after).unwrap();
        assert_eq!(v_after["finalized"], true);
        // winner_hash still not in public record
        assert!(v_after.get("winner_hash").is_none());
        assert_eq!(v_after["mainnet_ready"], false);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_mainnet_ready_always_false() {
        let auction = create_auction(&auctioneer(), b"item", &nonce()).unwrap();
        assert!(!auction.mainnet_ready);
    }

    #[test]
    fn test_sealed_bid_mainnet_ready_false() {
        let mut auction = create_auction(&auctioneer(), b"item", &nonce()).unwrap();
        let bid = submit_bid(&mut auction, &bidder(0x11), 100, &nonce_bid(0x01)).unwrap();
        assert!(!bid.mainnet_ready);
    }

    #[test]
    fn test_auction_id_deterministic() {
        let a1 = create_auction(&auctioneer(), b"item", &nonce()).unwrap();
        let a2 = create_auction(&auctioneer(), b"item", &nonce()).unwrap();
        assert_eq!(a1.auction_id, a2.auction_id);
    }

    #[test]
    fn test_auction_id_item_sensitive() {
        let a1 = create_auction(&auctioneer(), b"item-a", &nonce()).unwrap();
        let a2 = create_auction(&auctioneer(), b"item-b", &nonce()).unwrap();
        assert_ne!(a1.auction_id, a2.auction_id);
    }

    #[test]
    fn test_auction_id_nonce_sensitive() {
        let n2 = [0x02u8; 32];
        let a1 = create_auction(&auctioneer(), b"item", &nonce()).unwrap();
        let a2 = create_auction(&auctioneer(), b"item", &n2).unwrap();
        assert_ne!(a1.auction_id, a2.auction_id);
    }

    #[test]
    fn test_bid_count_in_sealed_bids() {
        let mut auction = create_auction(&auctioneer(), b"item", &nonce()).unwrap();
        submit_bid(&mut auction, &bidder(0x11), 100, &nonce_bid(0x01)).unwrap();
        submit_bid(&mut auction, &bidder(0x22), 200, &nonce_bid(0x02)).unwrap();
        assert_eq!(auction.sealed_bids.len(), 2);
    }

    #[test]
    fn test_bid_commitment_nonce_sensitive() {
        let bh = compute_bidder_hash(&bidder(0x11));
        let nb1 = nonce_bid(0x01);
        let nb2 = nonce_bid(0x02);
        let bc1 = compute_bid_commitment(&bh, 100, &nb1);
        let bc2 = compute_bid_commitment(&bh, 100, &nb2);
        assert_ne!(bc1, bc2);
    }

    #[test]
    fn test_bid_commitment_amount_sensitive() {
        let bh = compute_bidder_hash(&bidder(0x11));
        let nb = nonce_bid(0x01);
        let bc1 = compute_bid_commitment(&bh, 100, &nb);
        let bc2 = compute_bid_commitment(&bh, 200, &nb);
        assert_ne!(bc1, bc2);
    }

    #[test]
    fn test_finalized_starts_false() {
        let auction = create_auction(&auctioneer(), b"item", &nonce()).unwrap();
        assert!(!auction.finalized);
    }

    #[test]
    fn test_public_record_has_bid_count() {
        let mut auction = create_auction(&auctioneer(), b"item", &nonce()).unwrap();
        submit_bid(&mut auction, &bidder(0x11), 100, &nonce_bid(0x01)).unwrap();
        submit_bid(&mut auction, &bidder(0x22), 200, &nonce_bid(0x02)).unwrap();
        let record = auction_public_record(&auction);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert_eq!(v["bid_count"], 2u64);
    }
}
