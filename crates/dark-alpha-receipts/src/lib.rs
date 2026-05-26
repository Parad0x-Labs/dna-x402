//! dark-alpha-receipts — Anti-Copytrading Receipt Layer
//!
//! Traders commit PnL and trade evidence at epoch start.
//! Public sees: epoch score + delayed proofs (no live wallet, no live token).
//! Paid subscribers see: real-time decoded reveals.
//! Receipt DAG is append-only — every trade commitment chains to previous.
//!
//! Daily use case: A Solana trader commits their weekly PnL and each trade
//! to an append-only hash chain. Followers pay per trade reveal or a daily
//! subscription. The trader's live execution wallet is NEVER published.
//! Copytraders cannot scrape the wallet because the execution session is
//! separate from the public proof identity.
//!
//! NOT_PRODUCTION — devnet only. Not audited. mainnet_ready = false.

use sha2::{Digest, Sha256};
use thiserror::Error;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Controls when / how a trade reveal is made available to observers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RevealPolicy {
    /// Only paying subscribers may receive reveals.
    PaidOnly,
    /// Reveals become freely available after the specified delay.
    DelayedFree { delay_seconds: u64 },
    /// Reveals are always free and immediate.
    FreeAlways,
}

/// A trading session that maps a (hidden) wallet to a public session identity.
/// The live wallet is never stored here — only its hash is used when creating
/// the session.
#[derive(Debug, Clone)]
pub struct TraderSession {
    pub session_hash: [u8; 32],
    pub epoch: u32,
    pub reveal_policy: RevealPolicy,
    pub delay_seconds: u64,
}

/// A blinded commitment to a single trade event.
/// token_hash = SHA256(token_mint_bytes) — raw mint is never stored.
/// side_byte:   0x01 = buy, 0x02 = sell
/// size_bucket: 0x01 = small, 0x02 = medium, 0x03 = large, 0x04 = whale
/// slot_hash  = SHA256(slot_number.to_le_bytes())
#[derive(Debug, Clone, PartialEq)]
pub struct TradeCommitment {
    pub commitment_hash: [u8; 32],
    pub session_hash: [u8; 32],
    pub token_hash: [u8; 32],
    pub side_byte: u8,
    pub size_bucket: u8,
    pub slot_hash: [u8; 32],
    pub replay_key: [u8; 32],
    pub created_at_unix: u64,
}

/// A blinded commitment to the aggregate PnL for an epoch.
/// pnl_basis_points may be negative (loss).
#[derive(Debug, Clone, PartialEq)]
pub struct PnlCommitment {
    pub commitment_hash: [u8; 32],
    pub session_hash: [u8; 32],
    pub epoch: u32,
    pub pnl_basis_points: i32,
    pub trade_count: u32,
    pub signed_at_unix: u64,
}

/// A paid (or delayed-free) reveal of a single trade commitment.
/// subscriber_hash = SHA256(subscriber_pubkey).
#[derive(Debug, Clone, PartialEq)]
pub struct TradeReveal {
    pub reveal_hash: [u8; 32],
    pub original_commitment_hash: [u8; 32],
    pub revealed_token_hash: [u8; 32],
    pub revealed_side: u8,
    pub revealed_size_bucket: u8,
    pub revealed_slot_hash: [u8; 32],
    pub subscriber_hash: [u8; 32],
    pub revealed_at_unix: u64,
}

/// A public-facing PnL performance card.
/// Contains NO wallet address and NO raw token name.
/// badge_label format: "+{pnl/100}% epoch {epoch}" or "LOSS {|pnl|/100}% epoch {epoch}"
#[derive(Debug, Clone)]
pub struct PnlCard {
    pub card_hash: [u8; 32],
    pub epoch: u32,
    pub pnl_basis_points: i32,
    pub trade_count: u32,
    pub session_hash: [u8; 32],
    pub badge_label: String,
}

/// An append-only receipt chain node.
#[derive(Debug, Clone)]
pub struct ReceiptChain {
    pub head_hash: [u8; 32],
    pub chain_length: u32,
    pub previous_hash: Option<[u8; 32]>,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, Error, PartialEq)]
