use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeeQuote {
    pub quote_id: [u8; 32],
    pub bidder_hash: [u8; 32],
    pub fee_lamports: u64,
    pub slot: u64,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeeAuction {
    pub slot: u64,
    pub quotes: Vec<FeeQuote>,
    pub winning_quote: Option<FeeQuote>,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum FeeError {
    ZeroFee,
    BidderSecretZero,
    AuctionAlreadySettled,
    NoQuotes,
}

fn sha256_hash(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

pub fn create_quote(
    bidder_secret: &[u8; 32],
    fee_lamports: u64,
    slot: u64,
) -> Result<FeeQuote, FeeError> {
    if fee_lamports == 0 {
        return Err(FeeError::ZeroFee);
    }
    if *bidder_secret == [0u8; 32] {
        return Err(FeeError::BidderSecretZero);
    }

    // bidder_hash = SHA256("fee-bidder-v1" || bidder_secret)
    let mut bh_input = b"fee-bidder-v1".to_vec();
    bh_input.extend_from_slice(bidder_secret);
    let bidder_hash = sha256_hash(&bh_input);

    // quote_id = SHA256("fee-quote-v1" || bidder_hash || fee_le || slot_le)
    let mut qid_input = b"fee-quote-v1".to_vec();
    qid_input.extend_from_slice(&bidder_hash);
    qid_input.extend_from_slice(&fee_lamports.to_le_bytes());
    qid_input.extend_from_slice(&slot.to_le_bytes());
    let quote_id = sha256_hash(&qid_input);

    Ok(FeeQuote {
        quote_id,
        bidder_hash,
        fee_lamports,
        slot,
        mainnet_ready: false,
    })
}

pub fn new_auction(slot: u64) -> FeeAuction {
    FeeAuction {
        slot,
        quotes: Vec::new(),
        winning_quote: None,
        mainnet_ready: false,
    }
}

pub fn add_quote(auction: &mut FeeAuction, quote: FeeQuote) -> Result<(), FeeError> {
    if auction.winning_quote.is_some() {
        return Err(FeeError::AuctionAlreadySettled);
    }
    auction.quotes.push(quote);
    Ok(())
}

pub fn settle_auction(auction: &mut FeeAuction) -> Result<&FeeQuote, FeeError> {
    if auction.quotes.is_empty() {
        return Err(FeeError::NoQuotes);
    }
    let winner_idx = auction
        .quotes
        .iter()
        .enumerate()
        .max_by_key(|(_, q)| q.fee_lamports)
        .map(|(i, _)| i)
        .unwrap();
    auction.winning_quote = Some(auction.quotes[winner_idx].clone());
    Ok(auction.winning_quote.as_ref().unwrap())
}

pub fn auction_public_record(auction: &FeeAuction) -> String {
    let settled = auction.winning_quote.is_some();
    let winning_fee: Option<u64> = auction.winning_quote.as_ref().map(|q| q.fee_lamports);
    if let Some(fee) = winning_fee {
        serde_json::json!({
            "slot": auction.slot,
            "quote_count": auction.quotes.len(),
            "settled": settled,
            "winning_fee_lamports": fee,
            "mainnet_ready": auction.mainnet_ready,
        })
        .to_string()
    } else {
        serde_json::json!({
            "slot": auction.slot,
            "quote_count": auction.quotes.len(),
            "settled": settled,
            "mainnet_ready": auction.mainnet_ready,
        })
        .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secret(seed: u8) -> [u8; 32] {
        let mut s = [0xaa_u8; 32];
        s[0] = seed;
        s
    }

    #[test]
    fn test_three_quotes_highest_wins() {
        let mut auction = new_auction(100);
        assert!(!auction.mainnet_ready);
        let q1 = create_quote(&secret(1), 1_000, 100).unwrap();
        let q2 = create_quote(&secret(2), 5_000, 100).unwrap();
        let q3 = create_quote(&secret(3), 3_000, 100).unwrap();
        add_quote(&mut auction, q1).unwrap();
        add_quote(&mut auction, q2).unwrap();
        add_quote(&mut auction, q3).unwrap();
        let winner = settle_auction(&mut auction).unwrap();
        assert_eq!(winner.fee_lamports, 5_000);
    }

    #[test]
    fn test_zero_fee_rejected() {
        let err = create_quote(&secret(1), 0, 100).unwrap_err();
        assert_eq!(err, FeeError::ZeroFee);
    }

    #[test]
    fn test_bidder_secret_zero_rejected() {
        let err = create_quote(&[0u8; 32], 1_000, 100).unwrap_err();
        assert_eq!(err, FeeError::BidderSecretZero);
    }

    #[test]
    fn test_already_settled_rejected() {
        let mut auction = new_auction(200);
        let q = create_quote(&secret(4), 2_000, 200).unwrap();
        add_quote(&mut auction, q.clone()).unwrap();
        settle_auction(&mut auction).unwrap();
        let err = add_quote(&mut auction, q).unwrap_err();
        assert_eq!(err, FeeError::AuctionAlreadySettled);
    }

    #[test]
    fn test_public_record_hides_bidder_hashes() {
        let mut auction = new_auction(300);
        let q = create_quote(&secret(5), 7_500, 300).unwrap();
        add_quote(&mut auction, q).unwrap();
        settle_auction(&mut auction).unwrap();
        let record: serde_json::Value =
            serde_json::from_str(&auction_public_record(&auction)).unwrap();
        // bidder_hash must NOT appear in the public record
        assert!(record.get("bidder_hash").is_none());
        assert_eq!(record["winning_fee_lamports"], 7_500);
        assert!(record["settled"].as_bool().unwrap());
        assert!(!record["mainnet_ready"].as_bool().unwrap());
    }

    #[test]
    fn test_no_quotes_rejected() {
        let mut auction = new_auction(400);
        let err = settle_auction(&mut auction).unwrap_err();
        assert_eq!(err, FeeError::NoQuotes);
    }
}
