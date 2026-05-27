use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderBook {
    pub book_id: [u8; 32],
    pub pair_hash: [u8; 32],
    pub order_count: u32,
    pub best_bid_commitment: [u8; 32],
    pub best_ask_commitment: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Order {
    pub order_id: [u8; 32],
    pub trader_hash: [u8; 32],
    pub side: OrderSide,
    pub price_commitment: [u8; 32],
    pub amount_commitment: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum OrderSide {
    Bid,
    Ask,
}

#[derive(Debug, PartialEq)]
pub enum OrderError {
    ZeroTraderSecret,
    ZeroPrice,
    ZeroAmount,
    ZeroPair,
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

fn compute_pair_hash(pair_bytes: &[u8]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"book-pair-v1");
    d.extend_from_slice(pair_bytes);
    sha256(&d)
}

fn compute_book_id(pair_hash: &[u8; 32], nonce: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"book-id-v1");
    d.extend_from_slice(pair_hash);
    d.extend_from_slice(nonce);
    sha256(&d)
}

fn compute_trader_hash(trader_secret: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"order-trader-v1");
    d.extend_from_slice(trader_secret);
    sha256(&d)
}

fn compute_price_commitment(price: u64, blinding: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"order-price-v1");
    d.extend_from_slice(&price.to_le_bytes());
    d.extend_from_slice(blinding);
    sha256(&d)
}

fn compute_amount_commitment(amount: u64, blinding: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"order-amount-v1");
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(blinding);
    sha256(&d)
}

fn compute_order_id(
    book_id: &[u8; 32],
    trader_hash: &[u8; 32],
    price_commitment: &[u8; 32],
    amount_commitment: &[u8; 32],
    side: &OrderSide,
) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"order-id-v1");
    d.extend_from_slice(book_id);
    d.extend_from_slice(trader_hash);
    d.extend_from_slice(price_commitment);
    d.extend_from_slice(amount_commitment);
    d.push(match side {
        OrderSide::Bid => 0u8,
        OrderSide::Ask => 1u8,
    });
    sha256(&d)
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn new_book(pair_bytes: &[u8], nonce: &[u8; 32]) -> Result<OrderBook, OrderError> {
    if pair_bytes.is_empty() {
        return Err(OrderError::ZeroPair);
    }
    let pair_hash = compute_pair_hash(pair_bytes);
    let book_id = compute_book_id(&pair_hash, nonce);
    Ok(OrderBook {
        book_id,
        pair_hash,
        order_count: 0,
        best_bid_commitment: [0u8; 32],
        best_ask_commitment: [0u8; 32],
        mainnet_ready: false,
    })
}

pub fn submit_order(
    book: &mut OrderBook,
    trader_secret: &[u8; 32],
    side: OrderSide,
    price: u64,
    amount: u64,
    blinding: &[u8; 32],
) -> Result<Order, OrderError> {
    if trader_secret == &[0u8; 32] {
        return Err(OrderError::ZeroTraderSecret);
    }
    if price == 0 {
        return Err(OrderError::ZeroPrice);
    }
    if amount == 0 {
        return Err(OrderError::ZeroAmount);
    }
    let trader_hash = compute_trader_hash(trader_secret);
    let price_commitment = compute_price_commitment(price, blinding);
    let amount_commitment = compute_amount_commitment(amount, blinding);
    let order_id = compute_order_id(
        &book.book_id,
        &trader_hash,
        &price_commitment,
        &amount_commitment,
        &side,
    );
    book.order_count += 1;
    Ok(Order {
        order_id,
        trader_hash,
        side,
        price_commitment,
        amount_commitment,
        mainnet_ready: false,
    })
}