pub enum AlphaReceiptsError {
    #[error("fake PnL detected — commitment does not match reported figures")]
    FakePnlDetected,
    #[error("edited history detected — chain integrity check failed")]
    EditedHistoryDetected,
    #[error("wrong subscriber — subscriber hash is invalid or zero")]
    WrongSubscriber,
    #[error("raw wallet address leaked — must not appear in public output")]
    RawWalletLeaked,
    #[error("raw token address leaked — must not appear in public output")]
    RawTokenLeaked,
    #[error("forbidden marketing claim: {0}")]
    ForbiddenClaim(String),
    #[error("replay detected — delay period has not elapsed")]
    ReplayDetected,
}

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

/// Convenience: compute SHA-256 of any number of byte slices concatenated.
fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/// Creates a deterministic session hash.
/// `session_salt` is a random [u8;32], `wallet_pubkey_bytes` is [u8;32].
///
/// Hash: SHA256("dark-null-session-v1" || session_salt || wallet_pubkey_bytes || epoch.to_le_bytes())
pub fn create_session_hash(
    session_salt: &[u8; 32],
    wallet_pubkey_bytes: &[u8; 32],
    epoch: u32,
) -> [u8; 32] {
    sha256_multi(&[
        b"dark-null-session-v1",
        session_salt.as_ref(),
        wallet_pubkey_bytes.as_ref(),
        &epoch.to_le_bytes(),
    ])
}

/// Creates a trade commitment.
/// `token_hash` = SHA256(token_mint_bytes) — never the raw mint.
///
/// commitment_hash: SHA256("dark-null-trade-v1" || session_hash || token_hash
///                         || [side_byte] || [size_bucket] || slot_hash
///                         || created_at_unix.to_le_bytes())
/// replay_key:      SHA256("dark-null-replay-v1" || commitment_hash || created_at_unix.to_le_bytes())
pub fn create_trade_commitment(
    session_hash: &[u8; 32],
    token_hash: &[u8; 32],
    side_byte: u8,
    size_bucket: u8,
    slot_hash: &[u8; 32],
    created_at_unix: u64,
) -> TradeCommitment {
    let commitment_hash = sha256_multi(&[
        b"dark-null-trade-v1",
        session_hash.as_ref(),
        token_hash.as_ref(),
        &[side_byte],
        &[size_bucket],
        slot_hash.as_ref(),
        &created_at_unix.to_le_bytes(),
    ]);

    let replay_key = sha256_multi(&[
        b"dark-null-replay-v1",
        commitment_hash.as_ref(),
        &created_at_unix.to_le_bytes(),
    ]);

    TradeCommitment {
        commitment_hash,
        session_hash: *session_hash,
        token_hash: *token_hash,
        side_byte,
        size_bucket,
        slot_hash: *slot_hash,
        replay_key,
        created_at_unix,
    }
}

/// Creates a PnL commitment.
/// `pnl_basis_points`: i32, may be negative (loss).
///
/// Hash: SHA256("dark-null-pnl-v1" || session_hash || epoch.to_le_bytes()
///              || pnl_basis_points.to_le_bytes() || trade_count.to_le_bytes()
///              || signed_at_unix.to_le_bytes())
pub fn create_pnl_commitment(
    session_hash: &[u8; 32],
    epoch: u32,
    pnl_basis_points: i32,
    trade_count: u32,
    signed_at_unix: u64,
) -> PnlCommitment {
    let commitment_hash = sha256_multi(&[
        b"dark-null-pnl-v1",
        session_hash.as_ref(),
        &epoch.to_le_bytes(),
        &pnl_basis_points.to_le_bytes(),
        &trade_count.to_le_bytes(),
        &signed_at_unix.to_le_bytes(),
    ]);

    PnlCommitment {
        commitment_hash,
        session_hash: *session_hash,
        epoch,
        pnl_basis_points,
        trade_count,
        signed_at_unix,
    }
}

/// Creates a paid reveal for a specific subscriber.
/// `subscriber_hash` = SHA256(subscriber_pubkey).
/// Returns `Err(WrongSubscriber)` if subscriber_hash is all zeros.
///
/// reveal_hash: SHA256("dark-null-reveal-v1" || commitment_hash || subscriber_hash)
pub fn create_paid_reveal(
    trade_commitment: &TradeCommitment,
    subscriber_hash: &[u8; 32],
    revealed_at_unix: u64,
) -> Result<TradeReveal, AlphaReceiptsError> {
    if subscriber_hash == &[0u8; 32] {
        return Err(AlphaReceiptsError::WrongSubscriber);
    }

    let reveal_hash = sha256_multi(&[
        b"dark-null-reveal-v1",
        trade_commitment.commitment_hash.as_ref(),
        subscriber_hash.as_ref(),
    ]);

    Ok(TradeReveal {
        reveal_hash,
        original_commitment_hash: trade_commitment.commitment_hash,
        revealed_token_hash: trade_commitment.token_hash,
        revealed_side: trade_commitment.side_byte,
        revealed_size_bucket: trade_commitment.size_bucket,
        revealed_slot_hash: trade_commitment.slot_hash,
        subscriber_hash: *subscriber_hash,
        revealed_at_unix,
    })
}

