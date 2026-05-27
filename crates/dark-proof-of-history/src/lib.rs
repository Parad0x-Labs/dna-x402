use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhHistory {
    pub ph_id: [u8; 32],
    pub tick: u64,
    pub hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhRecord {
    pub prev_hash: [u8; 32],
    pub tick: u64,
    pub hash: [u8; 32],
    pub data_hash: Option<[u8; 32]>,
}

#[derive(Debug, PartialEq)]
pub enum PhError {
    ZeroSeed,
    TickNotAdvancing,
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

// ── API ────────────────────────────────────────────────────────────────────

/// Creates a new PoH history from a seed.
/// `hash = SHA256("poh-init-v1" || seed)`
/// `ph_id = SHA256("poh-id-v1" || initial_hash || SHA256(seed))`
pub fn new_history(seed: &[u8; 32]) -> Result<PhHistory, PhError> {
    if seed == &[0u8; 32] {
        return Err(PhError::ZeroSeed);
    }
    let initial_hash = sha256_multi(&[b"poh-init-v1", seed]);
    let seed_hash = sha256_multi(&[seed]);
    let ph_id = sha256_multi(&[b"poh-id-v1", &initial_hash, &seed_hash]);

    Ok(PhHistory {
        ph_id,
        tick: 0,
        hash: initial_hash,
        mainnet_ready: false,
    })
}

/// Advances the tick by 1 and returns a PhRecord.
/// `hash = SHA256("poh-tick-v1" || prev_hash || tick_le)`
pub fn tick(ph: &mut PhHistory) -> PhRecord {
    let prev_hash = ph.hash;
    ph.tick += 1;
    let tick_le = ph.tick.to_le_bytes();
    ph.hash = sha256_multi(&[b"poh-tick-v1", &prev_hash, &tick_le]);
    PhRecord {
        prev_hash,
        tick: ph.tick,
        hash: ph.hash,
        data_hash: None,
    }
}

/// Advances the tick and mixes in data_hash.
/// `data_hash = SHA256("poh-record-v1" || data_bytes)`
/// `hash = SHA256("poh-data-v1" || prev_hash || tick_le || data_hash)`
pub fn record(ph: &mut PhHistory, data_bytes: &[u8]) -> PhRecord {
    let prev_hash = ph.hash;
    ph.tick += 1;
    let tick_le = ph.tick.to_le_bytes();
    let data_hash = sha256_multi(&[b"poh-record-v1", data_bytes]);
    ph.hash = sha256_multi(&[b"poh-data-v1", &prev_hash, &tick_le, &data_hash]);
    PhRecord {
        prev_hash,
        tick: ph.tick,
        hash: ph.hash,
        data_hash: Some(data_hash),
    }
}

/// Returns a JSON public record: ph_id, tick, hash (hex), mainnet_ready.
pub fn ph_public_record(ph: &PhHistory) -> String {
    serde_json::json!({
        "ph_id": hex32(&ph.ph_id),
        "tick": ph.tick,
        "hash": hex32(&ph.hash),
        "mainnet_ready": ph.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(b: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = b;
        s
    }

    #[test]
    fn test_new_and_tick() {
        let mut ph = new_history(&seed(0x01)).unwrap();
        assert!(!ph.mainnet_ready);
        assert_eq!(ph.tick, 0);
        let rec = tick(&mut ph);
        assert_eq!(rec.tick, 1);
        assert_eq!(ph.tick, 1);
        assert!(rec.data_hash.is_none());
        assert_ne!(rec.prev_hash, rec.hash);
    }

    #[test]
    fn test_tick_advances_and_changes_hash() {
        let mut ph = new_history(&seed(0x02)).unwrap();
        let h0 = ph.hash;
        let _r1 = tick(&mut ph);
        let h1 = ph.hash;
        let _r2 = tick(&mut ph);
        let h2 = ph.hash;
        assert_ne!(h0, h1);
        assert_ne!(h1, h2);
        assert_eq!(ph.tick, 2);
    }

    #[test]
    fn test_record_mixes_data() {
        let mut ph = new_history(&seed(0x03)).unwrap();
        let rec = record(&mut ph, b"some blockchain data");
        assert!(rec.data_hash.is_some());
        // Tick hash with same tick but no data should differ
        let mut ph2 = new_history(&seed(0x03)).unwrap();
        let tick_rec = tick(&mut ph2);
        assert_ne!(rec.hash, tick_rec.hash);
    }

    #[test]
    fn test_different_seeds_give_different_ph_ids() {
        let ph1 = new_history(&seed(0x10)).unwrap();
        let ph2 = new_history(&seed(0x11)).unwrap();
        assert_ne!(ph1.ph_id, ph2.ph_id);
        assert_ne!(ph1.hash, ph2.hash);
    }

    #[test]
    fn test_same_seed_same_initial_hash() {
        let ph1 = new_history(&seed(0x20)).unwrap();
        let ph2 = new_history(&seed(0x20)).unwrap();
        assert_eq!(ph1.hash, ph2.hash);
        assert_eq!(ph1.ph_id, ph2.ph_id);
    }

    #[test]
    fn test_public_record_correct() {
        let mut ph = new_history(&seed(0x30)).unwrap();
        tick(&mut ph);
        let rec = ph_public_record(&ph);
        let v: serde_json::Value = serde_json::from_str(&rec).unwrap();
        assert!(v["ph_id"].is_string());
        assert_eq!(v["tick"], 1u64);
        assert_eq!(v["mainnet_ready"], false);
        assert_eq!(v["ph_id"].as_str().unwrap().len(), 64);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_ph_id_nonzero() {
        let ph = new_history(&seed(0x40)).unwrap();
        assert_ne!(ph.ph_id, [0u8; 32]);
    }

    #[test]
    fn test_initial_hash_nonzero() {
        let ph = new_history(&seed(0x41)).unwrap();
        assert_ne!(ph.hash, [0u8; 32]);
    }

    #[test]
    fn test_mainnet_ready_false() {
        let ph = new_history(&seed(0x42)).unwrap();
        assert!(!ph.mainnet_ready);
    }

    #[test]
    fn test_zero_seed_rejected() {
        let err = new_history(&[0u8; 32]).unwrap_err();
        assert_eq!(err, PhError::ZeroSeed);
    }

    #[test]
    fn test_tick_record_prev_hash_correct() {
        let mut ph = new_history(&seed(0x43)).unwrap();
        let hash_before = ph.hash;
        let rec = tick(&mut ph);
        assert_eq!(rec.prev_hash, hash_before);
        assert_eq!(rec.hash, ph.hash);
    }

    #[test]
    fn test_record_data_hash_nonzero() {
        let mut ph = new_history(&seed(0x44)).unwrap();
        let rec = record(&mut ph, b"some data bytes");
        let dh = rec.data_hash.unwrap();
        assert_ne!(dh, [0u8; 32]);
    }

    #[test]
    fn test_multiple_ticks_accumulate() {
        let mut ph = new_history(&seed(0x45)).unwrap();
        tick(&mut ph);
        tick(&mut ph);
        tick(&mut ph);
        assert_eq!(ph.tick, 3);
    }

    #[test]
    fn test_different_data_different_hash() {
        let mut ph1 = new_history(&seed(0x46)).unwrap();
        let mut ph2 = new_history(&seed(0x46)).unwrap();
        let r1 = record(&mut ph1, b"data_alpha");
        let r2 = record(&mut ph2, b"data_beta");
        assert_ne!(r1.hash, r2.hash);
    }

    #[test]
    fn test_record_tick_advances_by_one() {
        let mut ph = new_history(&seed(0x47)).unwrap();
        assert_eq!(ph.tick, 0);
        let rec = record(&mut ph, b"advance_test");
        assert_eq!(rec.tick, 1);
        assert_eq!(ph.tick, 1);
    }

    #[test]
    fn test_ph_id_seed_sensitive() {
        let ph1 = new_history(&seed(0x48)).unwrap();
        let ph2 = new_history(&seed(0x49)).unwrap();
        assert_ne!(ph1.ph_id, ph2.ph_id);
    }
}
