use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OracleFeed {
    pub feed_id: [u8; 32],
    pub oracle_hash: [u8; 32],
    pub asset_hash: [u8; 32],
    pub price_commitment: [u8; 32],
    pub timestamp: i64,
    pub round: u64,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriceAttestation {
    pub attestation_id: [u8; 32],
    pub feed_id: [u8; 32],
    pub price_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum OracleError {
    ZeroOracleSecret,
    EmptyAsset,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256_bytes(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

pub fn compute_oracle_hash(secret: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"ofd-oracle-v1");
    d.extend_from_slice(secret);
    sha256_bytes(&d)
}

pub fn compute_asset_hash(asset_bytes: &[u8]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"ofd-asset-v1");
    d.extend_from_slice(asset_bytes);
    sha256_bytes(&d)
}

pub fn compute_feed_id(oracle_hash: &[u8; 32], asset_hash: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"ofd-id-v1");
    d.extend_from_slice(oracle_hash);
    d.extend_from_slice(asset_hash);
    sha256_bytes(&d)
}

pub fn compute_price_commitment(price: u64, blinding: &[u8; 32], timestamp: i64) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"ofd-price-v1");
    d.extend_from_slice(&price.to_le_bytes());
    d.extend_from_slice(blinding);
    d.extend_from_slice(&timestamp.to_le_bytes());
    sha256_bytes(&d)
}

pub fn compute_price_hash(price: u64, timestamp: i64) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"ofd-pricehash-v1");
    d.extend_from_slice(&price.to_le_bytes());
    d.extend_from_slice(&timestamp.to_le_bytes());
    sha256_bytes(&d)
}

pub fn compute_attestation_id(feed_id: &[u8; 32], price_hash: &[u8; 32], round: u64) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"ofd-attest-v1");
    d.extend_from_slice(feed_id);
    d.extend_from_slice(price_hash);
    d.extend_from_slice(&round.to_le_bytes());
    sha256_bytes(&d)
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn new_feed(oracle_secret: &[u8; 32], asset_bytes: &[u8]) -> Result<OracleFeed, OracleError> {
    if oracle_secret == &[0u8; 32] {
        return Err(OracleError::ZeroOracleSecret);
    }
    if asset_bytes.is_empty() {
        return Err(OracleError::EmptyAsset);
    }
    let oracle_hash     = compute_oracle_hash(oracle_secret);
    let asset_hash      = compute_asset_hash(asset_bytes);
    let feed_id         = compute_feed_id(&oracle_hash, &asset_hash);
    Ok(OracleFeed {
        feed_id,
        oracle_hash,
        asset_hash,
        price_commitment: [0u8; 32],
        timestamp: 0,
        round: 0,
        mainnet_ready: false,
    })
}

pub fn update_price(feed: &mut OracleFeed, price: u64, blinding: &[u8; 32], timestamp: i64) {
    feed.price_commitment = compute_price_commitment(price, blinding, timestamp);
    feed.timestamp        = timestamp;
    feed.round           += 1;
}

pub fn attest_price(feed: &OracleFeed, price: u64) -> PriceAttestation {
    let price_hash      = compute_price_hash(price, feed.timestamp);
    let attestation_id  = compute_attestation_id(&feed.feed_id, &price_hash, feed.round);
    PriceAttestation {
        attestation_id,
        feed_id: feed.feed_id,
        price_hash,
        mainnet_ready: false,
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn secret(b: u8) -> [u8; 32] { [b; 32] }
    fn blinding(b: u8) -> [u8; 32] { [b; 32] }

    // Test 1: new_feed correct hashes + mainnet_ready=false
    #[test]
    fn test_new_feed_correct_hashes() {
        let feed = new_feed(&secret(0xa1), b"BTC/USD").unwrap();
        assert!(!feed.mainnet_ready);
        assert_eq!(feed.round, 0);
        assert_eq!(feed.timestamp, 0);

        let expected_oracle = compute_oracle_hash(&secret(0xa1));
        let expected_asset  = compute_asset_hash(b"BTC/USD");
        let expected_feed   = compute_feed_id(&expected_oracle, &expected_asset);
        assert_eq!(feed.oracle_hash, expected_oracle);
        assert_eq!(feed.asset_hash, expected_asset);
        assert_eq!(feed.feed_id, expected_feed);
    }

    // Test 2: update_price changes commitment
    #[test]
    fn test_update_price_changes_commitment() {
        let mut feed = new_feed(&secret(0xa1), b"ETH/USD").unwrap();
        let commit_before = feed.price_commitment;
        update_price(&mut feed, 2000_00000000u64, &blinding(0x55), 1_700_000_000i64);
        assert_ne!(feed.price_commitment, commit_before);

        let expected = compute_price_commitment(2000_00000000u64, &blinding(0x55), 1_700_000_000i64);
        assert_eq!(feed.price_commitment, expected);
    }

    // Test 3: round increments
    #[test]
    fn test_round_increments() {
        let mut feed = new_feed(&secret(0xa1), b"SOL/USD").unwrap();
        assert_eq!(feed.round, 0);
        update_price(&mut feed, 100_00000000, &blinding(0x01), 1000);
        assert_eq!(feed.round, 1);
        update_price(&mut feed, 101_00000000, &blinding(0x02), 2000);
        assert_eq!(feed.round, 2);
    }

    // Test 4: attest_price is deterministic
    #[test]
    fn test_attest_price_deterministic() {
        let mut feed = new_feed(&secret(0xa1), b"BTC/USD").unwrap();
        update_price(&mut feed, 30000_00000000, &blinding(0x55), 1_700_000_000i64);
        let att1 = attest_price(&feed, 30000_00000000);
        let att2 = attest_price(&feed, 30000_00000000);
        assert_eq!(att1.attestation_id, att2.attestation_id);
        assert!(!att1.mainnet_ready);
    }

    // Test 5: different assets give different feed_ids
    #[test]
    fn test_different_assets_different_feed_ids() {
        let feed_btc = new_feed(&secret(0xa1), b"BTC/USD").unwrap();
        let feed_eth = new_feed(&secret(0xa1), b"ETH/USD").unwrap();
        assert_ne!(feed_btc.feed_id, feed_eth.feed_id);
    }

    // Test 6: price_commitment uses blinding
    #[test]
    fn test_price_commitment_uses_blinding() {
        let c1 = compute_price_commitment(1000, &blinding(0x11), 1000);
        let c2 = compute_price_commitment(1000, &blinding(0x22), 1000);
        assert_ne!(c1, c2);
    }
}