pub fn book_public_record(book: &OrderBook) -> String {
    serde_json::json!({
        "book_id":      hex(&book.book_id),
        "pair_hash":    hex(&book.pair_hash),
        "order_count":  book.order_count,
        "mainnet_ready": book.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn trader() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xab;
        s
    }
    fn nonce() -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = 0x01;
        n
    }
    fn blind() -> [u8; 32] {
        let mut b = [0u8; 32];
        b[0] = 0x33;
        b
    }

    // Test 1: new book + submit order
    #[test]
    fn test_new_book_and_submit_order() {
        let mut book = new_book(b"SOL/USDC", &nonce()).unwrap();
        assert_eq!(book.order_count, 0);
        assert!(!book.mainnet_ready);
        let order = submit_order(&mut book, &trader(), OrderSide::Bid, 100, 50, &blind()).unwrap();
        assert_eq!(book.order_count, 1);
        assert!(!order.mainnet_ready);
        assert_eq!(order.side, OrderSide::Bid);
    }

    // Test 2: bid vs ask produce different order_ids
    #[test]
    fn test_bid_vs_ask_different_order_ids() {
        let mut book = new_book(b"SOL/USDC", &nonce()).unwrap();
        let bid = submit_order(&mut book, &trader(), OrderSide::Bid, 100, 50, &blind()).unwrap();
        let ask = submit_order(&mut book, &trader(), OrderSide::Ask, 100, 50, &blind()).unwrap();
        assert_ne!(bid.order_id, ask.order_id);
    }

    // Test 3: zero price rejected
    #[test]
    fn test_zero_price_rejected() {
        let mut book = new_book(b"SOL/USDC", &nonce()).unwrap();
        let err = submit_order(&mut book, &trader(), OrderSide::Bid, 0, 50, &blind()).unwrap_err();
        assert_eq!(err, OrderError::ZeroPrice);
    }

    // Test 4: zero trader secret rejected
    #[test]
    fn test_zero_trader_rejected() {
        let mut book = new_book(b"SOL/USDC", &nonce()).unwrap();
        let err =
            submit_order(&mut book, &[0u8; 32], OrderSide::Bid, 100, 50, &blind()).unwrap_err();
        assert_eq!(err, OrderError::ZeroTraderSecret);
    }

    // Test 5: book_id is deterministic
    #[test]
    fn test_book_id_deterministic() {
        let b1 = new_book(b"SOL/USDC", &nonce()).unwrap();
        let b2 = new_book(b"SOL/USDC", &nonce()).unwrap();
        assert_eq!(b1.book_id, b2.book_id);
        // Different pair → different book_id
        let b3 = new_book(b"ETH/USDC", &nonce()).unwrap();
        assert_ne!(b1.book_id, b3.book_id);
    }

    // Test 6: public record hides trader hash
    #[test]
    fn test_public_record_hides_trader() {
        let mut book = new_book(b"SOL/USDC", &nonce()).unwrap();
        let order = submit_order(&mut book, &trader(), OrderSide::Bid, 100, 50, &blind()).unwrap();
        let record = book_public_record(&book);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["book_id"].is_string());
        assert_eq!(v["order_count"], 1);
        assert_eq!(v["mainnet_ready"], false);
        assert!(v.get("trader_hash").is_none());
        // Ensure trader_hash not in serialised record
        let serialised = json_safe(&record, &order.trader_hash);
        assert!(serialised);
    }

    fn json_safe(record: &str, trader_hash: &[u8; 32]) -> bool {
        let hash_hex: String = trader_hash.iter().map(|x| format!("{:02x}", x)).collect();
        !record.contains(&hash_hex)
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_book_id_nonzero() {
        let book = new_book(b"SOL/USDC", &nonce()).unwrap();
        assert_ne!(book.book_id, [0u8; 32]);
    }

    #[test]
    fn test_pair_hash_nonzero() {
        let book = new_book(b"SOL/USDC", &nonce()).unwrap();
        assert_ne!(book.pair_hash, [0u8; 32]);
    }

    #[test]
    fn test_order_id_nonzero() {
        let mut book = new_book(b"SOL/USDC", &nonce()).unwrap();
        let order = submit_order(&mut book, &trader(), OrderSide::Bid, 100, 50, &blind()).unwrap();
        assert_ne!(order.order_id, [0u8; 32]);
    }

    #[test]
    fn test_trader_hash_nonzero() {
        let mut book = new_book(b"SOL/USDC", &nonce()).unwrap();
        let order = submit_order(&mut book, &trader(), OrderSide::Bid, 100, 50, &blind()).unwrap();
        assert_ne!(order.trader_hash, [0u8; 32]);
    }

    #[test]
    fn test_price_commitment_nonzero() {
        let mut book = new_book(b"SOL/USDC", &nonce()).unwrap();
        let order = submit_order(&mut book, &trader(), OrderSide::Bid, 100, 50, &blind()).unwrap();
        assert_ne!(order.price_commitment, [0u8; 32]);
    }

    #[test]
    fn test_amount_commitment_nonzero() {
        let mut book = new_book(b"SOL/USDC", &nonce()).unwrap();
        let order = submit_order(&mut book, &trader(), OrderSide::Bid, 100, 50, &blind()).unwrap();
        assert_ne!(order.amount_commitment, [0u8; 32]);
    }

    #[test]
    fn test_order_mainnet_ready_false() {
        let mut book = new_book(b"SOL/USDC", &nonce()).unwrap();
        let order = submit_order(&mut book, &trader(), OrderSide::Bid, 100, 50, &blind()).unwrap();
        assert!(!order.mainnet_ready);
    }

    #[test]
    fn test_order_count_increments() {
        let mut book = new_book(b"SOL/USDC", &nonce()).unwrap();
        assert_eq!(book.order_count, 0);
        submit_order(&mut book, &trader(), OrderSide::Bid, 100, 50, &blind()).unwrap();
        assert_eq!(book.order_count, 1);
        submit_order(&mut book, &trader(), OrderSide::Ask, 110, 40, &blind()).unwrap();
        assert_eq!(book.order_count, 2);
    }

    #[test]
    fn test_zero_amount_rejected() {
        let mut book = new_book(b"SOL/USDC", &nonce()).unwrap();
        let err = submit_order(&mut book, &trader(), OrderSide::Bid, 100, 0, &blind()).unwrap_err();
        assert_eq!(err, OrderError::ZeroAmount);
    }

    #[test]
    fn test_empty_pair_rejected() {
        let err = new_book(b"", &nonce()).unwrap_err();
        assert_eq!(err, OrderError::ZeroPair);
    }
}
