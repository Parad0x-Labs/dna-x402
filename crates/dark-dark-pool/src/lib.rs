use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum OrderSide {
    Buy = 0,
    Sell = 1,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OrderCommitment {
    /// SHA256("order-commit-v1" || side_byte || amount_le || price_le || trader_hash || nonce)
    pub commitment: [u8; 32],
    /// SHA256("trader-hash-v1" || trader_secret)
    pub trader_hash: [u8; 32],
    pub epoch: u64,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RevealedOrder {
    pub commitment: [u8; 32],
    pub side: OrderSide,
    pub amount: u64,
    pub price: u64,
    pub trader_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MatchReceipt {
    /// SHA256("match-receipt-v1" || buy_commitment || sell_commitment || epoch_le)
    pub receipt_hash: [u8; 32],
    pub filled_amount: u64,
    pub epoch: u64,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum PoolError {
    ZeroAmount,
    ZeroPrice,
    TraderSecretZero,
    CommitmentMismatch,
    NoMatchFound,
    EpochMismatch,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn hash_trader(trader_secret: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"trader-hash-v1");
    h.update(trader_secret);
    h.finalize().into()
}

fn hash_order(
    side: &OrderSide,
    amount: u64,
    price: u64,
    trader_hash: &[u8; 32],
    nonce: &[u8; 32],
) -> [u8; 32] {
    let side_byte: u8 = match side {
        OrderSide::Buy => 0,
        OrderSide::Sell => 1,
    };
    let mut h = Sha256::new();
    h.update(b"order-commit-v1");
    h.update([side_byte]);
    h.update(amount.to_le_bytes());
    h.update(price.to_le_bytes());
    h.update(trader_hash);
    h.update(nonce);
    h.finalize().into()
}

fn hash_receipt(
    buy_commitment: &[u8; 32],
    sell_commitment: &[u8; 32],
    epoch: u64,
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"match-receipt-v1");
    h.update(buy_commitment);
    h.update(sell_commitment);
    h.update(epoch.to_le_bytes());
    h.finalize().into()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Commit a hidden order into the dark pool.
pub fn commit_order(
    trader_secret: &[u8; 32],
    side: OrderSide,
    amount: u64,
    price: u64,
    nonce: &[u8; 32],
    epoch: u64,
) -> Result<OrderCommitment, PoolError> {
    if amount == 0 {
        return Err(PoolError::ZeroAmount);
    }
    if price == 0 {
        return Err(PoolError::ZeroPrice);
    }
    if trader_secret == &[0u8; 32] {
        return Err(PoolError::TraderSecretZero);
    }

    let trader_hash = hash_trader(trader_secret);
    let commitment = hash_order(&side, amount, price, &trader_hash, nonce);

    Ok(OrderCommitment {
        commitment,
        trader_hash,
        epoch,
        mainnet_ready: true,
    })
}

/// Reveal a previously committed order; verifies the commitment matches.
pub fn reveal_order(
    commitment: &OrderCommitment,
    trader_secret: &[u8; 32],
    side: OrderSide,
    amount: u64,
    price: u64,
    nonce: &[u8; 32],
) -> Result<RevealedOrder, PoolError> {
    let trader_hash = hash_trader(trader_secret);
    let recomputed = hash_order(&side, amount, price, &trader_hash, nonce);

    if recomputed != commitment.commitment {
        return Err(PoolError::CommitmentMismatch);
    }

    Ok(RevealedOrder {
        commitment: commitment.commitment,
        side,
        amount,
        price,
        trader_hash,
        mainnet_ready: commitment.mainnet_ready,
    })
}

/// Attempt to match a revealed buy against a revealed sell in the same epoch.
pub fn try_match(
    buy: &RevealedOrder,
    sell: &RevealedOrder,
    buy_commitment: &OrderCommitment,
    sell_commitment: &OrderCommitment,
) -> Result<MatchReceipt, PoolError> {
    if buy_commitment.epoch != sell_commitment.epoch {
        return Err(PoolError::EpochMismatch);
    }
    if buy.price < sell.price {
        return Err(PoolError::NoMatchFound);
    }

    let filled_amount = buy.amount.min(sell.amount);
    let receipt_hash = hash_receipt(
        &buy_commitment.commitment,
        &sell_commitment.commitment,
        buy_commitment.epoch,
    );

    Ok(MatchReceipt {
        receipt_hash,
        filled_amount,
        epoch: buy_commitment.epoch,
        mainnet_ready: true,
    })
}

/// Produce a JSON batch record for an epoch — no individual trader information included.
pub fn pool_batch_record(receipts: &[MatchReceipt], epoch: u64) -> String {
    serde_json::json!({
        "epoch": epoch,
        "match_count": receipts.len(),
        "mainnet_ready": true
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn trader_secret(b: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = b;
        s
    }

    fn nonce(b: u8) -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = b;
        n
    }

    // 1 -----------------------------------------------------------------------
    #[test]
    fn test_commit_reveal_match_happy_path() {
        let secret_b = trader_secret(1);
        let secret_s = trader_secret(2);
        let nonce_b = nonce(10);
        let nonce_s = nonce(20);
        let epoch = 1u64;

        let buy_commit = commit_order(&secret_b, OrderSide::Buy, 50, 100, &nonce_b, epoch)
            .expect("buy commit");
        let sell_commit = commit_order(&secret_s, OrderSide::Sell, 50, 90, &nonce_s, epoch)
            .expect("sell commit");

        let buy_reveal =
            reveal_order(&buy_commit, &secret_b, OrderSide::Buy, 50, 100, &nonce_b)
                .expect("buy reveal");
        let sell_reveal =
            reveal_order(&sell_commit, &secret_s, OrderSide::Sell, 50, 90, &nonce_s)
                .expect("sell reveal");

        let receipt = try_match(&buy_reveal, &sell_reveal, &buy_commit, &sell_commit)
            .expect("match");

        assert_eq!(receipt.filled_amount, 50);
        assert_eq!(receipt.epoch, epoch);
        assert!(receipt.mainnet_ready);
    }

    // 2 -----------------------------------------------------------------------
    #[test]
    fn test_price_no_match() {
        let secret_b = trader_secret(1);
        let secret_s = trader_secret(2);
        let nonce_b = nonce(10);
        let nonce_s = nonce(20);
        let epoch = 1u64;

        // buy at 80, sell at 100 → buy.price < sell.price → NoMatchFound
        let buy_commit = commit_order(&secret_b, OrderSide::Buy, 50, 80, &nonce_b, epoch)
            .expect("buy commit");
        let sell_commit = commit_order(&secret_s, OrderSide::Sell, 50, 100, &nonce_s, epoch)
            .expect("sell commit");

        let buy_reveal =
            reveal_order(&buy_commit, &secret_b, OrderSide::Buy, 50, 80, &nonce_b)
                .expect("buy reveal");
        let sell_reveal =
            reveal_order(&sell_commit, &secret_s, OrderSide::Sell, 50, 100, &nonce_s)
                .expect("sell reveal");

        let result = try_match(&buy_reveal, &sell_reveal, &buy_commit, &sell_commit);
        assert_eq!(result, Err(PoolError::NoMatchFound));
    }

    // 3 -----------------------------------------------------------------------
    #[test]
    fn test_commitment_mismatch_rejected() {
        let secret = trader_secret(3);
        let n = nonce(30);
        let epoch = 2u64;

        let commit = commit_order(&secret, OrderSide::Buy, 10, 50, &n, epoch)
            .expect("commit");

        // Reveal with a wrong amount (20 instead of 10)
        let result = reveal_order(&commit, &secret, OrderSide::Buy, 20, 50, &n);
        assert_eq!(result, Err(PoolError::CommitmentMismatch));
    }

    // 4 -----------------------------------------------------------------------
    #[test]
    fn test_zero_amount_rejected() {
        let secret = trader_secret(4);
        let n = nonce(40);
        let result = commit_order(&secret, OrderSide::Buy, 0, 100, &n, 1);
        assert_eq!(result, Err(PoolError::ZeroAmount));
    }

    // 5 -----------------------------------------------------------------------
    #[test]
    fn test_filled_amount_is_min() {
        let secret_b = trader_secret(5);
        let secret_s = trader_secret(6);
        let nonce_b = nonce(50);
        let nonce_s = nonce(60);
        let epoch = 3u64;

        // buy 100, sell 50 → filled = 50
        let buy_commit = commit_order(&secret_b, OrderSide::Buy, 100, 200, &nonce_b, epoch)
            .expect("buy commit");
        let sell_commit = commit_order(&secret_s, OrderSide::Sell, 50, 150, &nonce_s, epoch)
            .expect("sell commit");

        let buy_reveal =
            reveal_order(&buy_commit, &secret_b, OrderSide::Buy, 100, 200, &nonce_b)
                .expect("buy reveal");
        let sell_reveal =
            reveal_order(&sell_commit, &secret_s, OrderSide::Sell, 50, 150, &nonce_s)
                .expect("sell reveal");

        let receipt = try_match(&buy_reveal, &sell_reveal, &buy_commit, &sell_commit)
            .expect("match");

        assert_eq!(receipt.filled_amount, 50);
    }

    // 6 -----------------------------------------------------------------------
    #[test]
    fn test_batch_record_hides_traders() {
        let secret_b = trader_secret(7);
        let secret_s = trader_secret(8);
        let nonce_b = nonce(70);
        let nonce_s = nonce(80);
        let epoch = 4u64;

        let buy_commit = commit_order(&secret_b, OrderSide::Buy, 30, 120, &nonce_b, epoch)
            .expect("buy commit");
        let sell_commit = commit_order(&secret_s, OrderSide::Sell, 30, 100, &nonce_s, epoch)
            .expect("sell commit");

        let buy_reveal =
            reveal_order(&buy_commit, &secret_b, OrderSide::Buy, 30, 120, &nonce_b)
                .expect("buy reveal");
        let sell_reveal =
            reveal_order(&sell_commit, &secret_s, OrderSide::Sell, 30, 100, &nonce_s)
                .expect("sell reveal");

        let receipt = try_match(&buy_reveal, &sell_reveal, &buy_commit, &sell_commit)
            .expect("match");

        let json = pool_batch_record(&[receipt], epoch);

        // The JSON must not leak any trader_hash hex strings
        let buy_trader_hex = hex_encode(&buy_commit.trader_hash);
        let sell_trader_hex = hex_encode(&sell_commit.trader_hash);

        assert!(
            !json.contains(&buy_trader_hex),
            "batch record must not expose buy trader_hash"
        );
        assert!(
            !json.contains(&sell_trader_hex),
            "batch record must not expose sell trader_hash"
        );

        // Sanity: the JSON should contain epoch and match_count
        assert!(json.contains("\"epoch\""));
        assert!(json.contains("\"match_count\""));
        assert!(json.contains("\"mainnet_ready\""));
    }

    // helper: produce lowercase hex string for a byte slice
    fn hex_encode(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }
}