/// Verifies a reveal was derived from the original commitment (tamper-proof).
/// Recomputes the reveal_hash from the stored fields and compares.
pub fn verify_reveal_integrity(original: &TradeCommitment, reveal: &TradeReveal) -> bool {
    // The reveal must reference the right commitment hash.
    if reveal.original_commitment_hash != original.commitment_hash {
        return false;
    }
    // The revealed fields must match the original blinded fields.
    if reveal.revealed_token_hash != original.token_hash {
        return false;
    }
    if reveal.revealed_side != original.side_byte {
        return false;
    }
    if reveal.revealed_size_bucket != original.size_bucket {
        return false;
    }
    if reveal.revealed_slot_hash != original.slot_hash {
        return false;
    }
    // Recompute and verify reveal_hash.
    let expected = sha256_multi(&[
        b"dark-null-reveal-v1",
        reveal.original_commitment_hash.as_ref(),
        reveal.subscriber_hash.as_ref(),
    ]);
    reveal.reveal_hash == expected
}

/// Creates a public PnL card.
/// badge_label: "+{pnl/100}% epoch {epoch}" (positive) or "LOSS {|pnl|/100}% epoch {epoch}" (negative/zero)
///
/// card_hash: SHA256("dark-null-card-v1" || pnl.commitment_hash || pnl.epoch.to_le_bytes())
pub fn create_pnl_card(pnl: &PnlCommitment) -> PnlCard {
    let card_hash = sha256_multi(&[
        b"dark-null-card-v1",
        pnl.commitment_hash.as_ref(),
        &pnl.epoch.to_le_bytes(),
    ]);

    // pnl_basis_points are hundredths of a percent (i.e. bps).
    // Display as integer percentage (bps / 100).
    let badge_label = if pnl.pnl_basis_points >= 0 {
        format!("+{}% epoch {}", pnl.pnl_basis_points / 100, pnl.epoch)
    } else {
        // Use abs for display, prefix with LOSS.
        format!(
            "LOSS {}% epoch {}",
            (-pnl.pnl_basis_points) / 100,
            pnl.epoch
        )
    };

    PnlCard {
        card_hash,
        epoch: pnl.epoch,
        pnl_basis_points: pnl.pnl_basis_points,
        trade_count: pnl.trade_count,
        session_hash: pnl.session_hash,
        badge_label,
    }
}

/// Verifies a PnL card does not leak wallet or token info.
/// Checks badge_label for forbidden strings: "wallet", "token", and any
/// base58-looking string longer than 30 chars (heuristic for pubkey leak).
pub fn verify_pnl_card_clean(card: &PnlCard) -> Result<(), AlphaReceiptsError> {
    let label_lower = card.badge_label.to_lowercase();

    if label_lower.contains("wallet") {
        return Err(AlphaReceiptsError::RawWalletLeaked);
    }
    if label_lower.contains("token") {
        return Err(AlphaReceiptsError::RawTokenLeaked);
    }

    // Heuristic: any run of base58 chars longer than 30 characters is
    // likely a raw pubkey or mint address.
    const BASE58_CHARS: &str = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut run = 0usize;
    for ch in card.badge_label.chars() {
        if BASE58_CHARS.contains(ch) {
            run += 1;
            if run > 30 {
                return Err(AlphaReceiptsError::RawWalletLeaked);
            }
        } else {
            run = 0;
        }
    }

    Ok(())
}

