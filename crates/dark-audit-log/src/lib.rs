use serde_json::json;
use sha2::{Digest, Sha256};

// ── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct AuditEntry {
    pub index: u32,
    /// SHA256("audit-entry-v1" || event_bytes)
    pub event_hash: [u8; 32],
    /// SHA256("audit-chain-v1" || prev_entry_hash || event_hash || index_le)
    pub entry_hash: [u8; 32],
    pub timestamp_unix: i64,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone)]
pub struct AuditLog {
    /// Hash of last entry
    pub head: [u8; 32],
    pub entry_count: u32,
    entries: Vec<AuditEntry>,
    mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum AuditError {
    EmptyEvent,
    LogEmpty,
    ChainBroken {
        at_index: u32,
        expected: [u8; 32],
        got: [u8; 32],
    },
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn hash_event(event_bytes: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"audit-entry-v1");
    h.update(event_bytes);
    h.finalize().into()
}

fn hash_entry(prev_entry_hash: &[u8; 32], event_hash: &[u8; 32], index: u32) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"audit-chain-v1");
    h.update(prev_entry_hash);
    h.update(event_hash);
    h.update(index.to_le_bytes());
    h.finalize().into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ── Public API ───────────────────────────────────────────────────────────────

/// Create a new empty audit log.
pub fn new_log() -> AuditLog {
    AuditLog {
        head: [0u8; 32],
        entry_count: 0,
        entries: vec![],
        mainnet_ready: false,
    }
}

/// Append an event to the log. Returns the new entry or an error.
pub fn append_entry(
    log: &mut AuditLog,
    event_bytes: &[u8],
    timestamp_unix: i64,
) -> Result<AuditEntry, AuditError> {
    if event_bytes.is_empty() {
        return Err(AuditError::EmptyEvent);
    }

    let event_hash = hash_event(event_bytes);
    let prev_entry_hash = log.head;
    let index = log.entry_count;
    let entry_hash = hash_entry(&prev_entry_hash, &event_hash, index);

    let entry = AuditEntry {
        index,
        event_hash,
        entry_hash,
        timestamp_unix,
        mainnet_ready: log.mainnet_ready,
    };

    log.head = entry_hash;
    log.entry_count += 1;
    log.entries.push(entry.clone());

    Ok(entry)
}

/// Verify the integrity of the entire log. Returns Ok(()) if the chain is
/// intact, or the first ChainBroken error encountered.
pub fn verify_log(log: &AuditLog) -> Result<(), AuditError> {
    if log.entries.is_empty() {
        return Err(AuditError::LogEmpty);
    }

    let mut prev_hash = [0u8; 32];

    for entry in &log.entries {
        let expected = hash_entry(&prev_hash, &entry.event_hash, entry.index);
        if expected != entry.entry_hash {
            return Err(AuditError::ChainBroken {
                at_index: entry.index,
                expected,
                got: entry.entry_hash,
            });
        }
        prev_hash = entry.entry_hash;
    }

    Ok(())
}

