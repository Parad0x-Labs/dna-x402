use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const EPOCH_WINDOW: u64 = 10;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NullifierEntry {
    pub nullifier: [u8; 32],
    pub epoch: u64,
    pub inserted_at_unix: i64,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NullifierMap {
    pub current_epoch: u64,
    pub entries: Vec<NullifierEntry>,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum NullifierError {
    AlreadySpent,
    ZeroNullifier,
    EpochExpired { stored_epoch: u64, current: u64 },
}

pub fn new_map(initial_epoch: u64) -> NullifierMap {
    NullifierMap {
        current_epoch: initial_epoch,
        entries: Vec::new(),
        mainnet_ready: false,
    }
}

pub fn insert_nullifier(
    map: &mut NullifierMap,
    nullifier: [u8; 32],
    inserted_at_unix: i64,
) -> Result<(), NullifierError> {
    if nullifier == [0u8; 32] {
        return Err(NullifierError::ZeroNullifier);
    }
    if map.entries.iter().any(|e| e.nullifier == nullifier) {
        return Err(NullifierError::AlreadySpent);
    }
    map.entries.push(NullifierEntry {
        nullifier,
        epoch: map.current_epoch,
        inserted_at_unix,
        mainnet_ready: false,
    });
    Ok(())
}

pub fn check_nullifier(map: &NullifierMap, nullifier: &[u8; 32]) -> bool {
    map.entries.iter().any(|e| {
        e.nullifier == *nullifier && map.current_epoch.saturating_sub(e.epoch) < EPOCH_WINDOW
    })
}

pub fn advance_epoch(map: &mut NullifierMap) {
    map.current_epoch += 1;
    map.entries
        .retain(|e| map.current_epoch.saturating_sub(e.epoch) < EPOCH_WINDOW);
}

pub fn map_public_record(map: &NullifierMap) -> String {
    let active_count = map
        .entries
        .iter()
        .filter(|e| map.current_epoch.saturating_sub(e.epoch) < EPOCH_WINDOW)
        .count();
    serde_json::json!({
        "current_epoch": map.current_epoch,
        "active_count": active_count,
        "mainnet_ready": map.mainnet_ready,
    })
    .to_string()
}

// Utility: produce a deterministic non-zero nullifier from a seed for tests
fn make_nullifier(seed: u8) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([seed]);
    h.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_insert_and_check() {
        let mut map = new_map(0);
        assert!(!map.mainnet_ready);
        let n = make_nullifier(1);
        insert_nullifier(&mut map, n, 1000).unwrap();
        assert!(check_nullifier(&map, &n));
    }

    #[test]
    fn test_double_insert_rejected() {
        let mut map = new_map(0);
        let n = make_nullifier(2);
        insert_nullifier(&mut map, n, 1000).unwrap();
        let err = insert_nullifier(&mut map, n, 1001).unwrap_err();
        assert_eq!(err, NullifierError::AlreadySpent);
    }

    #[test]
    fn test_zero_nullifier_rejected() {
        let mut map = new_map(0);
        let err = insert_nullifier(&mut map, [0u8; 32], 1000).unwrap_err();
        assert_eq!(err, NullifierError::ZeroNullifier);
    }

    #[test]
    fn test_epoch_advance_prunes_old_entries() {
        let mut map = new_map(0);
        let n = make_nullifier(3);
        insert_nullifier(&mut map, n, 1000).unwrap();
        // advance EPOCH_WINDOW times so the entry becomes expired
        for _ in 0..EPOCH_WINDOW {
            advance_epoch(&mut map);
        }
        assert!(!check_nullifier(&map, &n));
        // entry should be pruned from vec
        assert!(map.entries.is_empty());
    }

    #[test]
    fn test_active_count_correct_after_pruning() {
        let mut map = new_map(0);
        let n1 = make_nullifier(4);
        let n2 = make_nullifier(5);
        insert_nullifier(&mut map, n1, 1000).unwrap();
        // advance 9 epochs — n1 still inside window (diff == 9 < 10)
        for _ in 0..9 {
            advance_epoch(&mut map);
        }
        insert_nullifier(&mut map, n2, 2000).unwrap();
        // advance 1 more — n1 now at diff == 10 >= EPOCH_WINDOW, n2 diff == 1
        advance_epoch(&mut map);
        // active count should be 1 (only n2)
        let record: serde_json::Value = serde_json::from_str(&map_public_record(&map)).unwrap();
        assert_eq!(record["active_count"], 1);
    }

    #[test]
    fn test_public_record_has_epoch_and_count() {
        let mut map = new_map(5);
        let n = make_nullifier(6);
        insert_nullifier(&mut map, n, 999).unwrap();
        let record: serde_json::Value = serde_json::from_str(&map_public_record(&map)).unwrap();
        assert_eq!(record["current_epoch"], 5);
        assert_eq!(record["active_count"], 1);
        assert!(!record["mainnet_ready"].as_bool().unwrap());
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_map_starts_empty() {
        let map = new_map(0);
        assert!(map.entries.is_empty());
    }

    #[test]
    fn test_mainnet_ready_false() {
        let map = new_map(0);
        assert!(!map.mainnet_ready);
    }

    #[test]
    fn test_entry_mainnet_ready_false() {
        let mut map = new_map(0);
        let n = make_nullifier(10);
        insert_nullifier(&mut map, n, 1000).unwrap();
        assert!(!map.entries[0].mainnet_ready);
    }

    #[test]
    fn test_check_unknown_nullifier_returns_false() {
        let map = new_map(0);
        let n = make_nullifier(11);
        assert!(!check_nullifier(&map, &n));
    }

    #[test]
    fn test_advance_epoch_increments() {
        let mut map = new_map(3);
        advance_epoch(&mut map);
        assert_eq!(map.current_epoch, 4);
    }

    #[test]
    fn test_nullifier_within_window_active() {
        let mut map = new_map(0);
        let n = make_nullifier(12);
        insert_nullifier(&mut map, n, 1000).unwrap();
        // advance EPOCH_WINDOW - 1 times; entry still inside window
        for _ in 0..(EPOCH_WINDOW - 1) {
            advance_epoch(&mut map);
        }
        assert!(check_nullifier(&map, &n));
    }

    #[test]
    fn test_entries_count_after_insert() {
        let mut map = new_map(0);
        let n = make_nullifier(13);
        insert_nullifier(&mut map, n, 1000).unwrap();
        assert_eq!(map.entries.len(), 1);
    }

    #[test]
    fn test_epoch_stored_in_entry() {
        let mut map = new_map(7);
        let n = make_nullifier(14);
        insert_nullifier(&mut map, n, 1000).unwrap();
        assert_eq!(map.entries[0].epoch, 7);
    }

    #[test]
    fn test_different_nullifiers_both_active() {
        let mut map = new_map(0);
        let n1 = make_nullifier(15);
        let n2 = make_nullifier(16);
        insert_nullifier(&mut map, n1, 1000).unwrap();
        insert_nullifier(&mut map, n2, 1001).unwrap();
        assert!(check_nullifier(&map, &n1));
        assert!(check_nullifier(&map, &n2));
    }

    #[test]
    fn test_public_record_mainnet_ready_false() {
        let map = new_map(0);
        let record: serde_json::Value = serde_json::from_str(&map_public_record(&map)).unwrap();
        assert_eq!(record["mainnet_ready"], false);
    }
}
