use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SwapOffer {
    pub offer_id: [u8; 32],
    pub input_token_hash: [u8; 32],
    pub output_token_hash: [u8; 32],
    pub amount_in: u64,
    pub amount_out: u64,
    pub trader_hash: [u8; 32],
    pub nonce: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SwapReceipt {
    pub swap_id: [u8; 32],
    pub offer_id: [u8; 32],
    pub nullifier: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SwapError {
    ZeroTraderSecret,
    AmountZero,
    TokenHashesIdentical,
    AlreadyFilled,
}

impl std::fmt::Display for SwapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SwapError::ZeroTraderSecret => write!(f, "trader secret must not be all-zero"),
            SwapError::AmountZero => write!(f, "amount_in and amount_out must be non-zero"),
            SwapError::TokenHashesIdentical => {
                write!(f, "input and output tokens must be different")
            }
            SwapError::AlreadyFilled => write!(f, "offer has already been filled"),
        }
    }
}

impl std::error::Error for SwapError {}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn sha256_domain(domain: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(domain);
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn hash_trader(secret: &[u8; 32]) -> [u8; 32] {
    sha256_domain(b"swap-trader-v1", &[secret])
}

fn hash_token(token_bytes: &[u8]) -> [u8; 32] {
    sha256_domain(b"swap-token-v1", &[token_bytes])
}

fn hash_offer(
    trader_hash: &[u8; 32],
    input_token_hash: &[u8; 32],
    output_token_hash: &[u8; 32],
    amount_in: u64,
    amount_out: u64,
    nonce: &[u8; 32],
) -> [u8; 32] {
    sha256_domain(
        b"swap-offer-v1",
        &[
            trader_hash,
            input_token_hash,
            output_token_hash,
            &amount_in.to_le_bytes(),
            &amount_out.to_le_bytes(),
            nonce,
        ],
    )
}

fn hash_swap_id(offer_id: &[u8; 32], block_slot: u64) -> [u8; 32] {
    sha256_domain(b"swap-id-v1", &[offer_id, &block_slot.to_le_bytes()])
}

fn hash_nullifier(offer_id: &[u8; 32], trader_hash: &[u8; 32]) -> [u8; 32] {
    sha256_domain(b"swap-null-v1", &[offer_id, trader_hash])
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Build an anonymous swap offer.
///
/// Errors:
/// - `ZeroTraderSecret`      -- trader_secret is all-zero bytes
/// - `AmountZero`            -- either amount is 0
/// - `TokenHashesIdentical`  -- input_token and output_token bytes are equal
pub fn create_offer(
    trader_secret: &[u8; 32],
    input_token: &[u8],
    output_token: &[u8],
    amount_in: u64,
    amount_out: u64,
    nonce: &[u8; 32],
) -> Result<SwapOffer, SwapError> {
    if trader_secret == &[0u8; 32] {
        return Err(SwapError::ZeroTraderSecret);
    }
    if amount_in == 0 || amount_out == 0 {
        return Err(SwapError::AmountZero);
    }
    if input_token == output_token {
        return Err(SwapError::TokenHashesIdentical);
    }

    let trader_hash = hash_trader(trader_secret);
    let input_token_hash = hash_token(input_token);
    let output_token_hash = hash_token(output_token);
    let offer_id = hash_offer(
        &trader_hash,
        &input_token_hash,
        &output_token_hash,
        amount_in,
        amount_out,
        nonce,
    );

    Ok(SwapOffer {
        offer_id,
        input_token_hash,
        output_token_hash,
        amount_in,
        amount_out,
        trader_hash,
        nonce: *nonce,
        mainnet_ready: false,
    })
}

/// Fill an offer at a given block slot, returning a receipt.
///
/// `mainnet_ready` is always `false`.
pub fn fill_offer(offer: &SwapOffer, block_slot: u64) -> SwapReceipt {
    let swap_id = hash_swap_id(&offer.offer_id, block_slot);
    let nullifier = hash_nullifier(&offer.offer_id, &offer.trader_hash);

    SwapReceipt {
        swap_id,
        offer_id: offer.offer_id,
        nullifier,
        mainnet_ready: false,
    }
}

/// Return a JSON string with the public (non-private) fields of an offer.
///
/// Intentionally omits `trader_hash` and `nonce`.
pub fn swap_public_record(offer: &SwapOffer) -> String {
    let record = serde_json::json!({
        "offer_id":          hex_encode(&offer.offer_id),
        "input_token_hash":  hex_encode(&offer.input_token_hash),
        "output_token_hash": hex_encode(&offer.output_token_hash),
        "amount_in":         offer.amount_in,
        "amount_out":        offer.amount_out,
        "mainnet_ready":     offer.mainnet_ready,
    });
    record.to_string()
}

// ---------------------------------------------------------------------------
// Tiny hex helper (no extra dep)
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

    fn sample_secret() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xde;
        s[1] = 0xad;
        s[31] = 0x01;
        s
    }

    fn sample_nonce() -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = 0xca;
        n[31] = 0xfe;
        n
    }

    /// 1. create offer -> fill -> receipt has valid (non-zero) swap_id and nullifier.
    #[test]
    fn test_create_fill_roundtrip() {
        let offer = create_offer(
            &sample_secret(),
            b"TOKEN_A",
            b"TOKEN_B",
            1_000,
            2_000,
            &sample_nonce(),
        )
        .expect("should create offer");

        assert!(!offer.mainnet_ready);

        let receipt = fill_offer(&offer, 42_000_000);

        assert_eq!(receipt.offer_id, offer.offer_id);
        assert!(!receipt.mainnet_ready);
        // swap_id and nullifier must be non-zero
        assert_ne!(receipt.swap_id, [0u8; 32]);
        assert_ne!(receipt.nullifier, [0u8; 32]);
    }

    /// 2. Two offers with different amounts produce different nullifiers.
    #[test]
    fn test_nullifier_unique_per_offer() {
        let offer_a = create_offer(
            &sample_secret(),
            b"TOKEN_A",
            b"TOKEN_B",
            1_000,
            2_000,
            &sample_nonce(),
        )
        .unwrap();
        let offer_b = create_offer(
            &sample_secret(),
            b"TOKEN_A",
            b"TOKEN_B",
            9_999,
            1_000,
            &sample_nonce(),
        )
        .unwrap();

        let receipt_a = fill_offer(&offer_a, 1);
        let receipt_b = fill_offer(&offer_b, 1);

        assert_ne!(receipt_a.nullifier, receipt_b.nullifier);
    }

    /// 3. All-zero trader secret is rejected.
    #[test]
    fn test_zero_trader_secret_rejected() {
        let result = create_offer(&[0u8; 32], b"TOKEN_A", b"TOKEN_B", 1_000, 2_000, &[0u8; 32]);
        assert_eq!(result, Err(SwapError::ZeroTraderSecret));
    }

    /// 4. amount_in = 0 is rejected.
    #[test]
    fn test_amount_zero_rejected() {
        let result = create_offer(
            &sample_secret(),
            b"TOKEN_A",
            b"TOKEN_B",
            0,
            2_000,
            &sample_nonce(),
        );
        assert_eq!(result, Err(SwapError::AmountZero));
    }

    /// 5. Same bytes for input and output token is rejected.
    #[test]
    fn test_identical_tokens_rejected() {
        let result = create_offer(
            &sample_secret(),
            b"SAME_TOKEN",
            b"SAME_TOKEN",
            1_000,
            2_000,
            &sample_nonce(),
        );
        assert_eq!(result, Err(SwapError::TokenHashesIdentical));
    }

    /// 6. Public record must not contain the hex of trader_hash.
    #[test]
    fn test_public_record_hides_trader() {
        let offer = create_offer(
            &sample_secret(),
            b"TOKEN_A",
            b"TOKEN_B",
            1_000,
            2_000,
            &sample_nonce(),
        )
        .unwrap();

        let record = swap_public_record(&offer);
        let trader_hex = hex_encode(&offer.trader_hash);

        assert!(
            !record.contains(&trader_hex),
            "public record must not expose trader_hash; got record: {record}"
        );
    }
}