/// Creates a delayed reveal that becomes available after `delay_seconds` from
/// `trade_commitment.created_at_unix`.
/// Returns `Err(ReplayDetected)` if `current_unix < created_at_unix + delay_seconds`.
pub fn create_delayed_reveal(
    trade_commitment: &TradeCommitment,
    current_unix: u64,
    delay_seconds: u64,
) -> Result<TradeReveal, AlphaReceiptsError> {
    let available_at = trade_commitment
        .created_at_unix
        .saturating_add(delay_seconds);

    if current_unix < available_at {
        return Err(AlphaReceiptsError::ReplayDetected);
    }

    // Delayed reveals use a zeroed subscriber_hash (public, no specific subscriber).
    let subscriber_hash = [0u8; 32];
    // Use a distinct domain tag so delayed reveals get a different hash from paid reveals.
    let reveal_hash = sha256_multi(&[
        b"dark-null-delayed-reveal-v1",
        trade_commitment.commitment_hash.as_ref(),
        &current_unix.to_le_bytes(),
    ]);

    Ok(TradeReveal {
        reveal_hash,
        original_commitment_hash: trade_commitment.commitment_hash,
        revealed_token_hash: trade_commitment.token_hash,
        revealed_side: trade_commitment.side_byte,
        revealed_size_bucket: trade_commitment.size_bucket,
        revealed_slot_hash: trade_commitment.slot_hash,
        subscriber_hash,
        revealed_at_unix: current_unix,
    })
}

/// Chains a new receipt. Returns an updated `ReceiptChain` with incremented length.
///
/// head_hash: SHA256("dark-null-chain-v1" || new_commitment_hash || previous_head_hash_or_zeros)
pub fn chain_receipt(
    previous: Option<&ReceiptChain>,
    new_commitment_hash: &[u8; 32],
) -> ReceiptChain {
    let (prev_head, prev_len) = match previous {
        Some(p) => (p.head_hash, p.chain_length),
        None => ([0u8; 32], 0u32),
    };

    let head_hash = sha256_multi(&[
        b"dark-null-chain-v1",
        new_commitment_hash.as_ref(),
        prev_head.as_ref(),
    ]);

    ReceiptChain {
        head_hash,
        chain_length: prev_len + 1,
        previous_hash: previous.map(|p| p.head_hash),
    }
}

/// Verifies the receipt chain is intact (the chain's `previous_hash` matches
/// the provided `previous` chain's `head_hash`).
pub fn verify_chain_integrity(chain: &ReceiptChain, previous: Option<&ReceiptChain>) -> bool {
    match (chain.previous_hash, previous) {
        // Both chain and reference agree there is no previous link.
        (None, None) => true,
        // Chain claims no previous, but we were given one.
        (None, Some(_)) => false,
        // Chain claims a previous, but none was provided.
        (Some(_), None) => false,
        // Both exist: the stored previous_hash must equal the provided head_hash.
        (Some(stored_prev), Some(prev)) => stored_prev == prev.head_hash,
    }
}

