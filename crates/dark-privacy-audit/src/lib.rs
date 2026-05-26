use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditTrail {
    pub trail_id: [u8; 32],
    pub head: [u8; 32],
    pub event_count: u32,
    pub auditor_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEvent {
    pub event_id: [u8; 32],
    pub prev_head: [u8; 32],
    pub event_hash: [u8; 32],
    pub seq: u32,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum AuditError {
    ZeroAuditorSecret,
    EmptyEvent,
    TrailTampered,
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

pub fn new_trail(auditor_secret: &[u8; 32], nonce: &[u8; 32]) -> Result<AuditTrail, AuditError> {
    if auditor_secret == &[0u8; 32] {
        return Err(AuditError::ZeroAuditorSecret);
    }
    let auditor_hash = sha256_multi(&[b"audit2-auditor-v1", auditor_secret]);
    let trail_id = sha256_multi(&[b"audit2-trail-v1", &auditor_hash, nonce]);
    Ok(AuditTrail {
        trail_id,
        head: trail_id, // initial head = trail_id
        event_count: 0,
        auditor_hash,
        mainnet_ready: false,
    })
}

pub fn log_event(trail: &mut AuditTrail, event_bytes: &[u8]) -> Result<AuditEvent, AuditError> {
    if event_bytes.is_empty() {
        return Err(AuditError::EmptyEvent);
    }
    let prev_head = trail.head;
    let seq = trail.event_count;
    let event_hash = sha256_multi(&[b"audit2-event-v1", event_bytes]);
    let event_id = sha256_multi(&[
        b"audit2-link-v1",
        &prev_head,
        &event_hash,
        &seq.to_le_bytes(),
    ]);
    trail.head = event_id;
    trail.event_count += 1;
    Ok(AuditEvent {
        event_id,
        prev_head,
        event_hash,
        seq,
        mainnet_ready: false,
    })
}

pub fn verify_trail(trail: &AuditTrail, events: &[AuditEvent]) -> bool {
    let mut head = trail.trail_id;
    for (i, event) in events.iter().enumerate() {
        if event.seq != i as u32 {
            return false;
        }
        if event.prev_head != head {
            return false;
        }
        let expected_id = sha256_multi(&[
            b"audit2-link-v1",
            &event.prev_head,
            &event.event_hash,
            &event.seq.to_le_bytes(),
        ]);
        if expected_id != event.event_id {
            return false;
        }
        head = event.event_id;
    }
    head == trail.head
}

pub fn trail_public_record(trail: &AuditTrail) -> String {
    serde_json::json!({
        "trail_id": hex32(&trail.trail_id),
        "head": hex32(&trail.head),
        "event_count": trail.event_count,
        "mainnet_ready": trail.mainnet_ready,
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
        let mut s = [0u8; 32];
        s[0] = b;
        s
    }

    // Test 1: new + log 3 events + verify
    #[test]
    fn test_new_log_verify() {
        let mut trail = new_trail(&secret(0x11), &nonce(0xAA)).unwrap();
        assert!(!trail.mainnet_ready);
        let e1 = log_event(&mut trail, b"event-one").unwrap();
        let e2 = log_event(&mut trail, b"event-two").unwrap();
        let e3 = log_event(&mut trail, b"event-three").unwrap();
        assert_eq!(trail.event_count, 3);
        assert!(verify_trail(&trail, &[e1, e2, e3]));
    }

    // Test 2: trail head advances after each event
    #[test]
    fn test_head_advances() {
        let mut trail = new_trail(&secret(0x22), &nonce(0xBB)).unwrap();
        let initial_head = trail.head;
        log_event(&mut trail, b"first-event").unwrap();
        let head_after_1 = trail.head;
        log_event(&mut trail, b"second-event").unwrap();
        let head_after_2 = trail.head;
        assert_ne!(initial_head, head_after_1);
        assert_ne!(head_after_1, head_after_2);
        assert_ne!(initial_head, head_after_2);
    }

    // Test 3: tampered event breaks verify
    #[test]
    fn test_tampered_event_breaks_verify() {
        let mut trail = new_trail(&secret(0x33), &nonce(0xCC)).unwrap();
        let e1 = log_event(&mut trail, b"real-event").unwrap();
        let mut e1_tampered = e1.clone();
        e1_tampered.event_hash = [0xDEu8; 32]; // tamper
        assert!(!verify_trail(&trail, &[e1_tampered]));
    }

    // Test 4: zero auditor rejected
    #[test]
    fn test_zero_auditor_rejected() {
        let zero = [0u8; 32];
        let err = new_trail(&zero, &nonce(0xDD)).unwrap_err();
        assert_eq!(err, AuditError::ZeroAuditorSecret);
    }

    // Test 5: empty event rejected
    #[test]
    fn test_empty_event_rejected() {
        let mut trail = new_trail(&secret(0x44), &nonce(0xEE)).unwrap();
        let err = log_event(&mut trail, b"").unwrap_err();
        assert_eq!(err, AuditError::EmptyEvent);
    }

    // Test 6: public record hides auditor
    #[test]
    fn test_public_record_hides_auditor() {
        let auditor_secret = secret(0x55);
        let trail = new_trail(&auditor_secret, &nonce(0xFF)).unwrap();
        let record = trail_public_record(&trail);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["trail_id"].is_string());
        assert!(v["head"].is_string());
        assert_eq!(v["event_count"], 0);
        assert_eq!(v["mainnet_ready"], false);
        // auditor_hash must not appear in public record
        let ah_hex = hex32(&trail.auditor_hash);
        assert!(!record.contains(&ah_hex));
    }
}