/// Return a JSON public record: head hex, entry_count, mainnet_ready.
/// Raw event data is never included.
pub fn log_public_record(log: &AuditLog) -> String {
    let record = json!({
        "head": hex(&log.head),
        "entry_count": log.entry_count,
        "mainnet_ready": log.mainnet_ready,
    });
    record.to_string()
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_append_and_verify_happy_path() {
        let mut log = new_log();
        for i in 0u8..5 {
            append_entry(&mut log, &[i, i + 1, i + 2], 1_000_000 + i as i64)
                .expect("append should succeed");
        }
        assert_eq!(log.entry_count, 5);
        verify_log(&log).expect("verify should pass on unmodified log");
    }

    #[test]
    fn test_empty_event_rejected() {
        let mut log = new_log();
        let result = append_entry(&mut log, &[], 0);
        assert_eq!(result, Err(AuditError::EmptyEvent));
        assert_eq!(log.entry_count, 0, "log must not advance on error");
    }

    #[test]
    fn test_chain_is_sequential() {
        let mut log = new_log();
        let mut prev_hash = [0u8; 32];
        for i in 0u8..4 {
            let entry =
                append_entry(&mut log, &[i], 1000 + i as i64).expect("append should succeed");
            // The entry_hash is built from the previous head, so the
            // prev_entry_hash used during construction equals prev_hash here.
            let expected = hash_entry(&prev_hash, &entry.event_hash, entry.index);
            assert_eq!(
                entry.entry_hash, expected,
                "entry_hash must chain from previous entry"
            );
            prev_hash = entry.entry_hash;
        }
    }

    #[test]
    fn test_tampered_log_fails_verify() {
        let mut log = new_log();
        append_entry(&mut log, b"first event", 1).expect("append");
        append_entry(&mut log, b"second event", 2).expect("append");
        append_entry(&mut log, b"third event", 3).expect("append");

        // Tamper with the middle entry's entry_hash.
        log.entries[1].entry_hash[0] ^= 0xFF;

        let result = verify_log(&log);
        assert!(
            matches!(result, Err(AuditError::ChainBroken { at_index: 1, .. })),
            "expected ChainBroken at index 1, got {:?}",
            result
        );
    }

    #[test]
    fn test_head_advances_on_append() {
        let mut log = new_log();
        let initial_head = log.head;

        let e1 = append_entry(&mut log, b"event-a", 10).expect("append");
        assert_ne!(
            log.head, initial_head,
            "head must change after first append"
        );
        assert_eq!(log.head, e1.entry_hash);

        let e2 = append_entry(&mut log, b"event-b", 20).expect("append");
        assert_ne!(
            log.head, e1.entry_hash,
            "head must change after second append"
        );
        assert_eq!(log.head, e2.entry_hash);
    }

    #[test]
    fn test_public_record_hides_events() {
        let mut log = new_log();
        let secret = "super_secret_payload";
        append_entry(&mut log, secret.as_bytes(), 42).expect("append");

        let record = log_public_record(&log);

        assert!(
            !record.contains(secret),
            "public record must not expose raw event data"
        );
        // Sanity-check that the expected fields are present.
        assert!(record.contains("head"));
        assert!(record.contains("entry_count"));
        assert!(record.contains("mainnet_ready"));
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_mainnet_ready_always_false() {
        let mut log = new_log();
        let entry = append_entry(&mut log, b"event", 0).unwrap();
        assert!(!entry.mainnet_ready);
    }

    #[test]
    fn test_entry_count_advances() {
        let mut log = new_log();
        assert_eq!(log.entry_count, 0);
        append_entry(&mut log, b"e1", 1).unwrap();
        assert_eq!(log.entry_count, 1);
        append_entry(&mut log, b"e2", 2).unwrap();
        assert_eq!(log.entry_count, 2);
    }

    #[test]
    fn test_event_hash_deterministic() {
        let mut log1 = new_log();
        let mut log2 = new_log();
        let e1 = append_entry(&mut log1, b"same-event", 0).unwrap();
        let e2 = append_entry(&mut log2, b"same-event", 0).unwrap();
        assert_eq!(e1.event_hash, e2.event_hash);
    }

    #[test]
    fn test_event_hash_event_sensitive() {
        let mut log1 = new_log();
        let mut log2 = new_log();
        let e1 = append_entry(&mut log1, b"event-a", 0).unwrap();
        let e2 = append_entry(&mut log2, b"event-b", 0).unwrap();
        assert_ne!(e1.event_hash, e2.event_hash);
    }

    #[test]
    fn test_entry_hash_index_sensitive() {
        let mut log = new_log();
        // Two different entries with the same event content at different indexes
        let e0 = append_entry(&mut log, b"same-event", 0).unwrap();
        // Reset to simulate fresh log at different starting index is not possible,
        // but we can compare e0 at index 0 vs a new log entry at index 1
        let e1 = append_entry(&mut log, b"same-event", 1).unwrap();
        assert_ne!(e0.entry_hash, e1.entry_hash);
    }

    #[test]
    fn test_empty_log_verify_fails() {
        let log = new_log();
        assert_eq!(verify_log(&log), Err(AuditError::LogEmpty));
    }

    #[test]
    fn test_single_entry_log_verifies() {
        let mut log = new_log();
        append_entry(&mut log, b"only event", 0).unwrap();
        assert!(verify_log(&log).is_ok());
    }

    #[test]
    fn test_head_matches_last_entry() {
        let mut log = new_log();
        append_entry(&mut log, b"e1", 1).unwrap();
        let last = append_entry(&mut log, b"e2", 2).unwrap();
        assert_eq!(log.head, last.entry_hash);
    }

    #[test]
    fn test_public_record_entry_count_correct() {
        let mut log = new_log();
        for i in 0..3u8 {
            append_entry(&mut log, &[i], i as i64).unwrap();
        }
        let record = log_public_record(&log);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert_eq!(v["entry_count"], 3u64);
    }

    #[test]
    fn test_public_record_head_hex_present() {
        let mut log = new_log();
        append_entry(&mut log, b"event", 0).unwrap();
        let record = log_public_record(&log);
        let head_hex = hex(&log.head);
        assert!(record.contains(&head_hex));
    }
}
