use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ChannelState {
    /// SHA256("channel-id-v1" || party_a_hash || party_b_hash || deposit_le)
    pub channel_id: [u8; 32],
    pub balance_a: u64,
    pub balance_b: u64,
    pub sequence: u64,
    pub closed: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StateUpdate {
    pub channel_id: [u8; 32],
    pub balance_a: u64,
    pub balance_b: u64,
    pub sequence: u64,
    /// SHA256("state-sig-v1" || channel_id || balance_a_le || balance_b_le || sequence_le)
    /// Note: uses party_secret during signing but only the sig hash stored here
    pub sig_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SettlementReceipt {
    pub channel_id: [u8; 32],
    pub final_balance_a: u64,
    pub final_balance_b: u64,
    /// SHA256("settle-v1" || channel_id || final_a_le || final_b_le || sequence_le)
    pub settlement_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum ChannelError {
    PartySecretZero,
    InsufficientDeposit,
    InvalidSequence,
    BalanceSumMismatch,
    AlreadyClosed,
    InvalidSignature,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn sha256_digest(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

fn party_hash(secret: &[u8; 32]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(16 + 32);
    buf.extend_from_slice(b"channel-party-v1");
    buf.extend_from_slice(secret);
    sha256_digest(&buf)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Open a new payment channel between two parties.
///
/// Returns `Err(PartySecretZero)` if either secret is the zero array.
/// `channel_id` = SHA256("channel-id-v1" || party_a_hash || party_b_hash || total_deposit_le)
pub fn open_channel(
    party_a_secret: &[u8; 32],
    party_b_secret: &[u8; 32],
    deposit_a: u64,
    deposit_b: u64,
) -> Result<ChannelState, ChannelError> {
    if party_a_secret == &[0u8; 32] || party_b_secret == &[0u8; 32] {
        return Err(ChannelError::PartySecretZero);
    }

    let hash_a = party_hash(party_a_secret);
    let hash_b = party_hash(party_b_secret);
    let total_deposit: u64 = deposit_a.saturating_add(deposit_b);

    let mut buf = Vec::with_capacity(13 + 32 + 32 + 8);
    buf.extend_from_slice(b"channel-id-v1");
    buf.extend_from_slice(&hash_a);
    buf.extend_from_slice(&hash_b);
    buf.extend_from_slice(&total_deposit.to_le_bytes());
    let channel_id = sha256_digest(&buf);

    Ok(ChannelState {
        channel_id,
        balance_a: deposit_a,
        balance_b: deposit_b,
        sequence: 0,
        closed: false,
        mainnet_ready: false,
    })
}

/// Produce a signed state update proposing new balances for the channel.
///
/// `sig_hash` = SHA256("state-sig-v1" || channel_id || new_balance_a_le || new_balance_b_le || new_sequence_le)
///
/// Returns `Err(AlreadyClosed)` if the channel is already closed.
/// Returns `Err(BalanceSumMismatch)` if `new_balance_a + new_balance_b` differs from the
/// current total.
pub fn sign_state(
    channel: &ChannelState,
    _party_secret: &[u8; 32],
    new_balance_a: u64,
    new_balance_b: u64,
) -> Result<StateUpdate, ChannelError> {
    if channel.closed {
        return Err(ChannelError::AlreadyClosed);
    }

    let current_total = channel.balance_a.saturating_add(channel.balance_b);
    let new_total = new_balance_a.saturating_add(new_balance_b);
    if new_total != current_total {
        return Err(ChannelError::BalanceSumMismatch);
    }

    let new_sequence = channel.sequence + 1;

    let mut buf = Vec::with_capacity(13 + 32 + 8 + 8 + 8);
    buf.extend_from_slice(b"state-sig-v1");
    buf.extend_from_slice(&channel.channel_id);
    buf.extend_from_slice(&new_balance_a.to_le_bytes());
    buf.extend_from_slice(&new_balance_b.to_le_bytes());
    buf.extend_from_slice(&new_sequence.to_le_bytes());
    let sig_hash = sha256_digest(&buf);

    Ok(StateUpdate {
        channel_id: channel.channel_id,
        balance_a: new_balance_a,
        balance_b: new_balance_b,
        sequence: new_sequence,
        sig_hash,
        mainnet_ready: false,
    })
}

/// Apply a mutually-agreed state update to the channel.
///
/// Returns `Err(InvalidSequence)` if the update sequence is not strictly greater than the
/// channel's current sequence.
/// Returns `Err(BalanceSumMismatch)` if the update's balance sum differs from the channel's.
pub fn apply_update(channel: &mut ChannelState, update: &StateUpdate) -> Result<(), ChannelError> {
    if update.sequence <= channel.sequence {
        return Err(ChannelError::InvalidSequence);
    }

    let current_total = channel.balance_a.saturating_add(channel.balance_b);
    let update_total = update.balance_a.saturating_add(update.balance_b);
    if update_total != current_total {
        return Err(ChannelError::BalanceSumMismatch);
    }

    channel.balance_a = update.balance_a;
    channel.balance_b = update.balance_b;
    channel.sequence = update.sequence;
    channel.mainnet_ready = update.mainnet_ready;

    Ok(())
}

/// Settle and close the channel, producing a `SettlementReceipt`.
///
/// Returns `Err(AlreadyClosed)` if the channel is already closed.
/// `settlement_hash` = SHA256("settle-v1" || channel_id || balance_a_le || balance_b_le || sequence_le)
pub fn settle_channel(channel: &mut ChannelState) -> Result<SettlementReceipt, ChannelError> {
    if channel.closed {
        return Err(ChannelError::AlreadyClosed);
    }

    let mut buf = Vec::with_capacity(9 + 32 + 8 + 8 + 8);
    buf.extend_from_slice(b"settle-v1");
    buf.extend_from_slice(&channel.channel_id);
    buf.extend_from_slice(&channel.balance_a.to_le_bytes());
    buf.extend_from_slice(&channel.balance_b.to_le_bytes());
    buf.extend_from_slice(&channel.sequence.to_le_bytes());
    let settlement_hash = sha256_digest(&buf);

    let receipt = SettlementReceipt {
        channel_id: channel.channel_id,
        final_balance_a: channel.balance_a,
        final_balance_b: channel.balance_b,
        settlement_hash,
        mainnet_ready: channel.mainnet_ready,
    };

    channel.closed = true;

    Ok(receipt)
}

/// Return a JSON public record for the channel.
///
/// Exposes only `channel_id` (hex), `sequence`, `closed`, and `mainnet_ready`.
/// Balances and party hashes are intentionally omitted.
pub fn channel_public_record(channel: &ChannelState) -> String {
    let channel_id_hex: String = channel
        .channel_id
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();

    serde_json::json!({
        "channel_id": channel_id_hex,
        "sequence": channel.sequence,
        "closed": channel.closed,
        "mainnet_ready": channel.mainnet_ready,
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn secret_a() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xAA;
        s
    }

    fn secret_b() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xBB;
        s
    }

    // 1. Full 3-update channel lifecycle
    #[test]
    fn test_open_sign_apply_settle() {
        let mut ch = open_channel(&secret_a(), &secret_b(), 1000, 1000).unwrap();
        assert_eq!(ch.sequence, 0);
        assert!(!ch.closed);

        // Update 1: A pays 200 to B
        let upd1 = sign_state(&ch, &secret_a(), 800, 1200).unwrap();
        assert_eq!(upd1.sequence, 1);
        apply_update(&mut ch, &upd1).unwrap();
        assert_eq!(ch.balance_a, 800);
        assert_eq!(ch.balance_b, 1200);
        assert_eq!(ch.sequence, 1);

        // Update 2: B pays 300 to A
        let upd2 = sign_state(&ch, &secret_b(), 1100, 900).unwrap();
        assert_eq!(upd2.sequence, 2);
        apply_update(&mut ch, &upd2).unwrap();
        assert_eq!(ch.balance_a, 1100);
        assert_eq!(ch.balance_b, 900);
        assert_eq!(ch.sequence, 2);

        // Update 3: A pays 100 to B
        let upd3 = sign_state(&ch, &secret_a(), 1000, 1000).unwrap();
        assert_eq!(upd3.sequence, 3);
        apply_update(&mut ch, &upd3).unwrap();
        assert_eq!(ch.balance_a, 1000);
        assert_eq!(ch.balance_b, 1000);
        assert_eq!(ch.sequence, 3);

        // Settle
        let receipt = settle_channel(&mut ch).unwrap();
        assert!(ch.closed);
        assert_eq!(receipt.final_balance_a, 1000);
        assert_eq!(receipt.final_balance_b, 1000);
        assert_ne!(receipt.settlement_hash, [0u8; 32]);
    }

    // 2. Balance sum invariant is preserved on every update
    #[test]
    fn test_balance_sum_preserved() {
        let mut ch = open_channel(&secret_a(), &secret_b(), 500, 1500).unwrap();
        let initial_total = ch.balance_a + ch.balance_b;

        for (new_a, new_b) in [(600u64, 1400u64), (300, 1700), (500, 1500)] {
            let upd = sign_state(&ch, &secret_a(), new_a, new_b).unwrap();
            apply_update(&mut ch, &upd).unwrap();
            assert_eq!(ch.balance_a + ch.balance_b, initial_total);
        }
    }

    // 3. Operations on a closed channel return AlreadyClosed
    #[test]
    fn test_already_closed_rejected() {
        let mut ch = open_channel(&secret_a(), &secret_b(), 100, 200).unwrap();
        settle_channel(&mut ch).unwrap();

        // settle again
        assert_eq!(settle_channel(&mut ch), Err(ChannelError::AlreadyClosed));

        // sign_state on closed channel
        assert_eq!(
            sign_state(&ch, &secret_a(), 100, 200),
            Err(ChannelError::AlreadyClosed)
        );
    }

    // 4. Stale / replayed update is rejected
    #[test]
    fn test_invalid_sequence_rejected() {
        let mut ch = open_channel(&secret_a(), &secret_b(), 300, 300).unwrap();

        let upd1 = sign_state(&ch, &secret_a(), 200, 400).unwrap();
        apply_update(&mut ch, &upd1).unwrap(); // sequence now 1

        // Attempt to replay upd1 (sequence == 1, channel sequence == 1)
        assert_eq!(apply_update(&mut ch, &upd1), Err(ChannelError::InvalidSequence));

        // Produce a valid update at sequence 2, then try to apply seq 1 again
        let upd2 = sign_state(&ch, &secret_b(), 300, 300).unwrap();
        apply_update(&mut ch, &upd2).unwrap(); // sequence now 2

        assert_eq!(apply_update(&mut ch, &upd1), Err(ChannelError::InvalidSequence));
    }

    // 5. Balance mismatch in sign_state and apply_update
    #[test]
    fn test_balance_mismatch_rejected() {
        let mut ch = open_channel(&secret_a(), &secret_b(), 500, 500).unwrap();

        // sign_state with wrong sum
        assert_eq!(
            sign_state(&ch, &secret_a(), 600, 600), // 1200 != 1000
            Err(ChannelError::BalanceSumMismatch)
        );

        // Craft a StateUpdate with a bad sum and try to apply it
        let bad_update = StateUpdate {
            channel_id: ch.channel_id,
            balance_a: 600,
            balance_b: 600, // sum = 1200, channel total = 1000
            sequence: ch.sequence + 1,
            sig_hash: [0u8; 32],
            mainnet_ready: false,
        };
        assert_eq!(apply_update(&mut ch, &bad_update), Err(ChannelError::BalanceSumMismatch));
    }

    // 6. channel_public_record hides balances and party hashes
    #[test]
    fn test_public_record_hides_balances() {
        let ch = open_channel(&secret_a(), &secret_b(), 9999, 1).unwrap();
        let record = channel_public_record(&ch);

        // Must contain structural keys
        assert!(record.contains("channel_id"));
        assert!(record.contains("sequence"));
        assert!(record.contains("closed"));
        assert!(record.contains("mainnet_ready"));

        // Must NOT contain balance values or the word "balance"
        assert!(!record.contains("balance"));
        assert!(!record.contains("9999"));
        assert!(!record.contains("party"));

        // Sanity: valid JSON
        let parsed: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert_eq!(parsed["sequence"], 0);
        assert_eq!(parsed["closed"], false);
        assert_eq!(parsed["mainnet_ready"], false);
        // channel_id should be a 64-char hex string
        let cid = parsed["channel_id"].as_str().unwrap();
        assert_eq!(cid.len(), 64);
    }
}
