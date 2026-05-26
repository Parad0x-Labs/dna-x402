use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateChannel {
    pub channel_id: [u8; 32],
    pub party_a_hash: [u8; 32],
    pub party_b_hash: [u8; 32],
    pub balance_a: u64,
    pub balance_b: u64,
    pub sequence: u32,
    pub state_hash: [u8; 32],
    pub open: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelUpdate {
    pub update_id: [u8; 32],
    pub channel_id: [u8; 32],
    pub new_balance_a: u64,
    pub new_balance_b: u64,
    pub sequence: u32,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum ChannelError {
    ZeroPartySecret,
    ZeroTotalBalance,
    SequenceNotAdvancing,
    ChannelClosed,
    BalanceSumMismatch,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn hex32(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn compute_state_hash(
    channel_id: &[u8; 32],
    balance_a: u64,
    balance_b: u64,
    sequence: u32,
) -> [u8; 32] {
    sha256_multi(&[
        b"schan-state-v1",
        channel_id,
        &balance_a.to_le_bytes(),
        &balance_b.to_le_bytes(),
        &sequence.to_le_bytes(),
    ])
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn open_channel(
    party_a_secret: &[u8; 32],
    party_b_secret: &[u8; 32],
    balance_a: u64,
    balance_b: u64,
    nonce: &[u8; 32],
) -> Result<StateChannel, ChannelError> {
    if party_a_secret == &[0u8; 32] || party_b_secret == &[0u8; 32] {
        return Err(ChannelError::ZeroPartySecret);
    }
    let total = balance_a.checked_add(balance_b).unwrap_or(0);
    if total == 0 {
        return Err(ChannelError::ZeroTotalBalance);
    }

    let party_a_hash = sha256_multi(&[b"schan-party-v1", party_a_secret]);
    let party_b_hash = sha256_multi(&[b"schan-party-v1", party_b_secret]);
    let total_le = total.to_le_bytes();
    let channel_id = sha256_multi(&[
        b"schan-id-v1",
        &party_a_hash,
        &party_b_hash,
        &total_le,
        nonce,
    ]);

    let sequence = 0u32;
    let state_hash = compute_state_hash(&channel_id, balance_a, balance_b, sequence);

    Ok(StateChannel {
        channel_id,
        party_a_hash,
        party_b_hash,
        balance_a,
        balance_b,
        sequence,
        state_hash,
        open: true,
        mainnet_ready: false,
    })
}

pub fn update_channel(
    channel: &mut StateChannel,
    new_balance_a: u64,
    new_balance_b: u64,
) -> Result<ChannelUpdate, ChannelError> {
    if !channel.open {
        return Err(ChannelError::ChannelClosed);
    }
    let old_total = channel
        .balance_a
        .checked_add(channel.balance_b)
        .unwrap_or(0);
    let new_total = new_balance_a.checked_add(new_balance_b).unwrap_or(u64::MAX);
    if new_total != old_total {
        return Err(ChannelError::BalanceSumMismatch);
    }

    channel.sequence += 1;
    channel.balance_a = new_balance_a;
    channel.balance_b = new_balance_b;
    channel.state_hash = compute_state_hash(
        &channel.channel_id,
        new_balance_a,
        new_balance_b,
        channel.sequence,
    );

    let update_id = sha256_multi(&[
        b"schan-update-v1",
        &channel.channel_id,
        &new_balance_a.to_le_bytes(),
        &new_balance_b.to_le_bytes(),
        &channel.sequence.to_le_bytes(),
    ]);

    Ok(ChannelUpdate {
        update_id,
        channel_id: channel.channel_id,
        new_balance_a,
        new_balance_b,
        sequence: channel.sequence,
        mainnet_ready: false,
    })
}

pub fn close_channel(channel: &mut StateChannel) {
    channel.open = false;
}

pub fn channel_public_record(channel: &StateChannel) -> String {
    serde_json::json!({
        "channel_id": hex32(&channel.channel_id),
        "balance_a": channel.balance_a,
        "balance_b": channel.balance_b,
        "sequence": channel.sequence,
        "open": channel.open,
        "mainnet_ready": channel.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn secret(b: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = b;
        s
    }

    fn nonce(b: u8) -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = b;
        n
    }

    #[test]
    fn test_open_update_close() {
        let a = secret(0x11);
        let b = secret(0x22);
        let n = nonce(0x01);

        let mut ch = open_channel(&a, &b, 500, 500, &n).unwrap();
        assert!(ch.open);
        assert!(!ch.mainnet_ready);
        assert_eq!(ch.sequence, 0);

        let upd = update_channel(&mut ch, 600, 400).unwrap();
        assert_eq!(ch.sequence, 1);
        assert_eq!(upd.sequence, 1);
        assert_eq!(ch.balance_a, 600);
        assert_eq!(ch.balance_b, 400);
        assert!(!upd.mainnet_ready);

        close_channel(&mut ch);
        assert!(!ch.open);
    }

    #[test]
    fn test_balance_sum_mismatch_rejected() {
        let a = secret(0x33);
        let b = secret(0x44);
        let n = nonce(0x02);
        let mut ch = open_channel(&a, &b, 500, 500, &n).unwrap();
        // new total != 1000
        let err = update_channel(&mut ch, 600, 500).unwrap_err();
        assert_eq!(err, ChannelError::BalanceSumMismatch);
    }

    #[test]
    fn test_zero_total_balance_rejected() {
        let a = secret(0x55);
        let b = secret(0x66);
        let n = nonce(0x03);
        let err = open_channel(&a, &b, 0, 0, &n).unwrap_err();
        assert_eq!(err, ChannelError::ZeroTotalBalance);
    }

    #[test]
    fn test_zero_party_secret_rejected() {
        let zero = [0u8; 32];
        let b = secret(0x77);
        let n = nonce(0x04);
        let err = open_channel(&zero, &b, 100, 100, &n).unwrap_err();
        assert_eq!(err, ChannelError::ZeroPartySecret);
    }

    #[test]
    fn test_sequence_increments_on_update() {
        let a = secret(0x88);
        let b = secret(0x99);
        let n = nonce(0x05);
        let mut ch = open_channel(&a, &b, 300, 700, &n).unwrap();
        assert_eq!(ch.sequence, 0);

        update_channel(&mut ch, 400, 600).unwrap();
        assert_eq!(ch.sequence, 1);

        update_channel(&mut ch, 200, 800).unwrap();
        assert_eq!(ch.sequence, 2);

        update_channel(&mut ch, 500, 500).unwrap();
        assert_eq!(ch.sequence, 3);
    }

    #[test]
    fn test_public_record_hides_party_hashes() {
        let a = secret(0xaa);
        let b = secret(0xbb);
        let n = nonce(0x06);
        let ch = open_channel(&a, &b, 100, 200, &n).unwrap();
        let record = channel_public_record(&ch);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["channel_id"].is_string());
        assert_eq!(v["balance_a"], 100);
        assert_eq!(v["balance_b"], 200);
        assert_eq!(v["mainnet_ready"], false);
        assert!(v.get("party_a_hash").is_none());
        assert!(v.get("party_b_hash").is_none());
        assert!(!record.contains(&hex32(&ch.party_a_hash)));
        assert!(!record.contains(&hex32(&ch.party_b_hash)));
    }
}