/// Checks for forbidden marketing claims in any string.
/// Forbidden phrases: "guaranteed profit", "untraceable", "invisible wallet",
/// "undetectable", "mixer", "casino", "gambling"
pub fn check_forbidden_claims(text: &str) -> Result<(), AlphaReceiptsError> {
    const FORBIDDEN: &[&str] = &[
        "guaranteed profit",
        "untraceable",
        "invisible wallet",
        "undetectable",
        "mixer",
        "casino",
        "gambling",
    ];

    let lower = text.to_lowercase();
    for phrase in FORBIDDEN {
        if lower.contains(phrase) {
            return Err(AlphaReceiptsError::ForbiddenClaim(phrase.to_string()));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_salt() -> [u8; 32] {
        [0xABu8; 32]
    }

    fn dummy_wallet() -> [u8; 32] {
        [0x11u8; 32]
    }

    fn dummy_token_hash() -> [u8; 32] {
        sha256_multi(&[b"FAKE_TOKEN_MINT"])
    }

    fn dummy_slot_hash() -> [u8; 32] {
        sha256_multi(&[&42u64.to_le_bytes()])
    }

    fn dummy_subscriber() -> [u8; 32] {
        sha256_multi(&[b"subscriber_pubkey_bytes"])
    }

    // 1. Session hash is deterministic.
    #[test]
    fn test_session_hash_deterministic() {
        let h1 = create_session_hash(&dummy_salt(), &dummy_wallet(), 7);
        let h2 = create_session_hash(&dummy_salt(), &dummy_wallet(), 7);
        assert_eq!(h1, h2);
    }

    // 2. Different wallet → different session hash.
    #[test]
    fn test_session_hash_changes_with_wallet() {
        let wallet_a = [0x11u8; 32];
        let wallet_b = [0x22u8; 32];
        let h_a = create_session_hash(&dummy_salt(), &wallet_a, 7);
        let h_b = create_session_hash(&dummy_salt(), &wallet_b, 7);
        assert_ne!(h_a, h_b);
    }

    // 3. Trade commitment is deterministic.
    #[test]
    fn test_trade_commitment_deterministic() {
        let session = create_session_hash(&dummy_salt(), &dummy_wallet(), 1);
        let c1 = create_trade_commitment(
            &session,
            &dummy_token_hash(),
            0x01,
            0x02,
            &dummy_slot_hash(),
            1_700_000_000,
        );
        let c2 = create_trade_commitment(
            &session,
            &dummy_token_hash(),
            0x01,
            0x02,
            &dummy_slot_hash(),
            1_700_000_000,
        );
        assert_eq!(c1.commitment_hash, c2.commitment_hash);
        assert_eq!(c1.replay_key, c2.replay_key);
    }

    // 4. Same commitment, different time → different replay key.
    #[test]
    fn test_trade_commitment_replay_key_unique() {
        let session = create_session_hash(&dummy_salt(), &dummy_wallet(), 1);
        let c1 = create_trade_commitment(
            &session,
            &dummy_token_hash(),
            0x01,
            0x02,
            &dummy_slot_hash(),
            1_700_000_000,
        );
        let c2 = create_trade_commitment(
            &session,
            &dummy_token_hash(),
            0x01,
            0x02,
            &dummy_slot_hash(),
            1_700_000_001,
        );
        // commitment_hash differs too (created_at is in hash), but focus on replay_key.
        assert_ne!(c1.replay_key, c2.replay_key);
    }

    // 5. PnL commitment is deterministic.
    #[test]
    fn test_pnl_commitment_deterministic() {
        let session = create_session_hash(&dummy_salt(), &dummy_wallet(), 3);
        let p1 = create_pnl_commitment(&session, 3, 500, 10, 1_700_000_000);
        let p2 = create_pnl_commitment(&session, 3, 500, 10, 1_700_000_000);
        assert_eq!(p1.commitment_hash, p2.commitment_hash);
    }

    // 6. Paid reveal hash is stable.
    #[test]
    fn test_paid_reveal_hash_stable() {
        let session = create_session_hash(&dummy_salt(), &dummy_wallet(), 1);
        let tc = create_trade_commitment(
            &session,
            &dummy_token_hash(),
            0x01,
            0x01,
            &dummy_slot_hash(),
            1_000_000,
        );
        let sub = dummy_subscriber();
        let r1 = create_paid_reveal(&tc, &sub, 1_000_100).unwrap();
        let r2 = create_paid_reveal(&tc, &sub, 1_000_100).unwrap();
        assert_eq!(r1.reveal_hash, r2.reveal_hash);
    }

    // 7. verify_reveal_integrity returns true for a correct reveal.
    #[test]
    fn test_reveal_integrity_valid() {
        let session = create_session_hash(&dummy_salt(), &dummy_wallet(), 1);
        let tc = create_trade_commitment(
            &session,
            &dummy_token_hash(),
            0x01,
            0x02,
            &dummy_slot_hash(),
            1_000_000,
        );
        let sub = dummy_subscriber();
        let reveal = create_paid_reveal(&tc, &sub, 1_000_500).unwrap();
        assert!(verify_reveal_integrity(&tc, &reveal));
    }

    // 8. Changing revealed_token_hash makes verify_reveal_integrity return false.
    #[test]
    fn test_reveal_integrity_tampered() {
        let session = create_session_hash(&dummy_salt(), &dummy_wallet(), 1);
        let tc = create_trade_commitment(
            &session,
            &dummy_token_hash(),
            0x01,
            0x02,
            &dummy_slot_hash(),
            1_000_000,
        );
        let sub = dummy_subscriber();
        let mut reveal = create_paid_reveal(&tc, &sub, 1_000_500).unwrap();
        // Tamper with the revealed token hash.
        reveal.revealed_token_hash = [0xFFu8; 32];
        assert!(!verify_reveal_integrity(&tc, &reveal));
    }

    // 9. All-zero subscriber hash is rejected.
    #[test]
    fn test_wrong_subscriber_rejected() {
        let session = create_session_hash(&dummy_salt(), &dummy_wallet(), 1);
        let tc = create_trade_commitment(
            &session,
            &dummy_token_hash(),
            0x01,
            0x01,
            &dummy_slot_hash(),
            1_000_000,
        );
        let zero_sub = [0u8; 32];
        let result = create_paid_reveal(&tc, &zero_sub, 1_000_500);
        assert_eq!(result, Err(AlphaReceiptsError::WrongSubscriber));
    }

    // 10. PnL card badge_label does not contain "wallet" or a long base58 string.
    #[test]
    fn test_pnl_card_no_wallet_leak() {
        let session = create_session_hash(&dummy_salt(), &dummy_wallet(), 5);
        let pnl = create_pnl_commitment(&session, 5, 1_500, 20, 1_700_000_000);
        let card = create_pnl_card(&pnl);
        assert!(!card.badge_label.to_lowercase().contains("wallet"));
        // Verify no long base58 run.
        assert!(verify_pnl_card_clean(&card).is_ok());
    }

    // 11. Negative pnl_basis_points creates a LOSS label.
    #[test]
    fn test_pnl_card_negative_pnl() {
        let session = create_session_hash(&dummy_salt(), &dummy_wallet(), 2);
        let pnl = create_pnl_commitment(&session, 2, -300, 5, 1_700_000_000);
        let card = create_pnl_card(&pnl);
        assert!(
            card.badge_label.starts_with("LOSS"),
            "expected LOSS prefix, got: {}",
            card.badge_label
        );
        assert!(card.badge_label.contains("epoch 2"));
    }

    // 12. create_delayed_reveal returns Err(ReplayDetected) if called before delay expires.
    #[test]
    fn test_delayed_reveal_before_delay() {
        let session = create_session_hash(&dummy_salt(), &dummy_wallet(), 1);
        let created_at = 1_700_000_000u64;
        let tc = create_trade_commitment(
            &session,
            &dummy_token_hash(),
            0x01,
            0x01,
            &dummy_slot_hash(),
            created_at,
        );
        let delay = 3600u64;
        let too_early = created_at + delay - 1;
        let result = create_delayed_reveal(&tc, too_early, delay);
        assert_eq!(result, Err(AlphaReceiptsError::ReplayDetected));
    }

    // 13. create_delayed_reveal returns Ok after delay has elapsed.
    #[test]
    fn test_delayed_reveal_after_delay() {
        let session = create_session_hash(&dummy_salt(), &dummy_wallet(), 1);
        let created_at = 1_700_000_000u64;
        let tc = create_trade_commitment(
            &session,
            &dummy_token_hash(),
            0x01,
            0x01,
            &dummy_slot_hash(),
            created_at,
        );
        let delay = 3600u64;
        let just_in_time = created_at + delay;
        let result = create_delayed_reveal(&tc, just_in_time, delay);
        assert!(result.is_ok());
        let reveal = result.unwrap();
        assert_eq!(reveal.original_commitment_hash, tc.commitment_hash);
    }

    // 14. Chaining 3 receipts and verifying integrity.
    #[test]
    fn test_receipt_chain_integrity() {
        let h1 = [0x11u8; 32];
        let h2 = [0x22u8; 32];
        let h3 = [0x33u8; 32];

        let c1 = chain_receipt(None, &h1);
        assert_eq!(c1.chain_length, 1);
        assert!(verify_chain_integrity(&c1, None));

        let c2 = chain_receipt(Some(&c1), &h2);
        assert_eq!(c2.chain_length, 2);
        assert!(verify_chain_integrity(&c2, Some(&c1)));

        let c3 = chain_receipt(Some(&c2), &h3);
        assert_eq!(c3.chain_length, 3);
        assert!(verify_chain_integrity(&c3, Some(&c2)));

        // Verify c3 does NOT pass with c1 as previous (wrong previous).
        assert!(!verify_chain_integrity(&c3, Some(&c1)));
    }

    // 15. "guaranteed profit" triggers ForbiddenClaim.
    #[test]
    fn test_forbidden_claim_detected() {
        let result = check_forbidden_claims("This strategy gives guaranteed profit every week!");
        match result {
            Err(AlphaReceiptsError::ForbiddenClaim(phrase)) => {
                assert_eq!(phrase, "guaranteed profit");
            }
            other => panic!("expected ForbiddenClaim, got {:?}", other),
        }
    }

    // 16. verify_pnl_card_clean passes for a valid card.
    #[test]
    fn test_pnl_card_clean() {
        let session = create_session_hash(&dummy_salt(), &dummy_wallet(), 9);
        let pnl = create_pnl_commitment(&session, 9, 250, 3, 1_700_000_000);
        let card = create_pnl_card(&pnl);
        assert!(
            verify_pnl_card_clean(&card).is_ok(),
            "card should be clean: {}",
            card.badge_label
        );
    }
}
